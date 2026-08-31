/** Resource ownership around one raw run that needs a local LiveKit worker. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runWithOptionalLocalLiveKitWorker,
  type RunWithOptionalLocalLiveKitWorkerOptions,
} from "../src/commands/run-local-worker.ts";
import {
  prepareRunCommand,
  type PreparedRunCommand,
} from "../src/commands/run.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import type {
  LocalLiveKitWorkerEnding,
  StartLocalLiveKitWorker,
  StartLocalLiveKitWorkerOptions,
} from "../src/livekit/local-worker.ts";
import { makeWorkspace } from "./support/workspace.ts";
import { aTestFile, blocking } from "./support/test-file.ts";

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

function ready(
  run: (signal: AbortSignal) => Promise<number>,
): () => Promise<PreparedRunCommand> {
  return async () => ({ kind: "ready", run });
}

describe("runWithOptionalLocalLiveKitWorker", () => {
  it("leaves an ordinary raw run unchanged when no worker flags were given", async () => {
    const made = options();
    let runs = 0;

    const code = await runWithOptionalLocalLiveKitWorker(
      made.value,
      ready(async (signal) => {
        runs += 1;
        expect(signal).toBe(made.value.signal);
        return 5;
      }),
    );

    expect(code).toBe(5);
    expect(runs).toBe(1);
    expect(made.lines).toEqual([]);
  });

  it("requires the complete worker flag set and a followed run", async () => {
    const partial = options({ workerEntrypoint: "agent.py" });
    let runs = 0;
    const partialCode = await runWithOptionalLocalLiveKitWorker(
      partial.value,
      ready(async () => {
        runs += 1;
        return 0;
      }),
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
      await runWithOptionalLocalLiveKitWorker(
        detached.value,
        ready(async () => 0),
      ),
    ).toBe(1);
    expect(detached.lines.join("\n")).toContain("cannot be used with --no-follow");
  });

  it("reads all LiveKit credentials only from env and always stops after the run", async () => {
    const worker = controlledWorker();
    const order: string[] = [];
    const made = options({
      workerEntrypoint: "src/agent.py",
      workerDependencyManifest: "pyproject.toml",
      workerDispatchName: "front-desk",
      env: {
        LIVEKIT_URL: "wss://project.livekit.cloud",
        LIVEKIT_API_KEY: "environment-api-key",
        LIVEKIT_API_SECRET: "environment-api-secret",
      },
      startWorker: async (given) => {
        order.push("worker");
        return await worker.start(given);
      },
    });

    const code = await runWithOptionalLocalLiveKitWorker(made.value, async () => {
      order.push("prepare");
      return {
        kind: "ready",
        run: async () => {
          order.push("run");
          return 0;
        },
      };
    });

    expect(code).toBe(0);
    expect(order).toEqual(["prepare", "worker", "run"]);
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
      runWithOptionalLocalLiveKitWorker(
        made.value,
        ready(async () => {
          throw new Error("run failed outside its normal result contract");
        }),
      ),
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
    const running = runWithOptionalLocalLiveKitWorker(
      made.value,
      ready(async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        return 130;
      }),
    );
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

    const code = await runWithOptionalLocalLiveKitWorker(
      made.value,
      ready(async () => 0),
    );

    expect(code).toBe(1);
    expect(made.lines).toContain("status: missing-worker-environment");
    expect(made.lines).toContain("missing: LIVEKIT_URL");
    expect(made.lines).toContain("missing: LIVEKIT_API_SECRET");
    expect(made.lines.join("\n")).not.toContain("held-key");
  });

  it("does not start a worker when the suite preflight finds platform drift", async () => {
    const repository = await makeWorkspace();
    try {
      const url = "https://egma.example";
      const projectId = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const suiteId = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
      await repository.signIn(url);
      await createEgmaFolder({
        repository: repository.dir,
        config: {
          ...EMPTY_CONFIG,
          project: { id: projectId, name: "Northside" },
          agents: [
            {
              id: "agt_one",
              name: "Receptionist",
              connections: [
                { id: "con_one", name: "Phone", modality: "voice" },
              ],
            },
          ],
        },
      });
      const release = path.join(folderPathsIn(repository.dir).tests, "release");
      await mkdir(release);
      await writeFile(
        path.join(release, "suite.yaml"),
        serializeSuiteManifest({ id: suiteId, name: "Release" }),
      );

      const worker = controlledWorker();
      const made = options({
        cwd: repository.dir,
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
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const requested = String(input);
        calls.push(`${init?.method ?? "GET"} ${requested}`);
        const json = (body: unknown, status = 200): Response =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (requested === `${url}/v1/test-suites/${suiteId}`) {
          return json({ id: suiteId, projectId, name: "Release" });
        }
        if (requested.startsWith(`${url}/v1/tests?`)) {
          return json({
            tests: [
              {
                id: "tst_01K3XQ7M4E8YB2FVN0H9TZQWER",
                projectId,
                suiteId,
                name: "Books a visit",
                description: "",
                scenario: "The caller asks for Tuesday.",
                expectedBehaviors: ["The agent books Tuesday."],
                personas: [],
                mockTools: [],
                versionId: "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER",
                version: 1,
                revision: "rev_01K3XQ7M4E8YB2FVN0H9TZQWER",
              },
            ],
            nextPageToken: null,
          });
        }
        return json({ message: `unexpected request: ${requested}` }, 404);
      };

      const code = await runWithOptionalLocalLiveKitWorker(
        made.value,
        async () =>
          await prepareRunCommand({
            access: { url, credentialsFile: repository.credentialsFile },
            cwd: repository.dir,
            suiteDirectory: "release",
            out: made.value.out,
            fail: made.value.fail,
            fetchImpl,
          }),
      );

      expect(code).toBe(1);
      expect(calls).toContain(`GET ${url}/v1/test-suites/${suiteId}`);
      expect(calls.some((call) => call.includes("/v1/tests?"))).toBe(true);
      expect(calls.some((call) => call.startsWith(`POST ${url}/v1/runs`))).toBe(
        false,
      );
      expect(worker.startedWith()).toBeNull();
      expect(made.lines).toContain("status: not-matched");
      expect(made.lines.join("\n")).toContain(
        'Egma test "Books a visit" is missing from egma/tests/release.',
      );
      expect(made.lines).not.toContain("worker-status: starting");
    } finally {
      await repository.remove();
    }
  });

  it("keeps every local worker flag in an uncertain-start recovery command", async () => {
    const repository = await makeWorkspace();
    try {
      const url = "https://egma.example";
      const projectId = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const suiteId = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const testId = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const versionId = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const revision = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const scenario = "The caller asks for Tuesday.";
      const behavior = "The agent books Tuesday.";
      await repository.signIn(url);
      await createEgmaFolder({
        repository: repository.dir,
        config: {
          ...EMPTY_CONFIG,
          project: { id: projectId, name: "Northside" },
          agents: [
            {
              id: "agt_one",
              name: "Receptionist",
              connections: [
                { id: "con_one", name: "Chat", modality: "chat" },
              ],
            },
          ],
        },
      });
      const release = path.join(folderPathsIn(repository.dir).tests, "release");
      await mkdir(release);
      await writeFile(
        path.join(release, "suite.yaml"),
        serializeSuiteManifest({ id: suiteId, name: "Release" }),
      );
      await writeFile(
        path.join(release, "books-a-visit.md"),
        serializeTestFile(
          aTestFile({
            name: "Books a visit",
            scenario,
            expectedBehaviors: blocking(behavior),
            version: versionId,
            identityRevision: revision,
          }),
        ),
      );

      const worker = controlledWorker();
      const made = options({
        cwd: repository.dir,
        workerEntrypoint: "src/agent.py",
        workerDependencyManifest: "pyproject.toml",
        workerDispatchName: "front-desk",
        env: {
          LIVEKIT_URL: "wss://project.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
        },
        startWorker: worker.start,
      });
      const fetchImpl: typeof fetch = async (input, init) => {
        const requested = String(input);
        const json = (body: unknown): Response =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (requested === `${url}/v1/test-suites/${suiteId}`) {
          return json({ id: suiteId, projectId, name: "Release" });
        }
        if (requested.startsWith(`${url}/v1/tests?`)) {
          return json({
            tests: [
              {
                id: testId,
                projectId,
                suiteId,
                name: "Books a visit",
                description: "",
                scenario,
                expectedBehaviors: [behavior],
                personas: [],
                mockTools: [],
                versionId,
                version: 1,
                revision,
              },
            ],
            nextPageToken: null,
          });
        }
        if (requested === `${url}/v1/runs` && init?.method === "POST") {
          throw new Error("the start response was lost");
        }
        throw new Error(`unexpected request: ${requested}`);
      };

      const code = await runWithOptionalLocalLiveKitWorker(
        made.value,
        async () =>
          await prepareRunCommand({
            access: { url, credentialsFile: repository.credentialsFile },
            cwd: repository.dir,
            suiteDirectory: "release",
            idempotencyKey: "retry_worker_01",
            workerEntrypoint: "src/agent.py",
            workerDependencyManifest: "pyproject.toml",
            workerDispatchName: "front-desk",
            out: made.value.out,
            fail: made.value.fail,
            fetchImpl,
          }),
      );

      expect(code).toBe(4);
      expect(worker.stopCount()).toBe(1);
      const recovery = made.lines.find((line) =>
        line.startsWith("recovery_command: "),
      );
      expect(recovery).toContain("--worker-entrypoint 'src/agent.py'");
      expect(recovery).toContain(
        "--worker-dependency-manifest 'pyproject.toml'",
      );
      expect(recovery).toContain("--worker-dispatch-name 'front-desk'");
      expect(recovery).toContain("--idempotency-key 'retry_worker_01'");
      expect(made.lines).toContain("worker-status: ready");
      expect(made.lines).toContain("worker-status: stopped");
    } finally {
      await repository.remove();
    }
  });
});
