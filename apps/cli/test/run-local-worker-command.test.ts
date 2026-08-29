/** Resource ownership around one raw run that needs a local LiveKit worker. */

import { describe, expect, it } from "vitest";

import {
  runWithOptionalLocalLiveKitWorker,
  type RunWithOptionalLocalLiveKitWorkerOptions,
} from "../src/commands/run-local-worker.ts";
import type {
  LocalLiveKitWorkerEnding,
  StartLocalLiveKitWorker,
  StartLocalLiveKitWorkerOptions,
} from "../src/livekit/local-worker.ts";

function options(
  overrides: Partial<RunWithOptionalLocalLiveKitWorkerOptions> = {},
): { readonly value: RunWithOptionalLocalLiveKitWorkerOptions; readonly lines: string[] } {
  const lines: string[] = [];
  return {
    value: {
      cwd: "/repository",
      workerEntrypoint: null,
      workerDependencyManifest: null,
      workerDispatchName: null,
      noFollow: false,
      signal: new AbortController().signal,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      env: {},
      ...overrides,
    },
    lines,
  };
}

function controlledWorker(): {
  readonly start: StartLocalLiveKitWorker;
  readonly startedWith: () => StartLocalLiveKitWorkerOptions | null;
  readonly stopCount: () => number;
  end(ending: LocalLiveKitWorkerEnding): void;
} {
  let received: StartLocalLiveKitWorkerOptions | null = null;
  let stops = 0;
  let settle!: (ending: LocalLiveKitWorkerEnding) => void;
  const ended = new Promise<LocalLiveKitWorkerEnding>((resolve) => {
    settle = resolve;
  });
  const start: StartLocalLiveKitWorker = async (given) => {
    received = given;
    return {
      kind: "started",
      worker: {
        ended,
        stop: async () => {
          stops += 1;
          settle({ kind: "stopped" });
        },
      },
    };
  };
  return {
    start,
    startedWith: () => received,
    stopCount: () => stops,
    end: settle,
  };
}

describe("runWithOptionalLocalLiveKitWorker", () => {
  it("leaves an ordinary raw run unchanged when no worker flags were given", async () => {
    const made = options();
    let runs = 0;

    const code = await runWithOptionalLocalLiveKitWorker(made.value, async (signal) => {
      runs += 1;
      expect(signal).toBe(made.value.signal);
      return 5;
    });

    expect(code).toBe(5);
    expect(runs).toBe(1);
    expect(made.lines).toEqual([]);
  });

  it("requires the complete worker flag set and a followed run", async () => {
    const partial = options({ workerEntrypoint: "agent.py" });
    let runs = 0;
    const partialCode = await runWithOptionalLocalLiveKitWorker(
      partial.value,
      async () => {
        runs += 1;
        return 0;
      },
    );

    expect(partialCode).toBe(1);
    expect(runs).toBe(0);
    expect(partial.lines).toContain("status: invalid-worker-options");
    expect(partial.lines.join("\n")).toContain(
      "--worker-entrypoint, --worker-dependency-manifest, and --worker-dispatch-name",
    );

    const detached = options({
      workerEntrypoint: "agent.py",
      workerDependencyManifest: "requirements.txt",
      workerDispatchName: "front-desk",
      noFollow: true,
    });
    expect(
      await runWithOptionalLocalLiveKitWorker(detached.value, async () => 0),
    ).toBe(1);
    expect(detached.lines.join("\n")).toContain("cannot be used with --no-follow");
  });

  it("reads all LiveKit credentials only from env and always stops after the run", async () => {
    const worker = controlledWorker();
    const made = options({
      workerEntrypoint: "src/agent.py",
      workerDependencyManifest: "pyproject.toml",
      workerDispatchName: "front-desk",
      env: {
        LIVEKIT_URL: "wss://project.livekit.cloud",
        LIVEKIT_API_KEY: "environment-api-key",
        LIVEKIT_API_SECRET: "environment-api-secret",
      },
      startWorker: worker.start,
    });

    const code = await runWithOptionalLocalLiveKitWorker(made.value, async () => 0);

    expect(code).toBe(0);
    expect(worker.stopCount()).toBe(1);
    const started = worker.startedWith();
    expect(started).not.toBeNull();
    expect(started).toMatchObject({
      cwd: "/repository",
      url: "wss://project.livekit.cloud",
      entrypoint: "src/agent.py",
      dependencyManifest: "pyproject.toml",
      dispatchName: "front-desk",
    });
    expect(started?.credentials.reveal()).toEqual({
      apiKey: "environment-api-key",
      apiSecret: "environment-api-secret",
    });
    expect(made.lines).toContain("worker-status: ready");
    expect(made.lines).toContain("worker-status: stopped");
    expect(made.lines.join("\n")).not.toContain("environment-api-key");
    expect(made.lines.join("\n")).not.toContain("environment-api-secret");
  });

  it("stops the worker when the raw run throws", async () => {
    const worker = controlledWorker();
    const made = options({
      workerEntrypoint: "agent.py",
      workerDependencyManifest: "requirements.txt",
      workerDispatchName: "front-desk",
      env: {
        LIVEKIT_URL: "wss://project.livekit.cloud",
        LIVEKIT_API_KEY: "key",
        LIVEKIT_API_SECRET: "secret",
      },
      startWorker: worker.start,
    });

    await expect(
      runWithOptionalLocalLiveKitWorker(made.value, async () => {
        throw new Error("run failed outside its normal result contract");
      }),
    ).rejects.toThrow("run failed outside its normal result contract");
    expect(worker.stopCount()).toBe(1);
  });

  it("aborts the run and reports an unexpected worker exit", async () => {
    const worker = controlledWorker();
    const made = options({
      workerEntrypoint: "agent.py",
      workerDependencyManifest: "requirements.txt",
      workerDispatchName: "front-desk",
      env: {
        LIVEKIT_URL: "wss://project.livekit.cloud",
        LIVEKIT_API_KEY: "key",
        LIVEKIT_API_SECRET: "secret",
      },
      startWorker: worker.start,
    });
    const running = runWithOptionalLocalLiveKitWorker(made.value, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return 130;
    });
    await Promise.resolve();
    worker.end({ kind: "failed", reason: "The worker process exited." });

    await expect(running).resolves.toBe(6);
    expect(worker.stopCount()).toBe(1);
    expect(made.lines).toContain("status: worker-failed");
    expect(made.lines).toContain("reason: The worker process exited.");
    expect(made.lines).toContain("stderr: The worker process exited.");
  });

  it("refuses missing environment names without revealing any values", async () => {
    const made = options({
      workerEntrypoint: "agent.py",
      workerDependencyManifest: "requirements.txt",
      workerDispatchName: "front-desk",
      env: { LIVEKIT_API_KEY: "held-key" },
    });

    const code = await runWithOptionalLocalLiveKitWorker(made.value, async () => 0);

    expect(code).toBe(1);
    expect(made.lines).toContain("status: missing-worker-environment");
    expect(made.lines).toContain("missing: LIVEKIT_URL");
    expect(made.lines).toContain("missing: LIVEKIT_API_SECRET");
    expect(made.lines.join("\n")).not.toContain("held-key");
  });
});
