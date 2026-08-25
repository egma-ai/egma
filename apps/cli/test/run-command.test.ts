/** Public operational exit behavior for one followed suite run. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runRunCommand } from "../src/commands/run.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import type { GradingState, SimulationStatus } from "../src/platform/runs.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";

const EXPECTED_BEHAVIORS = [
  "confirms the new time back before finishing",
  "checks that an afternoon next week is acceptable",
  "keeps the existing booking until the new time is confirmed",
  "states the day of the rescheduled cleaning",
  "states the time of the rescheduled cleaning",
  "does not create a second booking",
  "explains what happens to the Thursday booking",
] as const;

const EXPECTED_BEHAVIORS_GRADE = {
  projectGraderId: "pgr_expected_behaviors",
  graderDefinitionId: "gdf_expected_behaviors",
  graderDefinitionVersion: 1,
  graderName: "expected_behaviors",
  score: 0.86,
  details: {
    rationale: "Six of seven expected behaviors were present.",
    assertions: EXPECTED_BEHAVIORS.map((behavior, at) => ({
      key: `behavior_${String(at + 1)}`,
      score: at === EXPECTED_BEHAVIORS.length - 1 ? 0 : 1,
      rationale:
        at === EXPECTED_BEHAVIORS.length - 1
          ? "The transcript did not explain what happened to the Thursday booking."
          : `The transcript supports: ${behavior}`,
      ...(at === EXPECTED_BEHAVIORS.length - 1
        ? {}
        : { citedSpanIds: [`span_agent_${String(at + 1)}`] }),
    })),
  },
  passThreshold: 0.62,
  result: "passed",
  gradedAt: "2026-01-01T00:01:00.000Z",
} as const;

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body?: string | null, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(body, { ...init, headers });
  }
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      project: { id: PROJECT_ID, name: "Northside" },
      agent: { id: "agt_one", name: "Receptionist" },
      connection: { id: "con_one", name: "Phone" },
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
        expectedBehaviors: blocking(...EXPECTED_BEHAVIORS),
        version: VERSION_ID,
        identityRevision: REVISION,
      }),
    ),
  );
});

afterEach(async () => workspace.remove());

function platformTest(): Record<string, unknown> {
  return {
    id: TEST_ID,
    projectId: PROJECT_ID,
    suiteId: SUITE_ID,
    name: "Books a visit",
    description: "",
    scenario: "The caller asks for Tuesday.",
    expectedBehaviors: EXPECTED_BEHAVIORS,
    personas: [],
    mockTools: [],
    versionId: VERSION_ID,
    version: 1,
    revision: REVISION,
  };
}

function runHeader(status = "pending"): Record<string, unknown> {
  return {
    id: "run_one",
    status,
    agentId: "agt_one",
    connectionId: "con_one",
    productLabel: "Fixture",
    modality: "chat",
    expectedSimulationCount: 1,
    resultsUrl: `${URL}/projects/${PROJECT_ID}/runs/run_one`,
  };
}

function simulation(
  status: SimulationStatus,
  gradingState: GradingState | null,
): Record<string, unknown> {
  return {
    id: "sim_one",
    position: 1,
    testName: "Books a visit",
    testVersionId: VERSION_ID,
    personaName: "default-persona",
    status,
    gradingState,
    reason: status === "failed" ? "the simulator stopped" : null,
  };
}

async function followedRun(input: {
  readonly status?: "completed" | "failed" | "canceled";
  readonly gradingState?: "complete" | "error" | "not_requested";
  readonly stop?: AbortController;
}): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
  const status = input.status ?? "completed";
  const gradingState = status === "completed" ? (input.gradingState ?? "complete") : null;
  const lines: string[] = [];
  let moved = false;
  const fetchImpl: typeof fetch = async (request, init) => {
    const url = String(request);
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
      return new JsonResponse(JSON.stringify(runHeader()), { status: 201 });
    }
    if (url === `${URL}/v1/runs/run_one`) {
      return new JsonResponse(JSON.stringify(runHeader(moved ? "completed" : "pending")));
    }
    if (url === `${URL}/v1/runs/run_one/simulations`) {
      return new JsonResponse(
        JSON.stringify({
          simulations: [
            moved ? simulation(status, gradingState) : simulation("queued", null),
          ],
          nextPageToken: null,
        }),
      );
    }
    if (url === `${URL}/v1/simulations/sim_one`) {
      return new JsonResponse(
        JSON.stringify({
          ...simulation(status, gradingState),
          projectId: PROJECT_ID,
          runId: "run_one",
          runName: null,
          grades:
            gradingState === "complete" ? [EXPECTED_BEHAVIORS_GRADE] : [],
          gradeHistory: [],
          combinedScore: gradingState === "complete" ? 0.86 : null,
          test: { expectedBehaviors: EXPECTED_BEHAVIORS },
        }),
      );
    }
    if (url === `${URL}/v1/runs/run_one/events?after=0`) {
      if (input.stop !== undefined) {
        input.stop.abort("developer stopped following");
        return new JsonResponse(JSON.stringify({ events: [], next: 0, done: false }));
      }
      moved = true;
      return new JsonResponse(
        JSON.stringify({
          events: [
            {
              seq: 1,
              at: "2026-01-01T00:00:00.000Z",
              kind: "simulation",
              simulationId: "sim_one",
              testName: "Books a visit",
              personaName: "default-persona",
              status,
              reason: status === "failed" ? "the simulator stopped" : null,
            },
            {
              seq: 2,
              at: "2026-01-01T00:00:00.000Z",
              kind: "run",
              status: "completed",
            },
          ],
          next: 2,
          done: true,
        }),
      );
    }
    return new JsonResponse(JSON.stringify({ message: `unexpected request: ${url}` }), {
      status: 404,
    });
  };

  const code = await runRunCommand({
    access: { url: URL, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    suiteDirectory: "release",
    out: (line) => lines.push(line),
    fail: (line) => lines.push(`stderr: ${line}`),
    everyMs: 0,
    ...(input.stop === undefined ? {} : { signal: input.stop.signal }),
    fetchImpl,
  });
  return { code, lines };
}

describe("runRunCommand operational exit behavior", () => {
  it("shows one Expected behaviors grade with seven assertion details and keeps the operational success exit", async () => {
    const answer = await followedRun({ gradingState: "complete" });

    expect(answer.code).toBe(0);
    expect(answer.lines).toContain("status: completed");
    expect(answer.lines).toContain("grading-complete: 1");
    const output = answer.lines.join("\n");
    expect(output).toContain("combined-score: 0.86");
    expect(output).toContain(
      "grade: Expected behaviors score 0.86 pass-threshold 0.62 result passed",
    );
    expect(output).toContain(
      "grade-rationale: Six of seven expected behaviors were present.",
    );
    for (const [at, behavior] of EXPECTED_BEHAVIORS.entries()) {
      expect(output).toContain(`assertion: behavior_${String(at + 1)}`);
      expect(output).toContain(
        at === EXPECTED_BEHAVIORS.length - 1
          ? "The transcript did not explain what happened to the Thursday booking."
          : `The transcript supports: ${behavior}`,
      );
    }
    expect(output.match(/^assertion: /gmu)).toHaveLength(7);
    expect(output).not.toMatch(/overall verdict|\bgate\b|\brequired\b|latency/iu);
  });

  it("returns 6 after an execution error and does not wait for grading", async () => {
    const answer = await followedRun({ status: "failed" });

    expect(answer.code).toBe(6);
    expect(answer.lines).toContain("execution-failed: 1");
    expect(answer.lines).toContain("grading-terminal: 0");
  });

  it("returns 6 for a grader error or terminal grading-job failure", async () => {
    const answer = await followedRun({ gradingState: "error" });

    expect(answer.code).toBe(6);
    expect(answer.lines).toContain("grading-errors: 1");
  });

  it("finishes a canceled simulation without waiting for grading", async () => {
    const answer = await followedRun({ status: "canceled" });

    expect(answer.code).toBe(0);
    expect(answer.lines).toContain("execution-canceled: 1");
    expect(answer.lines).toContain("grading-terminal: 0");
  });

  it("returns 130 and leaves the platform run active when following is interrupted", async () => {
    const stopping = new AbortController();
    const answer = await followedRun({ stop: stopping });

    expect(answer.code).toBe(130);
    expect(answer.lines).toContain("status: left-running");
    expect(answer.lines).toContain("execution-finished: 0");
  });
});
