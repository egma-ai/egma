/** Own an optional repository-local LiveKit worker around one raw run. */

import process from "node:process";

import { liveKitKeyPair } from "../livekit/connect.ts";
import {
  localLiveKitWorkerFileIssue,
  startLocalLiveKitWorker,
  type StartLocalLiveKitWorker,
} from "../livekit/local-worker.ts";
import { RUN_EXIT, type PreparedRunCommand } from "./run.ts";

const WORKER_FLAGS = [
  "--worker-entrypoint",
  "--worker-dependency-manifest",
  "--worker-dispatch-name",
] as const;

const LIVEKIT_ENVIRONMENT = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

export type RunWithOptionalLocalLiveKitWorkerOptions = {
  readonly cwd: string;
  readonly workerEntrypoint: string | null;
  readonly workerDependencyManifest: string | null;
  readonly workerDispatchName: string | null;
  readonly noFollow: boolean;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  /** The only source for LiveKit connection credentials. */
  readonly env?: NodeJS.ProcessEnv;
  /** Process boundary replaced by focused command tests. */
  readonly startWorker?: StartLocalLiveKitWorker;
};

function refusal(
  options: RunWithOptionalLocalLiveKitWorkerOptions,
  status: string,
  reason: string,
  code: number = RUN_EXIT.nothing,
): number {
  options.out(`status: ${status}`);
  options.out(`reason: ${reason}`);
  options.fail(reason);
  return code;
}

/**
 * Start the worker only when the complete flag set is present, keep it alive
 * until the followed run ends, and stop its process tree on every exit path.
 */
export async function runWithOptionalLocalLiveKitWorker(
  options: RunWithOptionalLocalLiveKitWorkerOptions,
  prepare: () => Promise<PreparedRunCommand>,
): Promise<number> {
  const values = [
    options.workerEntrypoint,
    options.workerDependencyManifest,
    options.workerDispatchName,
  ] as const;
  if (values.every((value) => value === null)) {
    const prepared = await prepare();
    return prepared.kind === "stopped"
      ? prepared.code
      : await prepared.run(options.signal);
  }

  if (values.some((value) => value === null || value.trim() === "")) {
    return refusal(
      options,
      "invalid-worker-options",
      `Use ${WORKER_FLAGS[0]}, ${WORKER_FLAGS[1]}, and ${WORKER_FLAGS[2]} together, each with a nonblank value. Nothing was started.`,
    );
  }
  if (options.noFollow) {
    return refusal(
      options,
      "invalid-worker-options",
      "A CLI-owned LiveKit worker cannot be used with --no-follow because it must stay registered until the run finishes. Nothing was started.",
    );
  }

  const entrypoint = (options.workerEntrypoint as string).trim();
  const dependencyManifest = (options.workerDependencyManifest as string).trim();
  const dispatchName = (options.workerDispatchName as string).trim();
  const fileIssue = localLiveKitWorkerFileIssue(entrypoint, dependencyManifest);
  if (fileIssue !== null) {
    return refusal(options, "invalid-worker-options", `${fileIssue} Nothing was started.`);
  }

  const env = options.env ?? process.env;
  const missing = LIVEKIT_ENVIRONMENT.filter(
    (name) => env[name] === undefined || env[name]?.trim() === "",
  );
  if (missing.length > 0) {
    options.out("status: missing-worker-environment");
    for (const name of missing) options.out(`missing: ${name}`);
    const reason =
      `A CLI-owned LiveKit worker needs ${missing.join(", ")} in the environment. ` +
      "No worker or run was started.";
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return RUN_EXIT.nothing;
  }

  const prepared = await prepare();
  if (prepared.kind === "stopped") return prepared.code;

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options.signal.reason);
  if (options.signal.aborted) forwardAbort();
  else options.signal.addEventListener("abort", forwardAbort, { once: true });

  const url = env.LIVEKIT_URL as string;
  const apiKey = env.LIVEKIT_API_KEY as string;
  const apiSecret = env.LIVEKIT_API_SECRET as string;
  options.out(`worker-entrypoint: ${entrypoint}`);
  options.out(`worker-dependency-manifest: ${dependencyManifest}`);
  options.out(`worker-dispatch-name: ${dispatchName}`);
  options.out("worker-status: starting");

  const launch = options.startWorker ?? startLocalLiveKitWorker;
  let started;
  try {
    started = await launch({
      cwd: options.cwd,
      url,
      credentials: liveKitKeyPair(apiKey, apiSecret),
      dispatchName,
      entrypoint,
      dependencyManifest,
      signal: controller.signal,
      onOutput: (chunk) => {
        for (const line of chunk.split(/\r?\n/u)) {
          if (line.trim() !== "") options.out(`worker-output: ${line}`);
        }
      },
    });
  } catch (cause) {
    options.signal.removeEventListener("abort", forwardAbort);
    const reason = cause instanceof Error ? cause.message : String(cause);
    return refusal(options, "worker-start-failed", reason, RUN_EXIT.operational);
  }
  if (started.kind === "failed") {
    options.signal.removeEventListener("abort", forwardAbort);
    if (options.signal.aborted) {
      options.out("status: interrupted");
      return RUN_EXIT.interrupted;
    }
    return refusal(
      options,
      "worker-start-failed",
      started.reason,
      RUN_EXIT.operational,
    );
  }
  options.out("worker-status: ready");

  const running = Promise.resolve()
    .then(() => prepared.run(controller.signal))
    .then(
      (code) => ({ kind: "run" as const, code }),
      (cause: unknown) => ({ kind: "run-error" as const, cause }),
    );
  let cleaned = false;
  const clean = async (report: boolean): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    controller.abort("the raw run ended");
    await started.worker.stop();
    options.signal.removeEventListener("abort", forwardAbort);
    if (report) options.out("worker-status: stopped");
  };

  try {
    const completed = await Promise.race([
      running,
      started.worker.ended.then((ending) => ({
        kind: "worker" as const,
        ending,
      })),
    ]);

    if (completed.kind === "worker") {
      controller.abort("the local LiveKit worker stopped");
      await running;
      await clean(false);
      const reason =
        completed.ending.kind === "failed"
          ? completed.ending.reason
          : "The local LiveKit worker stopped before the Egma run finished.";
      return refusal(options, "worker-failed", reason, RUN_EXIT.operational);
    }

    await clean(true);
    if (completed.kind === "run-error") throw completed.cause;
    return completed.code;
  } finally {
    await clean(false);
  }
}
