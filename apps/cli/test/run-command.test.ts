/** Public exit behavior for one followed suite run. */

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
import type { Verdict } from "../src/platform/runs.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";

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
        expectedBehaviors: blocking("The agent books Tuesday."),
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
    expectedBehaviors: ["The agent books Tuesday."],
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
    resultsUrl: `${URL}/runs/run_one`,
  };
}

function simulation(verdict: Verdict | null, status = "queued"): Record<string, unknown> {
  return {
    id: "sim_one",
    position: 1,
    testName: "Books a visit",
    testVersionId: VERSION_ID,
    personaName: "default-persona",
    status,
    verdict,
    reason: null,
  };
}

async function followedRun(input: {
  readonly verdict?: Verdict;
  readonly stop?: AbortController;
}): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
  const lines: string[] = [];
  const fetchImpl: typeof fetch = async (request, init) => {
    const url = String(request);
    if (url === `${URL}/v1/test-suites/${SUITE_ID}`) {
      return new JsonResponse(
        JSON.stringify({ id: SUITE_ID, projectId: PROJECT_ID, name: "Release" }),
      );
    }
    if (url.startsWith(`${URL}/v1/tests?`)) {
      return new JsonResponse(JSON.stringify({ tests: [platformTest()], nextPageToken: null }));
    }
    if (url === `${URL}/v1/runs` && init?.method === "POST") {
      return new JsonResponse(JSON.stringify(runHeader()), { status: 201 });
    }
    if (url === `${URL}/v1/runs/run_one/simulations`) {
      return new JsonResponse(
        JSON.stringify({ simulations: [simulation(null)], nextPageToken: null }),
      );
    }
    if (url === `${URL}/v1/runs/run_one/events?after=0`) {
      if (input.stop !== undefined) {
        input.stop.abort("developer stopped following");
        return new JsonResponse(JSON.stringify({ events: [], next: 0, done: false }));
      }
      const verdict = input.verdict ?? "passed";
      return new JsonResponse(
        JSON.stringify({
          events: [
            {
              seq: 1,
              kind: "simulation",
              simulationId: "sim_one",
              testName: "Books a visit",
              personaName: "default-persona",
              status: verdict === "errored" ? "failed" : "completed",
              verdict,
              reason: verdict === "errored" ? "the simulator stopped" : null,
            },
            { seq: 2, kind: "run", status: "completed" },
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

describe("runRunCommand public exit behavior", () => {
  it("returns 0 after a followed suite passes", async () => {
    const answer = await followedRun({ verdict: "passed" });

    expect(answer.code).toBe(0);
    expect(answer.lines).toContain("status: completed");
    expect(answer.lines).toContain("passed: 1");
  });

  it("returns 3 after a followed suite has a failed verdict", async () => {
    const answer = await followedRun({ verdict: "failed" });

    expect(answer.code).toBe(3);
    expect(answer.lines).toContain("failed: 1");
  });

  it("returns 6 when execution errors and no test fails", async () => {
    const answer = await followedRun({ verdict: "errored" });

    expect(answer.code).toBe(6);
    expect(answer.lines).toContain("failed: 0");
    expect(answer.lines).toContain("errored: 1");
  });

  it("returns 130 and leaves the platform run active when following is interrupted", async () => {
    const stopping = new AbortController();
    const answer = await followedRun({ stop: stopping });

    expect(answer.code).toBe(130);
    expect(answer.lines).toContain("status: left-running");
    expect(answer.lines).toContain("pending: 1");
  });
});
