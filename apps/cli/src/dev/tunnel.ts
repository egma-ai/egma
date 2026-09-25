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
import { access, mkdir, stat, writeFile } from "node:fs/promises";
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
   * False when the authoritative servers still did not answer for the hostname
   * when the wait ended; absent when that could not be checked.
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
  /**
   * The config file cloudflared reads instead of its default one. A user's
   * `~/.cloudflared/config.yml` can hold ingress rules, which win over `--url`
   * and would send the tunnel somewhere other than the guard.
   */
  readonly configFile?: string;
  /** Waits until the hostname is in public DNS. Default: ask the authoritative servers. */
  readonly waitForDns?: (hostname: string, signal: AbortSignal) => Promise<boolean | undefined>;
};

/** The config a quick tunnel runs with: no ingress rules, so `--url` decides. */
export const QUICK_TUNNEL_CONFIG = "{}\n";

/** Write the quick-tunnel config into a folder and return its path. */
export async function writeQuickTunnelConfig(folder: string): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, "cloudflared-quick-tunnel.yml");
  await writeFile(file, QUICK_TUNNEL_CONFIG, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** What one DNS server said about a hostname. */
export type DnsAnswer = "found" | "missing" | "unreachable";

/** How the wait asks DNS; replaced in tests. */
export type PublicDnsProbe = {
  /** The zone's authoritative server addresses; empty when they cannot be found. */
  nameServers(zone: string): Promise<readonly string[]>;
  /** Ask one server, over UDP port 53, for the hostname's address. */
  ask(server: string, hostname: string): Promise<DnsAnswer>;
  /** Ask this machine's own resolver, once. */
  lookup(hostname: string): Promise<boolean>;
};

export type DnsWaitTiming = {
  /** How long the authoritative servers may take to answer for a new hostname. */
  readonly waitMs: number;
  /** Extra time after they all answer, for Cloudflare's other locations. */
  readonly settleMs: number;
  readonly everyMs: number;
  /** When they cannot be asked: how long after the start to ask this machine's resolver. */
  readonly fallbackMs: number;
};

/** A new hostname reached every authoritative server 3 to 6 seconds after cloudflared connected. */
const DNS_TIMING: DnsWaitTiming = { waitMs: 15_000, settleMs: 2_000, everyMs: 250, fallbackMs: 8_000 };

/** DNS error codes that mean the server answered: the name is not there (yet). */
const ANSWERED_WITHOUT_ADDRESS = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "EREFUSED", "ESERVFAIL", "EFORMERR"]);

const SYSTEM_DNS: PublicDnsProbe = {
  async nameServers(zone) {
    try {
      const servers: string[] = [];
      for (const name of await dnsPromises.resolveNs(zone)) {
        servers.push(...(await dnsPromises.resolve4(name)));
      }
      return servers;
    } catch {
      return [];
    }
  },
  ask(server, hostname) {
    return new Promise((resolve) => {
      const resolver = new Resolver({ timeout: 1_500, tries: 1 });
      resolver.setServers([server]);
      resolver.resolve4(hostname, (error, addresses) => {
        if (error === null) resolve(addresses.length > 0 ? "found" : "missing");
        else resolve(ANSWERED_WITHOUT_ADDRESS.has(error.code ?? "") ? "missing" : "unreachable");
      });
    });
  },
  async lookup(hostname) {
    try {
      await dnsPromises.lookup(hostname);
      return true;
    } catch {
      return false;
    }
  },
};

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
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

/**
 * Wait until every authoritative server of the hostname's zone answers for it.
 * Only authoritative servers are asked, so no caching resolver learns a miss.
 *
 * true: every one answers. false: they answer, but not for this hostname,
 * within the wait. undefined: they cannot be asked (UDP port 53 blocked); then
 * this machine's resolver is asked once, after the usual delay, and a miss
 * there stays unknown rather than alarming.
 */
export async function waitUntilInPublicDns(
  hostname: string,
  signal: AbortSignal,
  probe: PublicDnsProbe = SYSTEM_DNS,
  timing: DnsWaitTiming = DNS_TIMING,
): Promise<boolean | undefined> {
  const started = Date.now();
  const fallBack = async (): Promise<boolean | undefined> => {
    await pause(started + timing.fallbackMs - Date.now(), signal);
    if (signal.aborted) return undefined;
    return (await probe.lookup(hostname)) ? true : undefined;
  };

  const zone = hostname.split(".").slice(-2).join(".");
  const servers = await probe.nameServers(zone);
  if (servers.length === 0) return await fallBack();

  let heardBack = false;
  while (!signal.aborted && Date.now() - started < timing.waitMs) {
    const answers = await Promise.all(servers.map((server) => probe.ask(server, hostname)));
    if (answers.every((answer) => answer === "found")) {
      await pause(timing.settleMs, signal);
      return true;
    }
    heardBack ||= answers.some((answer) => answer !== "unreachable");
    if (!heardBack) return await fallBack();
    await pause(timing.everyMs, signal);
  }
  return signal.aborted ? undefined : false;
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

      const args = [
        "tunnel",
        "--no-autoupdate",
        ...(options.configFile === undefined ? [] : ["--config", options.configFile]),
        "--url",
        start.target,
      ];
      const child = spawn(executable, args, {
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
          ...(inPublicDns === undefined ? {} : { inPublicDns }),
          exited,
          stop,
          async connected() {
            if (metrics === null || exit !== null) return exit === null ? undefined : false;
            try {
              const answer = await fetch(`http://${metrics}/ready`, {
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
