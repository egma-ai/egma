import {
  appendGrades,
  claimGradingJobs,
  finishGradingJob,
  getGradingJobForTrace,
  getSimulation as getStoredSimulation,
  PREDEFINED_GRADERS,
  requestGrading,
} from "@egma/db";
import { getSimulation } from "@egma/platform-api/client";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { platformClient } from "../../cli/src/platform/client.ts";
import type { Fetch } from "../../cli/src/platform/device-flow.ts";
import { listProjectPersonas } from "../../cli/src/platform/personas.ts";
import {
  applyRepositoryChangeSet,
} from "../../cli/src/platform/repository.ts";
import {
  listRunSimulations,
  startRun,
} from "../../cli/src/platform/runs.ts";
import type { SignedIn } from "../../cli/src/platform/signed-in.ts";
import { createTestSuite } from "../../cli/src/platform/test-suites.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { landOneConversationOf } from "./support/recordings.ts";
import {
  contextFor,
  mintKey,
  request,
  signUp,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type WireCall = {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
};

/** The CLI's real fetch seam, answered by the real API in this process. */
function fetchThrough(app: FastifyInstance, calls: WireCall[]): Fetch {
  return async (input, init) => {
    const address = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({
      method: init?.method ?? "GET",
      path: `${address.pathname}${address.search}`,
      body,
    });

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const answered = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: `${address.pathname}${address.search}`,
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    });
    return new Response(answered.body, {
      status: answered.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the CLI and API suite contract", () => {
  it("starts a suite through the CLI and reads completed grades after job cleanup", async () => {
    api = await createApi("cli_api_suite_contract", { traceStore: true });
    const customer = await signUp(
      api.app,
      "cli-contract@acme.example",
      "Acme",
    );
    const key = await mintKey(
      api.app,
      customer.cookie,
      "the CLI contract",
      customer.projectId,
    );
    const signedIn: SignedIn = { url: "http://egma.test", key };
    const calls: WireCall[] = [];
    const fetchImpl = fetchThrough(api.app, calls);

    const personas = await listProjectPersonas(signedIn, customer.projectId, fetchImpl);
    expect(personas).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Everyday caller" })]));

    const suite = await createTestSuite(
      signedIn,
      { projectId: customer.projectId, name: "Release" },
      fetchImpl,
    );
    expect(suite).toMatchObject({
      projectId: customer.projectId,
      name: "Release",
    });
    expect(suite.id).toMatch(/^ste_/u);

    const applied = await applyRepositoryChangeSet(
      signedIn,
      {
        projectId: customer.projectId,
        suites: [{ id: suite.id, name: suite.name }],
        tests: [{
          clientRef: "egma/tests/release/books-a-visit.md",
          suiteId: suite.id,
          input: {
            name: "Books a visit",
            description: "The ordinary booking path.",
            scenario: "The caller asks for Tuesday.",
            expectedBehaviors: ["The agent books Tuesday."],
            // The CLI names its callers by name and the platform resolves
            // them, which is the path a real repository file takes. A test
            // names at least one persona from birth, so a push that named
            // none is refused rather than given the project's default.
            // A repository file that has only ever carried names carries an
            // empty id, and the CLI sends the name for the platform to
            // resolve. A test names at least one persona from birth, so a push
            // naming none is refused rather than given the project's default.
            personas: [{ id: "", name: "Everyday caller" }],
            // The world the test carries. A repository push names both on
            // every test, because the change set is the complete authored
            // state and a silent absence would be a field the push had no
            // opinion about.
            mockTools: [],
            env: null,
          },
          expectedVersionId: null,
          expectedRevision: null,
        }],
      },
      fetchImpl,
    );
    expect(applied.tests).toHaveLength(1);
    const pushed = applied.tests[0]?.test;
    if (pushed === undefined) throw new Error("the atomic push returned no test");
    expect(pushed).toMatchObject({
      suiteId: suite.id,
      name: "Books a visit",
      version: 1,
    });

    const selectedPersona = personas.find((one) => one.name === "Everyday caller");
    const currentPersona = await request(api.app, "GET", `/v1/personas/${selectedPersona?.id}`, key);
    expect(currentPersona.body.settings).toMatchObject({ id: expect.stringMatching(/^ppr_/u), models: expect.any(Object) });
    expect(pushed.personas).toEqual([{ id: selectedPersona?.id, name: "Everyday caller" }]);

    const registered = await request(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "livekit",
      name: "Front desk",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "chat",
        config: { url: "wss://cli-contract.livekit.cloud", agentName: "front-desk" },
        credentials: { apiKey: "APIcliContract1234", apiSecret: "livekit-secret-cli-contract" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const projectGraders = await request(api.app, "GET", "/v1/graders", key);
    const expectedGrader = (projectGraders.body.graders as { id: string; graderDefinitionId: string }[])
      .find((one) => one.graderDefinitionId === PREDEFINED_GRADERS.expectedBehaviors);
    if (expectedGrader === undefined) throw new Error("the project has no Expected behaviors grader");
    const selectedParameters = { llm_provider: "openai", llm_model: "gpt-4o-mini" };
    const settings = await request(api.app, "PATCH", `/v1/graders/${expectedGrader.id}`, key, {
      settings: selectedParameters,
      passThreshold: 0.8,
    });
    expect(settings.statusCode, JSON.stringify(settings.body)).toBe(200);

    const started = await startRun(
      signedIn,
      {
        projectId: customer.projectId,
        suiteId: suite.id,
        agentId,
        connectionId,
        expectedTestVersions: [{
          testId: pushed.id,
          versionId: pushed.versionId,
        }],
        name: "CLI release run",
      },
      fetchImpl,
    );
    if (started.kind !== "started") throw new Error(started.reason);
    expect(started.kind).toBe("started");
    expect(started.run).toMatchObject({
      agentId,
      connectionId,
      expectedSimulationCount: 1,
      simulations: [],
    });

    const simulations = await listRunSimulations(
      signedIn,
      started.run.id,
      fetchImpl,
    );
    expect(simulations).toEqual([
      expect.objectContaining({
        testVersionId: pushed.versionId,
        testName: "Books a visit",
        status: "queued",
      }),
    ]);

    const detail = await request(
      api.app,
      "GET",
      `/v1/runs/${started.run.id}`,
      key,
    );
    expect(detail.body).toMatchObject({
      suiteId: suite.id,
      suiteName: "Release",
      suiteDeleted: false,
      name: "CLI release run",
    });

    const auth = contextFor(customer, "admin");
    const simulationId = await landOneConversationOf(auth, started.run.id);
    const simulation = await getStoredSimulation(auth, simulationId);
    if (simulation?.startedAt === null || simulation?.startedAt === undefined) {
      throw new Error("the CLI simulation has no start time");
    }
    const traceId = traceIdOfSimulation(simulationId);
    if (traceId === undefined) throw new Error("the CLI simulation has no trace identity");
    await requestGrading(auth, {
      source: "simulation",
      traceId: traceId,
      traceStartedAt: simulation.startedAt,
      runId: started.run.id,
      endsTrace: false,
      evidenceReady: true,
      modality: "chat",
    });
    const claimant = "cli-platform-grader";
    const claim = (await claimGradingJobs({ claimant, capacity: 1 }))[0];
    if (claim === undefined) throw new Error("the CLI run has no grading claim");
    expect(claim.traceId).toBe(traceId);
    const entry = claim.entries[0];
    if (entry === undefined) throw new Error("the CLI run has no selected grader");
    expect(entry.parameterValues).toEqual(selectedParameters);

    // Later settings must not replace the settings retained by this result.
    const laterSettings = await request(api.app, "PATCH", `/v1/graders/${expectedGrader.id}`, key, {
      settings: { llm_provider: "openai", llm_model: "gpt-5.6-terra" },
      passThreshold: 1,
    });
    expect(laterSettings.statusCode, JSON.stringify(laterSettings.body)).toBe(200);
    await appendGrades(claim.auth, [{
      source: "simulation",
      traceId: claim.traceId,
      traceStartedAtMicroseconds: BigInt(claim.traceStartedAt.getTime()) * 1_000n,
      runId: started.run.id,
      projectGraderId: entry.projectGraderId,
      graderDefinitionId: entry.graderDefinitionId,
      graderDefinitionVersion: entry.graderDefinitionVersion,
      parameterValues: entry.parameterValues,
      score: 1,
      details: { rationale: "The agent booked Tuesday." },
      graderPassThreshold: entry.graderPassThreshold,
      gradingSequence: claim.sequenceBase + claim.attempts,
      gradedAtMicroseconds: BigInt(Date.now()) * 1_000n,
    }]);
    await finishGradingJob(claim.auth, claim.id, claimant);
    expect(await getGradingJobForTrace(auth, traceId)).toBeUndefined();

    expect(await listRunSimulations(signedIn, started.run.id, fetchImpl)).toEqual([
      expect.objectContaining({ id: simulationId, status: "completed", gradingState: "complete" }),
    ]);
    const result = await getSimulation({ simulationId }, {
      client: platformClient(signedIn, fetchImpl),
    });
    expect(result.response?.status).toBe(200);
    expect(result.data).toMatchObject({
      gradingState: "complete",
      combinedScore: 1,
      gradingPlan: {
        capturedAt: expect.any(String),
        items: [expect.objectContaining({ projectGraderId: entry.projectGraderId, passThreshold: 0.8 })],
      },
      grades: [expect.objectContaining({ parameterValues: selectedParameters, passThreshold: 0.8, result: "passed" })],
      gradeHistory: [expect.objectContaining({ parameterValues: selectedParameters })],
    });
    expect(result.data?.gradingPlan).not.toHaveProperty("state");

    const writes = calls.filter((call) => call.method === "POST");
    expect(writes.map((call) => call.path)).toEqual([
      `/v1/test-suites?projectId=${customer.projectId}`,
      `/v1/repository/change-set?projectId=${customer.projectId}`,
      `/v1/runs?projectId=${customer.projectId}`,
    ]);
    expect(writes[0]?.body).toEqual({
      name: "Release",
    });
    expect(writes[1]?.body).toMatchObject({
      suites: [{ id: suite.id, name: "Release" }],
      tests: [{
        clientRef: "egma/tests/release/books-a-visit.md",
        suiteId: suite.id,
        mockTools: [],
        env: null,
      }],
    });
    // The change set has no project-level list any more: mock tools belong to
    // the test that needs them.
    expect(writes[1]?.body).not.toHaveProperty("mockTools");
    expect(writes[2]?.body).toMatchObject({
      suiteId: suite.id,
      agentId: agentId,
      connectionId: connectionId,
      expectedTestVersions: [{
        testId: pushed.id,
        versionId: pushed.versionId,
      }],
      name: "CLI release run",
    });
  });
});
