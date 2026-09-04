/** Promptless create and cancel operations for the Run resource. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";
const RUN_ID = "run_01K3XQ7M4E8YB2FVN0H9TZQWER";

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body?: string | null, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(body, { ...init, headers });
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

function runHeader(status: "pending" | "canceled"): Record<string, unknown> {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    suiteId: SUITE_ID,
    suiteName: "Release",
    suiteDeleted: false,
    name: null,
    status,
    agentId: "agt_one",
    connectionId: "con_one",
    agentPlatform: "retell",
    connectionType: "retell_web_call",
    accessVariant: "retell.web_call",
    modality: "voice",
    productLabel: "Retell",
    environment: null,
    agentVersion: null,
    expectedSimulationCount: 1,
    completedCount: 0,
    failedCount: 0,
    canceledCount: status === "canceled" ? 1 : 0,
    simulationCounts: {
      queued: status === "pending" ? 1 : 0,
      claimed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      canceled: status === "canceled" ? 1 : 0,
    },
    finishedCount: status === "canceled" ? 1 : 0,
    gradableCount: 0,
    gradedCount: 0,
    // The CLI must construct the UI URL from the committed platform origin.
    resultsUrl: `https://wrong.example/projects/${PROJECT_ID}/runs/${RUN_ID}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: status === "canceled" ? "2026-01-01T00:01:00.000Z" : null,
  };
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: URL },
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
});

afterEach(async () => workspace.remove());

describe("Run resource commands", () => {
  it("pushes the complete repository before creating a run, then exits with its id and committed UI URL", async () => {
    const calls: string[] = [];
    const runInputs: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);

      if (
        url === `${URL}/v1/repository/change-set?projectId=${PROJECT_ID}` &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as {
          readonly tests: readonly { readonly clientRef: string }[];
        };
        return new JsonResponse(
          JSON.stringify({
            tests: [{ clientRef: body.tests[0]?.clientRef, test: platformTest() }],
          }),
        );
      }
      if (url === `${URL}/v1/test-suites/${SUITE_ID}`) {
        return new JsonResponse(
          JSON.stringify({ id: SUITE_ID, projectId: PROJECT_ID, name: "Release" }),
        );
      }
      if (url.startsWith(`${URL}/v1/tests?`)) {
        return new JsonResponse(
          JSON.stringify({ tests: [platformTest()], nextPageToken: null }),
        );
      }
      if (url === `${URL}/v1/runs` && init?.method === "POST") {
        runInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new JsonResponse(JSON.stringify(runHeader("pending")), { status: 201 });
      }
      return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
        status: 404,
      });
    };
    const out: string[] = [];

    const code = await runCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: new AbortController().signal,
      out: (line) => out.push(line),
      fail: (line) => out.push(`stderr: ${line}`),
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(calls.map((call) => call.replace(/\?.*$/u, ""))).toEqual([
      `POST ${URL}/v1/repository/change-set`,
      `GET ${URL}/v1/test-suites/${SUITE_ID}`,
      `GET ${URL}/v1/tests`,
      `POST ${URL}/v1/runs`,
    ]);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).toMatchObject({
      suiteId: SUITE_ID,
      agentId: "agt_one",
      connectionId: "con_one",
      expectedTestVersions: [{ testId: TEST_ID, versionId: VERSION_ID }],
    });
    expect(runInputs[0]?.idempotencyKey).toMatch(/^run_[0-9a-f-]+$/u);
    expect(out).toContain(`run: ${RUN_ID}`);
    expect(out).toContain(
      `results: ${URL}/projects/${PROJECT_ID}/runs/${RUN_ID}`,
    );
    expect(out).toContain("status: started");
    expect(out.some((line) => line.startsWith("idempotency-key:"))).toBe(false);
    expect(calls.some((call) => call.includes("/simulations"))).toBe(false);
    expect(calls.some((call) => call.includes("/events"))).toBe(false);
    expect(
      await readFile(
        path.join(folderPathsIn(workspace.dir).tests, "release", "books-a-visit.md"),
        "utf8",
      ),
    ).toContain(`version: ${VERSION_ID}`);
  });

  it("does not create a run when the repository push is refused", async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const code = await runCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: new AbortController().signal,
      out: (line) => out.push(line),
      fail: (line) => out.push(`stderr: ${line}`),
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new JsonResponse(
          JSON.stringify({ error: "repository_conflict", message: "pull first" }),
          { status: 409 },
        );
      },
    });

    expect(code).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/repository/change-set");
    expect(out).toContain("status: push-refused");
  });

  it("cancels one run in the configured project through the exact Run API", async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const code = await runCancelCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      runId: RUN_ID,
      out: (line) => out.push(line),
      fail: (line) => out.push(`stderr: ${line}`),
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new JsonResponse(JSON.stringify(runHeader("canceled")));
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      `POST ${URL}/v1/runs/${RUN_ID}/cancel?projectId=${PROJECT_ID}`,
    ]);
    expect(out).toContain(`run: ${RUN_ID}`);
    expect(out).toContain("status: canceled");
  });

  it("reports a missing run without changing anything else", async () => {
    const out: string[] = [];
    const code = await runCancelCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      runId: RUN_ID,
      out: (line) => out.push(line),
      fail: (line) => out.push(`stderr: ${line}`),
      fetchImpl: async () =>
        new JsonResponse(
          JSON.stringify({ error: "not_found", message: "no run of yours has that id" }),
          { status: 404 },
        ),
    });

    expect(code).toBe(1);
    expect(out).toContain("status: no-run");
  });
});
