/**
 * A Cloudflare quick tunnel, run as a `cloudflared` child process.
 *
 * `cloudflared tunnel --no-autoupdate --url <target>` asks trycloudflare.com
 * for a random `https://<words>.trycloudflare.com` address, then connects to
 * Cloudflare's edge. Both facts arrive only as log lines, so this module reads
 * the child's output: the address line, the metrics-server line, and the first
 * "Registered tunnel connection" line.
 *
 * The new hostname reaches trycloudflare.com's authoritative DNS a few seconds
 * after that line, and the zone caches a miss for 30 minutes. A resolver that
 * asks too early keeps failing that long, so a tunnel is handed out only once
 * every authoritative server answers for its hostname.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { promises as dnsPromises, Resolver } from "node:dns";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** What `egma agent dev` says when cloudflared is not on PATH. */
export const CLOUDFLARED_MISSING =
  "egma agent dev needs cloudflared. Install it with brew install cloudflared, or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/** How many of cloudflared's last lines a failure shows. */
const KEPT_LINES = 12;

const TUNNEL_ADDRESS = /https:\/\/((?:[a-z0-9]+-)+[a-z0-9]+)\.trycloudflare\.com(?![a-z0-9.-])/iu;
const METRICS_ADDRESS = /metrics server on (127\.0\.0\.1:\d+|\[::1\]:\d+|localhost:\d+)\/metrics/iu;
const REGISTERED = /Registered tunnel connection/u;
// Colour codes, in case cloudflared decides the pipe is a terminal.
const ESCAPES = /\u001b\[[0-9;]*m/gu;

/** The quick-tunnel address a cloudflared log line names, or null. */
export function tunnelAddressIn(line: string): string | null {
  const found = TUNNEL_ADDRESS.exec(line);
  return found === null ? null : `https://${(found[1] as string).toLowerCase()}.trycloudflare.com`;
}

/** The metrics server's `host:port` a cloudflared log line names, or null. */
export function metricsAddressIn(line: string): string | null {
  return METRICS_ADDRESS.exec(line)?.[1] ?? null;
}

/** Whether a cloudflared log line says an edge connection is up. */
export function saysRegistered(line: string): boolean {
  return REGISTERED.test(line);
}

/** The executable's full path when some directory on PATH holds it. */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const directories = (env["PATH"] ?? env["Path"] ?? "")
    .split(path.delimiter)
    .filter((directory) => directory !== "");
  const extensions =
    platform === "win32"
      ? ["", ...(env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter((one) => one !== "")]
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        const found = await stat(candidate);
        if (!found.isFile()) continue;
        if (platform !== "win32") await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export type TunnelExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** cloudflared's last log lines, for a message that says why. */
  readonly lastLines: readonly string[];
};

export type RunningTunnel = {
  /** `https://<words>.trycloudflare.com`, fixed for this process's life. */
  readonly url: string;
  /**
   * False when the hostname was not yet in public DNS when the wait ended;
   * absent when nothing checked.
   */
  readonly inPublicDns?: boolean;
  /** Settles when the process ends, for any reason. */
  readonly exited: Promise<TunnelExit>;
  /**
   * Whether cloudflared holds at least one edge connection now, read from its
   * metrics server's /ready. `undefined` when that cannot be known.
   */
  connected(): Promise<boolean | undefined>;
  /** End the process: SIGTERM, then SIGKILL if it outlives the wait. */
  stop(): Promise<void>;
};

export type TunnelStart = {
  /** The local address the tunnel forwards to. */
  readonly target: string;
  /** Aborting it while the tunnel starts ends the process and rejects. */
  readonly signal: AbortSignal;
};

export type TunnelLauncher = (start: TunnelStart) => Promise<RunningTunnel>;

/** A tunnel that did not start, with what cloudflared said last. */
export class TunnelStartFailure extends Error {
  readonly lastLines: readonly string[];

  constructor(message: string, lastLines: readonly string[]) {
    super(message);
    this.name = "TunnelStartFailure";
    this.lastLines = lastLines;
  }
}

export type CloudflaredOptions = {
  /** How long cloudflared may take to print its address. */
  readonly addressTimeoutMs?: number;
  /** How long, after the address, it may take to connect to the edge. */
  readonly connectTimeoutMs?: number;
  /** How long `stop()` waits after SIGTERM before SIGKILL. */
  readonly stopTimeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
  readonly fetchImpl?: typeof fetch;
  /** Waits until the hostname is in public DNS. Default: ask the authoritative servers. */
  readonly waitForDns?: (hostname: string, signal: AbortSignal) => Promise<boolean>;
};

/** How long a new hostname may take to reach every authoritative server. */
const DNS_WAIT_MS = 30_000;
/** Extra time after the last authoritative answer, for other points of presence. */
const DNS_SETTLE_MS = 2_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function answersFrom(server: string, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const resolver = new Resolver({ timeout: 1_500, tries: 1 });
    resolver.setServers([server]);
    resolver.resolve4(hostname, (error, addresses) => resolve(error === null && addresses.length > 0));
  });
}

/**
 * Wait until every authoritative server of the hostname's zone answers for it.
 * Only authoritative servers are asked, so no caching resolver learns a miss.
 * Without them (no network to find them), wait a fixed time instead.
 */
export async function waitUntilInPublicDns(hostname: string, signal: AbortSignal): Promise<boolean> {
  const zone = hostname.split(".").slice(-2).join(".");
  let servers: string[] = [];
  try {
    const names = await dnsPromises.resolveNs(zone);
    for (const name of names) servers.push(...(await dnsPromises.resolve4(name)));
  } catch {
    servers = [];
  }
  if (servers.length === 0) {
    await pause(10_000, signal);
    return false;
  }
  const until = Date.now() + DNS_WAIT_MS;
  while (!signal.aborted && Date.now() < until) {
    const answers = await Promise.all(servers.map((server) => answersFrom(server, hostname)));
    if (answers.every(Boolean)) {
      await pause(DNS_SETTLE_MS, signal);
      return true;
    }
    await pause(250, signal);
  }
  return false;
}

/** Children still running, killed outright if this process exits first. */
const living = new Set<ChildProcess>();
let exitHookInstalled = false;

function killLivingChildren(): void {
  for (const child of living) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function watch(child: ChildProcess): void {
  living.add(child);
  child.once("close", () => living.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", killLivingChildren);
  }
}

function exitWords(exit: Pick<TunnelExit, "code" | "signal">): string {
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return `exit code ${String(exit.code)}`;
}

/** Launch quick tunnels with the cloudflared executable at this path. */
export function cloudflaredLauncher(
  executable: string,
  options: CloudflaredOptions = {},
): TunnelLauncher {
  const addressTimeoutMs = options.addressTimeoutMs ?? 30_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const waitForDns = options.waitForDns ?? waitUntilInPublicDns;

  return (start) =>
    new Promise<RunningTunnel>((resolve, reject) => {
      if (start.signal.aborted) {
        reject(new TunnelStartFailure("The tunnel was not opened: the command was stopped.", []));
        return;
      }

      const lastLines: string[] = [];
      let address: string | null = null;
      let metrics: string | null = null;
      let settled = false;
      let exit: TunnelExit | null = null;
      let timer: NodeJS.Timeout | undefined;

      const child = spawnImpl(executable, ["tunnel", "--no-autoupdate", "--url", start.target], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      watch(child);

      let markExited: (value: TunnelExit) => void = () => undefined;
      const exited = new Promise<TunnelExit>((done) => {
        markExited = done;
      });

      const stop = async (): Promise<void> => {
        if (exit !== null) return;
        const ended = exited.then(() => true);
        child.kill("SIGTERM");
        const inTime = await Promise.race([
          ended,
          new Promise<false>((done) => setTimeout(() => done(false), stopTimeoutMs).unref()),
        ]);
        if (inTime || exit !== null) return;
        child.kill("SIGKILL");
        await Promise.race([
          ended,
          new Promise<void>((done) => setTimeout(done, 2_000).unref()),
        ]);
      };

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        start.signal.removeEventListener("abort", onAbort);
        void stop();
        reject(new TunnelStartFailure(message, [...lastLines]));
      };

      let registered = false;
      const succeed = async (url: string): Promise<void> => {
        if (settled || registered) return;
        registered = true;
        clearTimeout(timer);
        const inPublicDns = await waitForDns(new URL(url).hostname, start.signal);
        if (settled) return;
        if (start.signal.aborted) {
          onAbort();
          return;
        }
        if (exit !== null) {
          fail(`cloudflared stopped before the tunnel was ready (${exitWords(exit)}).`);
          return;
        }
        settled = true;
        start.signal.removeEventListener("abort", onAbort);
        resolve({
          url,
          inPublicDns,
          exited,
          stop,
          async connected() {
            if (metrics === null || exit !== null) return exit === null ? undefined : false;
            try {
              const answer = await fetchImpl(`http://${metrics}/ready`, {
                signal: AbortSignal.timeout(3_000),
              });
              if (answer.status === 503) return false;
              if (!answer.ok) return undefined;
              const body = (await answer.json()) as { readyConnections?: unknown };
              return typeof body.readyConnections === "number"
                ? body.readyConnections > 0
                : undefined;
            } catch {
              return false;
            }
          },
        });
      };

      const onAbort = (): void => fail("The tunnel was not opened: the command was stopped.");
      start.signal.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(
        () =>
          fail(
            `cloudflared did not print a trycloudflare.com address within ${String(Math.round(addressTimeoutMs / 1000))} seconds.`,
          ),
        addressTimeoutMs,
      );

      const read = (line: string): void => {
        const clean = line.replace(ESCAPES, "").trimEnd();
        if (clean.trim() === "") return;
        lastLines.push(clean);
        if (lastLines.length > KEPT_LINES) lastLines.shift();
        metrics ??= metricsAddressIn(clean);
        if (address === null) {
          address = tunnelAddressIn(clean);
          if (address !== null && !settled) {
            clearTimeout(timer);
            timer = setTimeout(
              () =>
                fail(
                  `cloudflared made the address ${String(address)} but did not connect to Cloudflare within ${String(Math.round(connectTimeoutMs / 1000))} seconds.`,
                ),
              connectTimeoutMs,
            );
          }
          return;
        }
        if (saysRegistered(clean)) void succeed(address);
      };

      for (const stream of [child.stdout, child.stderr]) {
        if (stream === null) continue;
        stream.setEncoding("utf8");
        let partial = "";
        stream.on("data", (chunk: string) => {
          partial += chunk;
          const lines = partial.split(/\r?\n/u);
          partial = lines.pop() ?? "";
          for (const line of lines) read(line);
        });
        stream.on("end", () => {
          if (partial !== "") read(partial);
          partial = "";
        });
      }

      child.once("error", (error: NodeJS.ErrnoException) => {
        exit ??= { code: null, signal: null, lastLines: [...lastLines] };
        markExited(exit);
        fail(
          error.code === "ENOENT"
            ? CLOUDFLARED_MISSING
            : `cloudflared could not start: ${error.message}`,
        );
      });

      // "close" comes after the output streams end, so the last lines are read.
      child.once("close", (code, signal) => {
        exit = { code, signal, lastLines: [...lastLines] };
        markExited(exit);
        fail(`cloudflared stopped before the tunnel was ready (${exitWords(exit)}).`);
      });
    });
}

/** How a tunnel's end reads in one clause. */
export function tunnelExitWords(exit: TunnelExit): string {
  return exitWords(exit);
}
