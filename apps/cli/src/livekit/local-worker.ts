/**
 * Own the repository's temporary LiveKit worker for one followed run.
 *
 * The public `integrate-egma` skill ships the cross-platform helper. This
 * module supplies its secrets through the child environment, waits for its
 * explicit registration marker, relays redacted output to the caller, and
 * tears down the complete process group when the run ends.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

import type { ConnectionCredentials } from "../platform/connection-credentials.ts";
import { publicSkillDirectory } from "../skills/index.ts";

export const LIVEKIT_WORKER_READY_MARK = "egma:livekit-worker ready";

const STARTUP_TIMEOUT_MS = 180_000;
const SHUTDOWN_GRACE_MS = 5_000;

export type LocalLiveKitWorkerEnding =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: string };

export type LocalLiveKitWorker = {
  /** Settles if the helper exits before the CLI finishes the run. */
  readonly ended: Promise<LocalLiveKitWorkerEnding>;
  /** Stop the worker and every runtime process below it. Safe to call twice. */
  stop(): Promise<void>;
};

export type StartLocalLiveKitWorkerOptions = {
  readonly cwd: string;
  readonly url: string;
  readonly credentials: ConnectionCredentials;
  readonly dispatchName: string;
  readonly entrypoint: string;
  readonly dependencyManifest: string;
  readonly signal: AbortSignal;
  /** Receives helper and worker output after exact credential redaction. */
  readonly onOutput?: ((chunk: string) => void) | undefined;
  /** Test seam for the packaged helper path. */
  readonly helperFile?: string | undefined;
  /** Test seam for startup timeout. */
  readonly startupTimeoutMs?: number | undefined;
};

export type StartLocalLiveKitWorker = (
  options: StartLocalLiveKitWorkerOptions,
) => Promise<
  | { readonly kind: "started"; readonly worker: LocalLiveKitWorker }
  | { readonly kind: "failed"; readonly reason: string }
>;

/** A path-only incompatibility the local launcher can reject before setup. */
export function localLiveKitWorkerFileIssue(
  entrypoint: string,
  dependencyManifest: string,
): string | null {
  const manifest = path.normalize(dependencyManifest);
  const manifestName = path.basename(manifest).toLowerCase();
  if (manifestName !== "pyproject.toml" && manifestName !== "requirements.txt") {
    return (
      `The coding agent reported ${JSON.stringify(dependencyManifest)}, but the local ` +
      "LiveKit launcher supports only pyproject.toml or requirements.txt."
    );
  }

  const workerFromProject = path.relative(
    path.dirname(manifest),
    path.normalize(entrypoint),
  );
  if (
    workerFromProject === "" ||
    workerFromProject === ".." ||
    workerFromProject.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workerFromProject)
  ) {
    return "The dependency manifest must be in the LiveKit worker project directory.";
  }
  return null;
}

/** The Windows system command that ends one process and all descendants. */
export function windowsTreeKillArguments(
  pid: number,
  signal: NodeJS.Signals,
): readonly string[] {
  return [
    "/pid",
    String(pid),
    "/t",
    ...(signal === "SIGKILL" ? ["/f"] : []),
  ];
}

/** Whether Windows failed to end the complete tree and needs a direct-child fallback. */
export function windowsTreeKillFailed(result: {
  readonly error?: unknown;
  readonly status: number | null;
}): boolean {
  return result.error !== undefined || result.status !== 0;
}

function environmentWithoutLiveKitCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
    delete env[name];
  }
  return env;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", windowsTreeKillArguments(pid, signal), {
        env: environmentWithoutLiveKitCredentials(),
        stdio: "ignore",
        windowsHide: true,
      });
      if (windowsTreeKillFailed(result)) child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process tree already ended, which is the requested outcome.
  }
}

function redact(chunk: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length)
    .reduce(
      (held, secret) => held.replaceAll(secret, "<redacted>"),
      chunk,
    );
}

function helperInPackage(): string {
  return path.join(
    publicSkillDirectory("integrate-egma"),
    "scripts",
    "livekit-local.mjs",
  );
}

/** Start the helper and return only after it confirms worker registration. */
export const startLocalLiveKitWorker: StartLocalLiveKitWorker = async (options) => {
  const revealed = options.credentials.reveal();
  const apiKey = revealed["apiKey"] ?? "";
  const apiSecret = revealed["apiSecret"] ?? "";
  if (apiKey === "" || apiSecret === "") {
    return {
      kind: "failed",
      reason: "Egma cannot start the local LiveKit worker without an API key and secret.",
    };
  }

  const helper = options.helperFile ?? helperInPackage();
  const args = [
    helper,
    "--cwd",
    options.cwd,
    "--entrypoint",
    options.entrypoint.trim(),
    "--dependency-manifest",
    options.dependencyManifest.trim(),
    "--dispatch-name",
    options.dispatchName.trim(),
  ];

  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    env: {
      ...process.env,
      LIVEKIT_URL: options.url,
      LIVEKIT_API_KEY: apiKey,
      LIVEKIT_API_SECRET: apiSecret,
    },
  });

  let intentional = false;
  let stopped = false;
  let ready = false;
  let lastSafeLine = "";
  let stdoutBuffered = "";
  let stderrBuffered = "";
  let settleReady!: (
    result:
      | { readonly kind: "ready" }
      | { readonly kind: "failed"; readonly reason: string },
  ) => void;
  const startup = new Promise<
    | { readonly kind: "ready" }
    | { readonly kind: "failed"; readonly reason: string }
  >((resolve) => {
    settleReady = resolve;
  });

  let settleEnding!: (ending: LocalLiveKitWorkerEnding) => void;
  const ended = new Promise<LocalLiveKitWorkerEnding>((resolve) => {
    settleEnding = resolve;
  });

  const takeLine = (raw: string): void => {
    const safe = redact(raw, [apiKey, apiSecret]);
    if (safe.trim() === LIVEKIT_WORKER_READY_MARK) {
      if (!ready) {
        ready = true;
        settleReady({ kind: "ready" });
      }
      return;
    }
    if (safe.trim() !== "") lastSafeLine = safe.trim();
    options.onOutput?.(`${safe}\n`);
  };

  const take = (raw: string, stream: "stdout" | "stderr"): void => {
    const joined = (stream === "stdout" ? stdoutBuffered : stderrBuffered) + raw;
    const lines = joined.split(/\r?\n/u);
    const remainder = lines.pop() ?? "";
    if (stream === "stdout") stdoutBuffered = remainder;
    else stderrBuffered = remainder;
    for (const line of lines) {
      takeLine(line);
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => take(chunk, "stdout"));
  child.stderr?.on("data", (chunk: string) => take(chunk, "stderr"));

  child.once("error", (error) => {
    if (!ready) settleReady({ kind: "failed", reason: error.message });
  });
  child.once("close", (code, signal) => {
    if (stdoutBuffered !== "") takeLine(stdoutBuffered);
    if (stderrBuffered !== "") takeLine(stderrBuffered);
    const detail =
      signal === null
        ? `exit ${code === null ? "unknown" : String(code)}`
        : `signal ${signal}`;
    if (!ready) {
      settleReady({
        kind: "failed",
        reason:
          `The local LiveKit worker stopped before it registered (${detail}).` +
          (lastSafeLine === "" ? "" : ` ${lastSafeLine}`),
      });
    }
    settleEnding(
      intentional
        ? { kind: "stopped" }
        : {
            kind: "failed",
            reason: `The local LiveKit worker stopped before the Egma run finished (${detail}).`,
          },
    );
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    intentional = true;
    signalTree(child, "SIGTERM");
    const finished = await Promise.race([
      ended.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
        timer.unref();
      }),
    ]);
    if (!finished) {
      signalTree(child, "SIGKILL");
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          timer.unref();
        }),
      ]);
    }
  };

  const onAbort = (): void => {
    void stop();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const began = await Promise.race([
    startup,
    new Promise<{ readonly kind: "failed"; readonly reason: string }>((resolve) => {
      const timer = setTimeout(
        () =>
          resolve({
            kind: "failed",
            reason:
              "The local LiveKit worker did not register within three minutes. Check its output and run Egma again.",
          }),
        timeoutMs,
      );
      timer.unref();
      startup.finally(() => clearTimeout(timer)).catch(() => undefined);
    }),
  ]);

  options.signal.removeEventListener("abort", onAbort);
  if (began.kind === "failed" || options.signal.aborted) {
    await stop();
    return {
      kind: "failed",
      reason:
        began.kind === "failed"
          ? began.reason
          : "The local LiveKit worker was stopped before it registered.",
    };
  }

  return { kind: "started", worker: { ended, stop } };
};
