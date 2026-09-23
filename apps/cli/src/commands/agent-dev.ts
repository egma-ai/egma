/**
 * `egma agent dev`: reach a Pipecat bot on this computer without a deploy.
 *
 * One session runs a guard on 127.0.0.1 in front of the bot's local starter,
 * opens a Cloudflare quick tunnel to the guard, and writes the tunnel's start
 * URL and a new secret header into this machine's two self-hosted connections
 * (voice and chat). The first session on a machine creates them; every later
 * session updates the same two. Which connections are this machine's is kept
 * on this machine only; the repository's egma/config.yaml is never written.
 * The command runs until Ctrl-C.
 *
 * While it runs, a tunnel that ends or loses Cloudflare for several minutes is
 * replaced, and the new start URL is written into the same connections, so a
 * simulation always reads the current address when it starts.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { hostname as systemHostname } from "node:os";
import process from "node:process";

import { DEV_SECRET_HEADER, startGuard, type Guard, type GuardEvent } from "../dev/guard.ts";
import {
  machineConnectionFor,
  machineConnectionsFileIn,
  readMachineConnections,
  rememberMachineConnections,
  type DevModality,
  type MachineConnection,
} from "../dev/machine-connections.ts";
import { holdSessionLock, type HeldSession } from "../dev/session-lock.ts";
import {
  CLOUDFLARED_MISSING,
  cloudflaredLauncher,
  findExecutable,
  TunnelStartFailure,
  tunnelExitWords,
  writeQuickTunnelConfig,
  type RunningTunnel,
  type TunnelLauncher,
} from "../dev/tunnel.ts";
import { AGENT_PLATFORM_LABELS } from "../platform/agent-platforms.ts";
import {
  addConnection,
  readAgent,
  updateConnection,
  type RegisteredConnection,
} from "../platform/agents.ts";
import { ConnectionCredentials } from "../platform/connection-credentials.ts";
import { egmaFolderIn, type PlatformAccess } from "../platform/credentials.ts";
import type { Fetch } from "../platform/device-flow.ts";
import { normalizePlatformOrigin } from "../platform/url.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { prepare, type Ready } from "./agent.ts";

export const AGENT_DEV_EXIT = {
  done: 0,
  failed: 1,
  interrupted: 130,
} as const;

const MODALITIES: readonly DevModality[] = ["voice", "chat"];

/** How many numbered names are tried after `dev-<host>-<modality>` is taken. */
const MOST_NAME_TRIES = 20;

export type Supervision = {
  /** How often cloudflared's edge connection is read. */
  readonly checkEveryMs?: number;
  /** How long it may stay without one before the tunnel is replaced. */
  readonly replaceAfterMs?: number;
  /** Waits between failed attempts to open a replacement tunnel. */
  readonly retryDelaysMs?: readonly number[];
  /** How long an exit waits for a Ctrl-C that the same keypress sent. */
  readonly exitGraceMs?: number;
};

export type AgentDevCommandOptions = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Aborted by Ctrl-C; the session then closes the tunnel and the guard. */
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: Fetch;
  readonly agentId: string | null;
  readonly port: string | null;
  /** Where cloudflared is. Default: the first one on PATH. */
  readonly findCloudflared?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** How tunnels are opened. Default: the cloudflared that was found. */
  readonly launchTunnel?: TunnelLauncher;
  /** This machine's name, as connection names carry it. Default: the OS's. */
  readonly hostname?: string;
  readonly supervision?: Supervision;
};

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** `--port` as a TCP port, or null. */
function portFrom(value: string | null): number | null {
  const text = clean(value);
  if (!/^\d{1,5}$/u.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** The machine part of a connection name: lowercase, `[a-z0-9-]`, 40 at most. */
export function machineNameOf(hostname: string): string {
  const name = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/gu, "");
  return name === "" ? "machine" : name;
}

/** Whether something accepts a TCP connection on 127.0.0.1:<port>. */
function somethingListensOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Resolves once cloudflared has had no edge connection for `forMs`. */
function whenDisconnected(
  tunnel: RunningTunnel,
  everyMs: number,
  forMs: number,
  stop: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let downSince: number | null = null;
    let timer: NodeJS.Timeout | undefined;
    const tick = async (): Promise<void> => {
      if (stop.aborted) return;
      const connected = await tunnel.connected().catch(() => undefined);
      if (stop.aborted) return;
      if (connected === false) {
        downSince ??= Date.now();
        if (Date.now() - downSince >= forMs) {
          resolve();
          return;
        }
      } else {
        downSince = null;
      }
      timer = setTimeout(() => void tick(), everyMs);
    };
    timer = setTimeout(() => void tick(), everyMs);
    stop.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
}

type Session = {
  readonly ready: Ready;
  readonly agentId: string;
  readonly platformUrl: string;
  readonly port: number;
  readonly file: string;
  readonly machine: string;
  readonly credentials: ConnectionCredentials;
  readonly options: AgentDevCommandOptions;
  /** The guard's local address, where every tunnel of this session points. */
  readonly guardUrl: string;
  readonly launch: TunnelLauncher;
};

type WrittenConnection = {
  readonly connection: RegisteredConnection;
  readonly action: "created" | "updated";
};

type Written =
  | { readonly kind: "written"; readonly connections: readonly WrittenConnection[] }
  | { readonly kind: "failed"; readonly message: string };

function requestFailureWords(result: { readonly kind: string; readonly reason: string }): string {
  return result.kind === "not-authenticated"
    ? `${result.reason} Egma did not accept this login. Run egma login, then try again.`
    : result.reason;
}

/** Add `dev-<machine>-<modality>`, numbering the name while it is taken. */
async function createMachineConnection(
  session: Session,
  modality: DevModality,
  startUrl: string,
): Promise<RegisteredConnection | { readonly message: string }> {
  const stem = `dev-${session.machine}-${modality}`;
  for (let attempt = 1; attempt <= MOST_NAME_TRIES; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${String(attempt)}`;
    const added = await addConnection(
      session.agentId,
      session.ready.project.id,
      {
        name,
        agentPlatform: "pipecat",
        connectionType: "daily_room",
        accessVariant: "daily_room.self_hosted",
        modality,
        config: { startUrl },
        credentials: session.credentials,
      },
      session.ready.request,
    );
    if (added.kind === "added") return added.connection;
    if (added.kind === "name-taken") continue;
    if (added.kind === "not-found") {
      return {
        message: `Egma does not have Agent ${session.agentId}. Run egma pull and choose an Agent ID that still exists.`,
      };
    }
    return { message: `Egma did not add this machine's ${modality} Connection: ${requestFailureWords(added)}` };
  }
  return {
    message: `Every name from ${stem} to ${stem}-${String(MOST_NAME_TRIES)} is taken on Agent ${session.agentId}. Archive the Connections you no longer use, then run egma agent dev again.`,
  };
}

/**
 * Point this machine's voice and chat connections at a start URL: update the
 * remembered ones that still live, create the rest, and remember new ids.
 */
async function writeMachineConnections(session: Session, startUrl: string): Promise<Written> {
  const { options } = session;
  const read = await readAgent(session.agentId, session.ready.project.id, session.ready.request);
  if (read.kind === "not-found") {
    return {
      kind: "failed",
      message: `Egma does not have Agent ${session.agentId}. Run egma pull and choose an Agent ID that still exists.`,
    };
  }
  if (read.kind !== "agent") return { kind: "failed", message: requestFailureWords(read) };

  let remembered: readonly MachineConnection[];
  try {
    remembered = await readMachineConnections(session.file);
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }

  const written: WrittenConnection[] = [];
  for (const modality of MODALITIES) {
    const id = machineConnectionFor(remembered, {
      platformUrl: session.platformUrl,
      agentId: session.agentId,
      modality,
    });
    const living =
      id === null
        ? undefined
        : read.connections.find(
            (connection) =>
              connection.id === id &&
              connection.connectionType === "daily_room" &&
              connection.accessVariant === "daily_room.self_hosted" &&
              connection.modality === modality,
          );
    if (living !== undefined) {
      const updated = await updateConnection(
        session.agentId,
        living.id,
        session.ready.project.id,
        { config: { startUrl }, credentials: session.credentials },
        session.ready.request,
      );
      if (updated.kind === "updated" && !updated.archived) {
        written.push({ connection: updated.connection, action: "updated" });
        continue;
      }
      if (updated.kind !== "updated" && updated.kind !== "not-found") {
        return {
          kind: "failed",
          message: `Egma did not update Connection ${living.id}: ${requestFailureWords(updated)}`,
        };
      }
    }
    const created = await createMachineConnection(session, modality, startUrl);
    if ("message" in created) return { kind: "failed", message: created.message };
    // Remembered at once, so a later failure in this pass cannot orphan it.
    try {
      await rememberMachineConnections(session.file, [
        {
          platformUrl: session.platformUrl,
          agentId: session.agentId,
          modality,
          connectionId: created.id,
        },
      ]);
    } catch (cause) {
      options.fail(
        `Egma could not remember Connection ${created.id} in ${session.file}: ${cause instanceof Error ? cause.message : String(cause)}. The next egma agent dev creates a new one.`,
      );
    }
    written.push({ connection: created, action: "created" });
  }
  return { kind: "written", connections: written };
}

function sayWritten(session: Session, written: readonly WrittenConnection[]): void {
  for (const { connection, action } of written) {
    const name = JSON.stringify(oneLineFactText(connection.name, "unnamed"));
    session.options.out(
      action === "created"
        ? `Created Connection ${name} (${connection.id}) for ${connection.modality} simulations.`
        : `Updated Connection ${name} (${connection.id}) for ${connection.modality} simulations.`,
    );
  }
}

function sayGuardEvent(port: number, out: (line: string) => void): (event: GuardEvent) => void {
  return (event) => {
    const request = `${event.method} ${oneLineFactText(event.path, "/")}`;
    if (event.kind === "forwarded") {
      out(`${request}: ${String(event.status)}`);
    } else if (event.kind === "refused") {
      out(`${request}: refused, the ${DEV_SECRET_HEADER} header was missing or wrong.`);
    } else {
      out(
        `${request}: 502, egma agent dev could not reach port ${String(port)}: ${event.cause}. Start your bot's development runner (for example python bot.py -t daily).`,
      );
    }
  };
}

function sayDnsLag(options: AgentDevCommandOptions, tunnel: RunningTunnel): void {
  if (tunnel.inPublicDns === false) {
    options.fail(
      "The tunnel's address is not in public DNS yet. A simulation that starts in the next few minutes can fail to reach it.",
    );
  }
}

function sayTunnelFailure(options: AgentDevCommandOptions, failure: unknown): void {
  if (failure instanceof TunnelStartFailure) {
    options.fail(failure.message);
    if (failure.lastLines.length > 0) {
      options.fail("cloudflared said:");
      for (const line of failure.lastLines) options.fail(`  ${line}`);
    }
    return;
  }
  options.fail(`The tunnel did not open: ${failure instanceof Error ? failure.message : String(failure)}`);
}

/**
 * Keep the session's tunnel alive until Ctrl-C. Returns the exit code.
 *
 * A tunnel that ends, or that has no edge connection for `replaceAfterMs`, is
 * replaced; the connections are then pointed at the new start URL.
 */
async function supervise(
  session: Session,
  first: RunningTunnel,
  holder: { tunnel: RunningTunnel | null },
): Promise<number> {
  const { options } = session;
  const supervision = options.supervision ?? {};
  const checkEveryMs = supervision.checkEveryMs ?? 30_000;
  const replaceAfterMs = supervision.replaceAfterMs ?? 180_000;
  const retryDelaysMs = supervision.retryDelaysMs ?? [2_000, 5_000, 10_000, 30_000, 60_000];
  const exitGraceMs = supervision.exitGraceMs ?? 500;
  let tunnel = first;

  for (;;) {
    const round = new AbortController();
    const outcome = await Promise.race([
      whenAborted(options.signal).then(() => ({ kind: "stop" as const })),
      tunnel.exited.then((exit) => ({ kind: "exited" as const, exit })),
      whenDisconnected(tunnel, checkEveryMs, replaceAfterMs, round.signal).then(() => ({
        kind: "disconnected" as const,
      })),
    ]);
    round.abort();
    if (outcome.kind === "stop") return AGENT_DEV_EXIT.done;

    if (outcome.kind === "exited") {
      // A Ctrl-C reaches cloudflared too, and its exit can arrive first.
      await delay(exitGraceMs, options.signal);
      if (options.signal.aborted) return AGENT_DEV_EXIT.done;
      options.fail(
        `cloudflared stopped (${tunnelExitWords(outcome.exit)}). Opening a new tunnel; a simulation that starts meanwhile fails.`,
      );
    } else {
      options.fail(
        `cloudflared has had no connection to Cloudflare for ${String(Math.round(replaceAfterMs / 60_000))} minutes. Opening a new tunnel.`,
      );
      await tunnel.stop();
    }
    holder.tunnel = null;

    // Open a replacement, waiting longer after each failure, until Ctrl-C.
    let replacement: RunningTunnel | null = null;
    for (let attempt = 0; replacement === null; attempt += 1) {
      if (options.signal.aborted) return AGENT_DEV_EXIT.done;
      try {
        replacement = await session.launch({ target: session.guardUrl, signal: options.signal });
      } catch (failure) {
        if (options.signal.aborted) return AGENT_DEV_EXIT.done;
        sayTunnelFailure(options, failure);
        const wait = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 60_000;
        options.fail(`Trying again in ${String(Math.round(wait / 1000))} seconds.`);
        await delay(wait, options.signal);
      }
    }
    tunnel = replacement;
    holder.tunnel = tunnel;
    options.out(`Tunnel: ${tunnel.url}`);
    sayDnsLag(options, tunnel);

    // Point the connections at it, retrying while Egma cannot be reached.
    const startUrl = `${tunnel.url}/start`;
    for (let attempt = 0; ; attempt += 1) {
      if (options.signal.aborted) return AGENT_DEV_EXIT.done;
      const written = await writeMachineConnections(session, startUrl);
      if (options.signal.aborted) return AGENT_DEV_EXIT.done;
      if (written.kind === "written") {
        sayWritten(session, written.connections);
        options.out(`Start URL: ${startUrl}`);
        options.out("Ready again.");
        break;
      }
      options.fail(written.message);
      const wait = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 60_000;
      options.fail(`Trying again in ${String(Math.round(wait / 1000))} seconds.`);
      await delay(wait, options.signal);
    }
  }
}

/** Run one `egma agent dev` session until Ctrl-C. */
export async function runAgentDevCommand(options: AgentDevCommandOptions): Promise<number> {
  if (options.signal.aborted) {
    options.fail("The command was stopped before anything started.");
    return AGENT_DEV_EXIT.interrupted;
  }
  const agentId = clean(options.agentId);
  if (agentId === "") {
    options.fail("Choose an Egma Agent with --agent <Agent ID>.");
    return AGENT_DEV_EXIT.failed;
  }
  const port = portFrom(options.port);
  if (port === null) {
    options.fail(
      "--port is the port your bot's development runner listens on, a number from 1 to 65535, such as 7860.",
    );
    return AGENT_DEV_EXIT.failed;
  }

  const cloudflared = await (options.findCloudflared ?? ((env) => findExecutable("cloudflared", env)))(
    options.env,
  );
  if (cloudflared === null) {
    options.fail(CLOUDFLARED_MISSING);
    return AGENT_DEV_EXIT.failed;
  }

  const ready = await prepare(options);
  if ("code" in ready) return ready.code;
  if (options.signal.aborted) return stoppedEarly(options);

  const remote = await readAgent(agentId, ready.project.id, ready.request);
  if (options.signal.aborted) return stoppedEarly(options);
  if (remote.kind === "not-found") {
    options.fail(`Egma does not have Agent ${agentId}. Run egma pull and choose an Agent ID that still exists.`);
    return AGENT_DEV_EXIT.failed;
  }
  if (remote.kind !== "agent") {
    options.fail(requestFailureWords(remote));
    return AGENT_DEV_EXIT.failed;
  }
  if (remote.agent.agentPlatform !== "pipecat") {
    options.fail(
      `egma agent dev works with Pipecat agents; ${agentId} is a ${AGENT_PLATFORM_LABELS[remote.agent.agentPlatform]} agent.`,
    );
    return AGENT_DEV_EXIT.failed;
  }

  const file = machineConnectionsFileIn(options.env);
  try {
    await readMachineConnections(file);
  } catch (cause) {
    options.fail(cause instanceof Error ? cause.message : String(cause));
    return AGENT_DEV_EXIT.failed;
  }

  const platformUrl = normalizePlatformOrigin(ready.signedIn.url);
  let held: HeldSession;
  try {
    held = await holdSessionLock(egmaFolderIn(options.env), platformUrl, agentId);
  } catch (cause) {
    options.fail(
      `Egma could not write its session lock in ${egmaFolderIn(options.env)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return AGENT_DEV_EXIT.failed;
  }
  if (held.kind === "busy") {
    options.fail(
      `egma agent dev is already running for Agent ${agentId} on this machine${held.pid === null ? "" : ` (process ${String(held.pid)})`}. Use that session, or stop it with Ctrl-C first. If none is running, delete ${held.file} and try again.`,
    );
    return AGENT_DEV_EXIT.failed;
  }
  try {
    return await runSession(options, { ready, agentId, platformUrl, port, file, cloudflared });
  } finally {
    await held.lock.release();
  }
}

/** Everything after the checks: guard, tunnel, connections, supervision. */
async function runSession(
  options: AgentDevCommandOptions,
  checked: {
    readonly ready: Ready;
    readonly agentId: string;
    readonly platformUrl: string;
    readonly port: number;
    readonly file: string;
    readonly cloudflared: string;
  },
): Promise<number> {
  const { ready, agentId, platformUrl, port, file, cloudflared } = checked;
  if (!(await somethingListensOn(port))) {
    options.fail(
      `Nothing is listening on port ${String(port)} yet. Start your bot's development runner (for example python bot.py -t daily), then run a simulation.`,
    );
  }

  let launch = options.launchTunnel;
  if (launch === undefined) {
    let configFile: string;
    try {
      configFile = await writeQuickTunnelConfig(egmaFolderIn(options.env));
    } catch (cause) {
      options.fail(
        `Egma could not write the tunnel's config in ${egmaFolderIn(options.env)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return AGENT_DEV_EXIT.failed;
    }
    launch = cloudflaredLauncher(cloudflared, { configFile });
  }

  const secret = randomBytes(32).toString("base64url");
  let guard: Guard;
  try {
    guard = await startGuard({
      secret,
      targetPort: port,
      onEvent: sayGuardEvent(port, options.out),
    });
  } catch (cause) {
    options.fail(`Egma could not start its guard on 127.0.0.1: ${cause instanceof Error ? cause.message : String(cause)}`);
    return AGENT_DEV_EXIT.failed;
  }
  const session: Session = {
    ready,
    agentId,
    platformUrl,
    port,
    file,
    machine: machineNameOf(options.hostname ?? systemHostname()),
    credentials: ConnectionCredentials.hold({
      headers: JSON.stringify({ [DEV_SECRET_HEADER]: secret }),
    }),
    options,
    guardUrl: guard.url,
    launch,
  };
  const holder: { tunnel: RunningTunnel | null } = { tunnel: null };
  let wasReady = false;
  try {
    options.out("Opening a Cloudflare quick tunnel.");
    try {
      holder.tunnel = await session.launch({ target: guard.url, signal: options.signal });
    } catch (failure) {
      if (options.signal.aborted) return stoppedEarly(options);
      sayTunnelFailure(options, failure);
      return AGENT_DEV_EXIT.failed;
    }
    const tunnel = holder.tunnel;
    options.out(`Tunnel: ${tunnel.url}`);
    sayDnsLag(options, tunnel);

    const startUrl = `${tunnel.url}/start`;
    const written = await writeMachineConnections(session, startUrl);
    // A Ctrl-C aborts the request in flight; that is not Egma failing to answer.
    if (options.signal.aborted) return stoppedEarly(options);
    if (written.kind === "failed") {
      options.fail(written.message);
      return AGENT_DEV_EXIT.failed;
    }
    sayWritten(session, written.connections);
    options.out(`Start URL: ${startUrl}`);
    options.out(`Forwarding to your bot's starter on http://127.0.0.1:${String(port)}.`);
    options.out("Ready. Run a suite on this machine with:");
    for (const { connection } of written.connections) {
      options.out(`  egma run create <suite-directory> --agent ${agentId} --connection ${connection.id}`);
    }
    options.out("Press Ctrl-C to stop.");
    wasReady = true;

    const code = await supervise(session, tunnel, holder);
    options.out("Stopping.");
    return code;
  } finally {
    await holder.tunnel?.stop();
    await guard.close();
    if (wasReady && options.signal.aborted) {
      options.out(
        "Stopped. The tunnel is closed. This machine's Connections stay; the next egma agent dev writes its new start URL into them.",
      );
    }
  }
}

function stoppedEarly(options: AgentDevCommandOptions): number {
  options.fail("The command was stopped before the tunnel was ready.");
  return AGENT_DEV_EXIT.interrupted;
}

/** Ctrl-C, a terminal hang-up or SIGTERM stops the session; a second one exits at once. */
export async function withDevSessionSignal(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let received = 0;
  const onSignal = (): void => {
    received += 1;
    if (received > 1) process.exit(AGENT_DEV_EXIT.interrupted);
    controller.abort("interrupt");
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const name of signals) process.on(name, onSignal);
  try {
    return await run(controller.signal);
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
}
