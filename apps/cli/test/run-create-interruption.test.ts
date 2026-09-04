/** Ctrl-C stops every remote phase of `egma run create`. */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";

import { expect, it } from "vitest";

import {
  runCancelCommand,
  runCreateCommand,
} from "../src/commands/run.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import {
  CLI_ENTRY,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";
const RUN_ID = "run_01K3XQ7M4E8YB2FVN0H9TZQWER";

class JsonResponse extends Response {
  constructor(body: unknown, status = 200) {
    super(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

function platformTest(): Record<string, unknown> {
  return {
    id: TEST_ID,
    projectId: PROJECT_ID,
    suiteId: SUITE_ID,
    name: "Books a visit",
    description: "",
    scenario: "The caller asks for Tuesday.",
    expectedBehaviors: ["The agent books Tuesday."],
    personas: [],
    mockTools: [],
    env: null,
    versionId: VERSION_ID,
    version: 1,
    revision: REVISION,
  };
}

async function preparedWorkspace(url: string): Promise<Workspace> {
  const workspace = await makeWorkspace();
  await workspace.signIn(url);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: url },
      project: { id: PROJECT_ID, name: "Northside" },
      agents: [
        {
          id: "agt_one",
          name: "Receptionist",
          platform: "livekit",
          connections: [{ id: "con_one", name: "Primary" }],
        },
      ],
    },
  });

  const suite = path.join(folderPathsIn(workspace.dir).tests, "release");
  await mkdir(suite);
  await writeFile(
    path.join(suite, "suite.yaml"),
    serializeSuiteManifest({ id: SUITE_ID, name: "Release" }),
  );
  await writeFile(
    path.join(suite, "books-a-visit.md"),
    serializeTestFile(
      aTestFile({
        name: "Books a visit",
        scenario: "The caller asks for Tuesday.",
        expectedBehaviors: blocking("The agent books Tuesday."),
      }),
    ),
  );
  return workspace;
}

type RemotePhase = "push" | "suite" | "tests" | "version" | "run";

function phaseOf(url: string): RemotePhase | null {
  const parsed = new URL(url);
  if (parsed.pathname === "/v1/repository/change-set") return "push";
  if (parsed.pathname === `/v1/test-suites/${SUITE_ID}`) return "suite";
  if (parsed.pathname === "/v1/tests") return "tests";
  if (parsed.pathname === `/v1/test-versions/${VERSION_ID}`) return "version";
  if (parsed.pathname === "/v1/runs") return "run";
  return null;
}

function answerFor(phase: RemotePhase, body: unknown): Response {
  switch (phase) {
    case "push": {
      const change = JSON.parse(String(body)) as {
        readonly tests: readonly { readonly clientRef: string }[];
      };
      return new JsonResponse({
        tests: [
          {
            clientRef: change.tests[0]?.clientRef,
            test: platformTest(),
          },
        ],
      });
    }
    case "suite":
      return new JsonResponse({
        id: SUITE_ID,
        projectId: PROJECT_ID,
        name: "Release",
      });
    case "tests":
      return new JsonResponse({ tests: [platformTest()], nextPageToken: null });
    case "version":
      return new JsonResponse({ error: "not-used" }, 500);
    case "run":
      return new JsonResponse({ error: "not-used" }, 500);
  }
}

it.each<RemotePhase>(["push", "suite", "tests", "version", "run"])(
  "returns 130 when interrupted during the %s request",
  async (interruptedPhase) => {
    const workspace = await preparedWorkspace("https://egma.example");
    const controller = new AbortController();
    const output: string[] = [];
    const failed: string[] = [];
    let requestSignal: AbortSignal | undefined;
    try {
      const code = await runCreateCommand({
        access: {
          url: "https://egma.example",
          credentialsFile: workspace.credentialsFile,
        },
        cwd: workspace.dir,
        suiteDirectory: "release",
        agent: "agt_one",
        connection: "con_one",
        signal: controller.signal,
        out: (line) => output.push(line),
        fail: (line) => failed.push(line),
        fetchImpl: async (input, init) => {
          const phase = phaseOf(String(input));
          if (phase === null) return new JsonResponse({ error: "not-found" }, 404);
          if (phase === "tests" && interruptedPhase === "version") {
            return new JsonResponse({ tests: [], nextPageToken: null });
          }
          if (phase !== interruptedPhase) return answerFor(phase, init?.body);

          requestSignal = init?.signal ?? undefined;
          controller.abort("interrupt");
          await Promise.resolve();
          if (requestSignal?.aborted === true) {
            throw new DOMException("The request was stopped.", "AbortError");
          }
          return new JsonResponse({ error: "still-running" }, 500);
        },
      });

      expect(requestSignal?.aborted).toBe(true);
      expect(code).toBe(130);
      expect(output).toEqual([]);
      expect(failed).toEqual([
        interruptedPhase === "push"
          ? "Run creation was interrupted during the pre-run push. No Run was created. Run egma pull before you try again."
          : "The command was interrupted before it received a complete answer. Check the Runs page before you try again.",
      ]);
    } finally {
      await workspace.remove();
    }
  },
);

it("writes returned push pins before it stops an interrupted command", async () => {
  const workspace = await preparedWorkspace("https://egma.example");
  const controller = new AbortController();
  const calls: RemotePhase[] = [];
  const output: string[] = [];
  const failed: string[] = [];
  try {
    const code = await runCreateCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: controller.signal,
      out: (line) => output.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async (input, init) => {
        const phase = phaseOf(String(input));
        if (phase === null) return new JsonResponse({ error: "not-found" }, 404);
        calls.push(phase);
        if (phase === "push") {
          controller.abort("interrupt");
          return answerFor(phase, init?.body);
        }
        return new JsonResponse({ error: "should-not-be-called" }, 500);
      },
    });

    expect(code).toBe(130);
    expect(calls).toEqual(["push"]);
    expect(output.join("\n")).toContain(`Applied Test Books a visit (${TEST_ID}).`);
    expect(output.join("\n")).toContain(`Version ID: ${VERSION_ID}`);
    expect(failed).toEqual([
      "Run creation was interrupted after Egma applied the pre-run push. Returned Test version IDs were saved locally. No Run was created. Run egma run create again when you are ready.",
    ]);
    expect(
      await readFile(
        path.join(
          folderPathsIn(workspace.dir).tests,
          "release",
          "books-a-visit.md",
        ),
        "utf8",
      ),
    ).toContain(`version: ${VERSION_ID}`);
  } finally {
    await workspace.remove();
  }
});

it("prints a started Run receipt before a post-write interruption exits 130", async () => {
  const workspace = await preparedWorkspace("https://egma.example");
  const controller = new AbortController();
  const output: string[] = [];
  const failed: string[] = [];
  try {
    const code = await runCreateCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: controller.signal,
      out: (line) => output.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async (input, init) => {
        const phase = phaseOf(String(input));
        if (phase === null) return new JsonResponse({ error: "not-found" }, 404);
        if (phase !== "run") return answerFor(phase, init?.body);
        controller.abort("interrupt");
        return new JsonResponse(
          {
            id: RUN_ID,
            projectId: PROJECT_ID,
            suiteId: SUITE_ID,
            agentId: "agt_one",
            connectionId: "con_one",
            status: "pending",
            connectionType: "livekit_room",
            productLabel: "LiveKit project credentials",
            modality: "voice",
            expectedSimulationCount: 1,
            resultsUrl: "",
          },
          201,
        );
      },
    });

    expect(code).toBe(130);
    expect(output).toContain(`Started Run ${RUN_ID}.`);
    expect(output.join("\n")).toContain(`/projects/${PROJECT_ID}/runs/${RUN_ID}`);
    expect(failed).toEqual([
      "The command was interrupted after Egma started this Run. The Run is continuing. Use the printed Egma URL to view it, and do not start another Run for the same work.",
    ]);
  } finally {
    await workspace.remove();
  }
});

it("keeps a returned Run ID from injecting terminal lines or ANSI", async () => {
  const workspace = await preparedWorkspace("https://egma.example");
  const unsafeRunId = `${RUN_ID}\n\u001b[31m\u202e`;
  const output: string[] = [];
  try {
    const code = await runCreateCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: new AbortController().signal,
      out: (line) => output.push(line),
      fail: () => undefined,
      fetchImpl: async (input, init) => {
        const phase = phaseOf(String(input));
        if (phase === null) return new JsonResponse({ error: "not-found" }, 404);
        if (phase !== "run") return answerFor(phase, init?.body);
        return new JsonResponse(
          {
            id: unsafeRunId,
            projectId: PROJECT_ID,
            suiteId: SUITE_ID,
            agentId: "agt_one",
            connectionId: "con_one",
            status: "pending",
            connectionType: "livekit_room",
            productLabel: "LiveKit project credentials",
            modality: "voice",
            expectedSimulationCount: 1,
            resultsUrl: "",
          },
          201,
        );
      },
    });

    expect(code).toBe(0);
    expect(output[0]).toBe(`Started Run ${RUN_ID}[31m.`);
    expect(output.every((line) => !/[\r\n\u001b\u202e]/u.test(line))).toBe(true);
  } finally {
    await workspace.remove();
  }
});

it("returns 130 when a Run cancellation request is interrupted", async () => {
  const workspace = await preparedWorkspace("https://egma.example");
  const controller = new AbortController();
  const output: string[] = [];
  const failed: string[] = [];
  let requestSignal: AbortSignal | undefined;
  try {
    const code = await runCancelCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      runId: "run_01K3XQ7M4E8YB2FVN0H9TZQWER",
      signal: controller.signal,
      out: (line) => output.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        controller.abort("interrupt");
        await Promise.resolve();
        if (requestSignal?.aborted === true) {
          throw new DOMException("The request was stopped.", "AbortError");
        }
        return new JsonResponse({ error: "still-running" }, 500);
      },
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(code).toBe(130);
    expect(output).toEqual([]);
    expect(failed).toEqual([
      "The command was interrupted before it received a complete answer. Check the Runs page before you try again.",
    ]);
  } finally {
    await workspace.remove();
  }
});

it("prints a canceled Run receipt before a post-write interruption exits 130", async () => {
  const workspace = await preparedWorkspace("https://egma.example");
  const controller = new AbortController();
  const output: string[] = [];
  const failed: string[] = [];
  try {
    const code = await runCancelCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      runId: RUN_ID,
      signal: controller.signal,
      out: (line) => output.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async () => {
        controller.abort("interrupt");
        return new JsonResponse({
          id: RUN_ID,
          projectId: PROJECT_ID,
          suiteId: SUITE_ID,
          agentId: "agt_one",
          connectionId: "con_one",
          status: "canceled",
          connectionType: "livekit_room",
          productLabel: "LiveKit project credentials",
          modality: "voice",
          expectedSimulationCount: 1,
          resultsUrl: "",
        });
      },
    });

    expect(code).toBe(130);
    expect(output).toEqual([`Canceled Run ${RUN_ID}.`]);
    expect(failed).toEqual([
      "The command was interrupted after Egma canceled this Run. The cancellation is complete. Nothing needs to be retried.",
    ]);
  } finally {
    await workspace.remove();
  }
});

function sendJson(answer: ServerResponse, status: number, body: unknown): void {
  if (answer.destroyed) return;
  answer.writeHead(status, { "content-type": "application/json" });
  answer.end(JSON.stringify(body));
}

it("turns Ctrl-C during the pre-run push into process exit 130", async () => {
  let interrupt: (() => void) | undefined;
  const server = createServer((request, answer) => {
    request.resume();
    if (
      request.method === "POST" &&
      request.url?.startsWith("/v1/repository/change-set?") === true
    ) {
      interrupt?.();
      setTimeout(() => {
        sendJson(answer, 503, { error: "still-running" });
      }, 50);
      return;
    }
    sendJson(answer, 404, { error: "not-found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const workspace = await preparedWorkspace(url);

  try {
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          "run",
          "create",
          "release",
          "--agent",
          "agt_one",
          "--connection",
          "con_one",
        ],
        { cwd: workspace.dir, env: workspace.env() },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      interrupt = () => child.kill("SIGINT");

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("egma did not stop after Ctrl-C"));
      }, 5_000);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, stdout, stderr });
      });
    });

    expect(result.signal).toBeNull();
    expect(result.code).toBe(130);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Run creation was interrupted during the pre-run push. No Run was created.",
    );
    expect(result.stderr).toContain("Run egma pull before you try again.");
  } finally {
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      workspace.remove(),
    ]);
  }
});
