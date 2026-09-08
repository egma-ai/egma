/** Promptless create and cancel operations for the Run resource. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runGetCommand,
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
      if (
        url === `${URL}/v1/runs?projectId=${PROJECT_ID}` &&
        init?.method === "POST"
      ) {
        runInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new JsonResponse(JSON.stringify(runHeader("pending")), { status: 201 });
      }
      return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
        status: 404,
      });
    };
    const out: string[] = [];
    const failed: string[] = [];

    const code = await runCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      concurrency: 100,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: new AbortController().signal,
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
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
      concurrency: 100,
      suiteId: SUITE_ID,
      agentId: "agt_one",
      connectionId: "con_one",
      expectedTestVersions: [{ testId: TEST_ID, versionId: VERSION_ID }],
    });
    expect(runInputs[0]).not.toHaveProperty("idempotencyKey");
    expect(failed).toEqual([]);
    expect(out).toEqual([
      `Started Run ${RUN_ID}.`,
      `View its progress in Egma: ${URL}/projects/${PROJECT_ID}/runs/${RUN_ID}`,
    ]);
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
    const failed: string[] = [];
    const code = await runCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      agent: "agt_one",
      connection: "con_one",
      signal: new AbortController().signal,
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new JsonResponse(
          JSON.stringify({ error: "repository_conflict", message: "pull first" }),
          { status: 409 },
        );
      },
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/repository/change-set");
    expect(out).toEqual([]);
    expect(failed.join("\n")).toContain("pull first");
    expect(failed.join("\n")).toContain("No Run was created.");
  });

  it("cancels one run in the configured project through the exact Run API", async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const failed: string[] = [];
    const code = await runCancelCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      runId: RUN_ID,
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new JsonResponse(JSON.stringify(runHeader("canceled")));
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      `POST ${URL}/v1/runs/${RUN_ID}/cancel?projectId=${PROJECT_ID}`,
    ]);
    expect(failed).toEqual([]);
    expect(out).toEqual([`Canceled Run ${RUN_ID}.`]);
  });

  it("reports a missing run without changing anything else", async () => {
    const out: string[] = [];
    const failed: string[] = [];
    const code = await runCancelCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      runId: RUN_ID,
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async () =>
        new JsonResponse(
          JSON.stringify({ error: "not_found", message: "no run of yours has that id" }),
          { status: 404 },
        ),
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(failed).toEqual([
      "no run of yours has that id",
      `Egma has no Run ${RUN_ID} in this Project. Nothing was changed.`,
    ]);
  });
});

describe("run get", () => {
  it("collects every simulation and event page and preserves full evidence as JSON", async () => {
    const out: string[] = [];
    const failed: string[] = [];
    const calls: string[] = [];
    const code = await runGetCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir, runId: RUN_ID,
      out: (line) => out.push(line), fail: (line) => failed.push(line),
      fetchImpl: async (input, init) => {
        const url = new globalThis.URL(String(input));
        calls.push(url.pathname);
        expect(init?.method ?? "GET").toBe("GET");
        expect(url.searchParams.get("projectId")).toBe(PROJECT_ID);
        let body: unknown;
        if (url.pathname.endsWith("/simulations")) {
          const second = url.searchParams.has("pageToken");
          body = { simulations: [{ id: second ? "sim_second" : "sim_first" }], nextPageToken: second ? null : "sim_first" };
        } else if (url.pathname.startsWith("/v1/simulations/")) {
          body = {
            id: url.pathname.split("/").at(-1), status: "completed",
            test: { scenario: "Preserve\nall text" },
            grades: [{ score: 0.5, details: { rationale: "Full rationale", assertions: [{ citedSpanIds: ["span1"] }] } }],
            transcript: { spansTruncated: url.pathname.endsWith("sim_second"), spans: [{ toolArguments: { name: "Alex" }, toolResult: "Booked" }] },
            metrics: [{ key: "duration", value: 30 }],
          };
        } else if (url.pathname.endsWith("/events")) {
          const second = url.searchParams.get("after") === "1";
          body = { events: [{ seq: second ? 2 : 1 }], next: second ? 2 : 1, caughtUp: second, done: false };
        } else {
          body = runHeader("pending");
        }
        return new JsonResponse(JSON.stringify(body));
      },
    });
    expect(code).toBe(0);
    expect(failed).toEqual([]);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result.simulations.map((simulation: { id: string }) => simulation.id)).toEqual(["sim_first", "sim_second"]);
    expect(result.simulations[0].test.scenario).toBe("Preserve\nall text");
    expect(result.simulations[0].grades[0].details.rationale).toBe("Full rationale");
    expect(result.simulations[0].transcript.spans[0].toolResult).toBe("Booked");
    expect(result.events).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("sim_second");
    expect(Date.parse(result.fetchedAt)).toBeGreaterThanOrEqual(Date.parse(result.readStartedAt));
    expect(calls.filter((call) => call.endsWith("/simulations"))).toHaveLength(2);
  });

  it("fails without partial JSON when a child resource cannot be read", async () => {
    const out: string[] = [];
    const failed: string[] = [];
    const code = await runGetCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir, runId: RUN_ID,
      out: (line) => out.push(line), fail: (line) => failed.push(line),
      fetchImpl: async (input) => {
        if (String(input).includes("/simulations")) {
          return new JsonResponse(JSON.stringify({ message: "Read refused" }), { status: 403 });
        }
        return new JsonResponse(JSON.stringify(runHeader("pending")));
      },
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(failed).toEqual(["Read refused"]);
  });
});

describe("run concurrency validation", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])("rejects %s before pushing or starting a run", async (concurrency) => {
    const failed: string[] = [];
    let calls = 0;
    const code = await runCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir, suiteDirectory: "release", agent: "agt_one", connection: "con_one",
      concurrency, signal: new AbortController().signal,
      out: () => {}, fail: (line) => failed.push(line),
      fetchImpl: async () => { calls += 1; return new JsonResponse("{}"); },
    });
    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(failed[0]).toContain("Concurrency must be a whole number");
  });
});
