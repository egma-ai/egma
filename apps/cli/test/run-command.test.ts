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
  writeConfig,
  type FolderAgent,
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
      agents: [
        {
          id: "agt_one",
          name: "Receptionist",
          connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
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

function runHeader(
  status = "pending",
  agentId = "agt_one",
  connectionId = "con_one",
  connectionType = "retell_web_call",
): Record<string, unknown> {
  return {
    id: "run_one",
    status,
    agentId,
    connectionId,
    connectionType,
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
  readonly agent?: string;
  readonly connection?: string;
  readonly idempotencyKey?: string;
  /** The lane the platform says the started run is over. */
  readonly connectionType?: string;
}): Promise<{
  readonly code: number;
  readonly lines: readonly string[];
  readonly linesWhenStarted: readonly string[];
  readonly startedWith: Readonly<Record<string, unknown>> | null;
}> {
  const status = input.status ?? "completed";
  const connectionType = input.connectionType ?? "retell_web_call";
  const gradingState = status === "completed" ? (input.gradingState ?? "complete") : null;
  const lines: string[] = [];
  let moved = false;
  let startedWith: Readonly<Record<string, unknown>> | null = null;
  let linesWhenStarted: readonly string[] = [];
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
      linesWhenStarted = [...lines];
      startedWith = JSON.parse(String(init.body)) as Readonly<Record<string, unknown>>;
      return new JsonResponse(
        JSON.stringify(
          runHeader(
            "pending",
            String(startedWith.agentId),
            String(startedWith.connectionId),
            connectionType,
          ),
        ),
        { status: 201 },
      );
    }
    if (url === `${URL}/v1/runs/run_one`) {
      return new JsonResponse(
        JSON.stringify(
          runHeader(moved ? "completed" : "pending", "agt_one", "con_one", connectionType),
        ),
      );
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
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.connection === undefined ? {} : { connection: input.connection }),
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
    out: (line) => lines.push(line),
    fail: (line) => lines.push(`stderr: ${line}`),
    everyMs: 0,
    ...(input.stop === undefined ? {} : { signal: input.stop.signal }),
    fetchImpl,
  });
  return { code, lines, linesWhenStarted, startedWith };
}

async function writeTargets(agents: readonly FolderAgent[]): Promise<void> {
  const paths = folderPathsIn(workspace.dir);
  await writeConfig(paths.config, {
    ...EMPTY_CONFIG,
    project: { id: PROJECT_ID, name: "Northside" },
    agents,
  });
}

describe("runRunCommand operational exit behavior", () => {
  it("prints a generated retry key before starting and reuses an explicit key exactly", async () => {
    const generated = await followedRun({});
    const generatedLine = generated.lines.find((line) =>
      line.startsWith("idempotency-key: "),
    );
    expect(generatedLine).toMatch(/^idempotency-key: run_[0-9a-f-]+$/u);
    expect(generated.linesWhenStarted).toContain(generatedLine);
    expect(generated.startedWith?.idempotencyKey).toBe(
      generatedLine?.slice("idempotency-key: ".length),
    );

    const retried = await followedRun({ idempotencyKey: "retry_release_01" });
    expect(retried.linesWhenStarted).toContain(
      "idempotency-key: retry_release_01",
    );
    expect(retried.startedWith?.idempotencyKey).toBe("retry_release_01");
  });

  it("prints the complete safe retry command when a start result is unknown", async () => {
    const lines: string[] = [];
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
        throw new Error("the response was lost");
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const code = await runRunCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      name: "Tonight's release",
      idempotencyKey: "retry_release_01",
      noFollow: true,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl,
    });

    expect(code).toBe(4);
    expect(lines).toContain(
      `recovery_command: egma run 'release' --cwd '${workspace.dir}' ` +
        `--url '${URL}' --agent 'agt_one' --connection 'con_one' ` +
        `--name 'Tonight'"'"'s release' --no-follow ` +
        `--idempotency-key 'retry_release_01'`,
    );
    expect(lines).toContain("status: unreachable");
  });

  it("refuses a blank retry key before any platform request", async () => {
    const lines: string[] = [];
    let requests = 0;
    const code = await runRunCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      idempotencyKey: " \t ",
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("the platform must not be called");
      },
    });

    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(lines).toContain("status: invalid-idempotency-key");
    expect(lines).toContain(
      "stderr: Give --idempotency-key one non-empty value. Nothing was started.",
    );
  });

  it.each([
    ["a line break", "retry_release_01\nstatus: started"],
    ["a terminal control", "retry_release_01\u001b[2J"],
    ["a Unicode line separator", "retry_release_01\u2028status: started"],
    ["more than 200 characters", "a".repeat(201)],
  ])("refuses a retry key with %s before any platform request", async (_case, key) => {
    const lines: string[] = [];
    let requests = 0;
    const code = await runRunCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      suiteDirectory: "release",
      idempotencyKey: key,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("the platform must not be called");
      },
    });

    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(lines).toContain("status: invalid-idempotency-key");
    expect(lines).toContain(
      "stderr: Give --idempotency-key one line of at most 200 characters, without control characters. Nothing was started.",
    );
  });

  it("selects configured agents and connections by exact name or stable id", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
      },
      {
        id: "agt_two",
        name: "After hours",
        connections: [
          { id: "con_two", name: "Phone", modality: "voice" },
          { id: "con_three", name: "Chat", modality: "chat" },
        ],
      },
    ]);

    const byNameAndId = await followedRun({
      agent: "After hours",
      connection: "con_three",
    });

    expect(byNameAndId.code).toBe(0);
    expect(byNameAndId.lines).toContain("agent: agt_two");
    expect(byNameAndId.lines).toContain("connection: con_three");
    expect(byNameAndId.startedWith).toMatchObject({
      agentId: "agt_two",
      connectionId: "con_three",
    });

    const byIdAndName = await followedRun({
      agent: "agt_two",
      connection: "Chat",
    });
    expect(byIdAndName.code).toBe(0);
    expect(byIdAndName.startedWith).toMatchObject({
      agentId: "agt_two",
      connectionId: "con_three",
    });
  });

  it("names the lane at the start, and says plainly what a phone run reaches", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
      },
    ]);

    // The folder stores a connection's id and the name somebody gave it, and
    // "Phone" is a name rather than a fact. The lane comes off the run the
    // platform just wrote.
    const phone = await followedRun({ connectionType: "phone_number" });
    expect(phone.code).toBe(0);
    expect(phone.lines).toContain("lane: Phone call");
    expect(phone.lines).toContain(
      "note: Egma dials the real number, so this run reaches your real tools.",
    );

    // Every other lane names itself and claims nothing more: whether its tools
    // are mocked is the connection's own switch, not the lane's promise.
    const webCall = await followedRun({ connectionType: "retell_web_call" });
    expect(webCall.lines).toContain("lane: Web call");
    expect(webCall.lines.some((line) => line.startsWith("note: "))).toBe(false);

    const text = await followedRun({ connectionType: "retell_text_mode" });
    expect(text.lines).toContain("lane: Text");

    // A kind this build has no lane word for is called what the platform calls
    // it, never a lane it is not.
    const other = await followedRun({ connectionType: "livekit_room" });
    expect(other.lines).toContain("lane: Fixture");
  });

  it("refuses to guess between runnable agents and prints each exact choice", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
      },
      {
        id: "agt_two",
        name: "After hours",
        connections: [{ id: "con_two", name: "Chat", modality: "chat" }],
      },
    ]);

    const answer = await followedRun({});

    expect(answer.code).toBe(1);
    expect(answer.startedWith).toBeNull();
    expect(answer.lines).toContain("agent-option: agt_one Receptionist");
    expect(answer.lines).toContain("agent-option: agt_two After hours");
    expect(answer.lines).toContain("status: unchosen-agent");
    expect(answer.lines).toContain(
      "stderr: This folder names 2 agents that can run. Choose one with --agent <name-or-id>. Nothing was started.",
    );
  });

  it("refuses to guess between one agent's connections", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [
          { id: "con_one", name: "Primary", modality: "voice" },
          { id: "con_two", name: "Primary", modality: "chat" },
        ],
      },
    ]);

    const answer = await followedRun({});

    expect(answer.code).toBe(1);
    expect(answer.startedWith).toBeNull();
    expect(answer.lines).toContain("connection-option: con_one Primary (Voice)");
    expect(answer.lines).toContain("connection-option: con_two Primary (Chat)");
    expect(answer.lines).toContain("status: unchosen-connection");
    expect(answer.lines).toContain(
      'stderr: Agent "Receptionist" has 2 connections. Choose one with --connection <name-or-id>. Nothing was started.',
    );
  });

  it("does not select a connection that belongs to another agent", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
      },
      {
        id: "agt_two",
        name: "After hours",
        connections: [{ id: "con_two", name: "Chat", modality: "chat" }],
      },
    ]);

    const answer = await followedRun({ agent: "Receptionist", connection: "con_two" });

    expect(answer.code).toBe(1);
    expect(answer.startedWith).toBeNull();
    expect(answer.lines).toContain("connection-option: con_one Phone (Voice)");
    expect(answer.lines).not.toContain("connection-option: con_two Chat (Chat)");
    expect(answer.lines).toContain("status: unknown-connection");
  });

  it("requires a stable id when an exact name is not unique", async () => {
    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Primary", modality: "voice" }],
      },
      {
        id: "agt_two",
        name: "Receptionist",
        connections: [{ id: "con_two", name: "Primary", modality: "chat" }],
      },
    ]);

    const agent = await followedRun({ agent: "Receptionist" });

    expect(agent.code).toBe(1);
    expect(agent.startedWith).toBeNull();
    expect(agent.lines).toContain("status: ambiguous-agent");
    expect(agent.lines).toContain("agent-option: agt_one Receptionist");
    expect(agent.lines).toContain("agent-option: agt_two Receptionist");

    await writeTargets([
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [
          { id: "con_one", name: "Primary", modality: "voice" },
          { id: "con_two", name: "Primary", modality: "chat" },
        ],
      },
    ]);
    const connection = await followedRun({ connection: "Primary" });

    expect(connection.code).toBe(1);
    expect(connection.startedWith).toBeNull();
    expect(connection.lines).toContain("status: ambiguous-connection");
    expect(connection.lines).toContain("connection-option: con_one Primary (Voice)");
    expect(connection.lines).toContain("connection-option: con_two Primary (Chat)");
  });

  it("ignores monitoring-only agents when one runnable target remains", async () => {
    await writeTargets([
      { id: "agt_monitoring", name: "Production only", connections: [] },
      {
        id: "agt_one",
        name: "Receptionist",
        connections: [{ id: "con_one", name: "Phone", modality: "voice" }],
      },
    ]);

    const answer = await followedRun({});

    expect(answer.code).toBe(0);
    expect(answer.startedWith).toMatchObject({
      agentId: "agt_one",
      connectionId: "con_one",
    });
  });

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
