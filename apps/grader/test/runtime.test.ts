import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendSpans,
  createCustomLlmGrader,
  editGraderDefinition,
  archiveProjectGrader,
  claimGradingJobs,
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  editProjectGrader,
  finishGradingJob,
  MAXIMUM_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
  readTraceGrades,
  readProductionGradingPlan,
  readTraceGrading,
  reconcileGraderCatalog,
  regradeTrace,
  requestGrading,
  releaseGradingJob,
  useGraderInProject,
  type AuthContext,
  type NewSpan,
} from "@egma/db";

import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../packages/db/test/support/clickhouse.ts";
import { seedOrganization, seedUser } from "../../../packages/db/test/support/tenancy.ts";
import { gradeClaim } from "../src/grade.ts";
import { scriptedJudge, met } from "./support/scripted-judge.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;

const organizationId = newId("org");
const projectId = newId("prj");
const userId = newId("usr");
const traceId = "5555555555555555555555555555eeee";
const startedAt = new Date("2026-08-21T10:00:00.000Z");
const rootSpanId = "1111111111111111";
let projectGraderId = "";

const auth: AuthContext = {
  organizationId,
  projectId,
  userId,
  role: "member",
  via: "session",
};

function span(): NewSpan {
  return {
    traceId,
    spanId: rootSpanId,
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "production",
    startedAtMicroseconds: BigInt(startedAt.getTime()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "conversation",
    kind: "conversation",
    status: "ok",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "call-fixture",
    agentPlatform: "retell",
    platformAgentId: "agent-fixture",
    platformAgentName: "Front desk",
    platformAgentVersion: "",
    connectionType: "phone_number",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: true,
  };
}

function responseLatencySpan(): NewSpan {
  return {
    ...span(),
    spanId: "2222222222222222",
    parentSpanId: rootSpanId,
    name: "turn_response_latency",
    kind: "timing",
    durationNanoseconds: 2_000_000_000n,
    endsTrace: false,
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("grader_runtime_target");
  store = await createMigratedTraceStore("grader_runtime_target");
  connect({
    databaseUrl: database.url,
    encryptionKey: TEST_ENCRYPTION_KEY,
    maxConnections: 4,
  });
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, userId, "grader-worker@example.com");
  await reconcileGraderCatalog();
  const used = await useGraderInProject(
    auth,
    PREDEFINED_GRADERS.responseLatency,
    {
      scope: {
        simulations: [],
        production: { sample_percent: 100 },
      },
      parameterValues: {
        [MAXIMUM_RESPONSE_TIME_PARAMETER]: 3_000,
      },
      passThreshold: 1,
    },
  );
  if (used === undefined) {
    throw new Error("Response latency is not in the library");
  }
  projectGraderId = used.id;
  await appendSpans(auth, [span(), responseLatencySpan()]);
});

afterAll(async () => {
  await disconnectClickHouse();
  await disconnect();
  await store.drop();
  await database.drop();
});

describe("the worker consumes one frozen trace plan", () => {
  it("grades Response latency and keeps the selected settings through edits and regrading", async () => {
    await requestGrading(auth, {
      source: "production",
      traceId,
      traceStartedAt: startedAt,
      endsTrace: true,
      evidenceReady: true,
      modality: "voice",
    });
    const [claim] = await claimGradingJobs({
      claimant: "grader-runtime-test",
      capacity: 50,
    });
    if (claim === undefined) throw new Error("the production trace was not claimed");

    expect(claim.entries).toMatchObject([{
      projectGraderId,
      graderDefinitionId: PREDEFINED_GRADERS.responseLatency,
      graderPassThreshold: 1,
      parameterValues: {
        [MAXIMUM_RESPONSE_TIME_PARAMETER]: 3_000,
      },
      definition: { type: "code" },
    }]);

    await editProjectGrader(auth, projectGraderId, {
      parameterValues: {
        [MAXIMUM_RESPONSE_TIME_PARAMETER]: 1_000,
      },
    });

    await expect(gradeClaim(claim, {
      providerCredentials: {
        async load() {
          throw new Error("a code-only plan must not load model credentials");
        },
      },
    })).resolves.toEqual({
      source: "production",
      traceId,
      graders: 1,
      grades: 1,
    });

    const read = await readTraceGrades(auth, { source: "production", traceId });
    expect(read.current).toMatchObject([{
      projectGraderId,
      graderDefinitionId: PREDEFINED_GRADERS.responseLatency,
      score: 1,
      graderPassThreshold: 1,
      gradingSequence: claim.sequenceBase + claim.attempts,
      result: "passed",
      details: {
        observedP90ResponseTimeMs: 2_000,
        maximumResponseTimeMs: 3_000,
      },
    }]);

    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
    await expect(readTraceGrading(auth, { source: "production", traceId }))
      .resolves.toMatchObject({
        state: "complete",
        combinedScore: 1,
        current: [{
          graderName: "Response latency", result: "passed",
          parameterValues: { maximum_response_time_ms: 3_000 },
        }],
      });

    await expect(regradeTrace(auth, { source: "production", traceId }))
      .resolves.toMatchObject({ kind: "queued", reopened: true });
    const [regrade] = await claimGradingJobs({
      claimant: "grader-runtime-regrade-test",
      capacity: 50,
    });
    if (regrade === undefined) throw new Error("the regrade was not claimed");
    expect(regrade.entries).toMatchObject([{
      projectGraderId,
      parameterValues: {
        [MAXIMUM_RESPONSE_TIME_PARAMETER]: 3_000,
      },
    }]);
    await gradeClaim(regrade, {
      providerCredentials: {
        async load() {
          throw new Error("a code-only plan must not load model credentials");
        },
      },
    });
    await finishGradingJob(regrade.auth, regrade.id, regrade.claimedBy);

    const afterRegrade = await readTraceGrades(auth, {
      source: "production",
      traceId,
    });
    expect(afterRegrade.history).toHaveLength(2);
    expect(afterRegrade.history.map((grade) => grade.score)).toEqual([1, 1]);
    expect(afterRegrade.current).toMatchObject([{
      score: 1,
      details: { maximumResponseTimeMs: 3_000 },
    }]);
  });
});

describe("a frozen LLM model and core", () => {
  it("uses the original production selection after edits and retries, then uses new choices for a new trace", async () => {
    const custom = await createCustomLlmGrader(auth, {
      name: "Frozen politeness", gradingInstructions: "The agent is polite", passesWhen: "Polite", failsWhen: "Rude",
      parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
      scope: { simulations: [], production: { sample_percent: 100 } }, passThreshold: 0.8,
    });
    const firstTrace = "6666666666666666666666666666eeee";
    const laterTrace = "7777777777777777777777777777eeee";
    async function select(traceId: string) {
      await appendSpans(auth, [
        { ...span(), traceId },
        { ...span(), traceId, spanId: "3333333333333333", parentSpanId: rootSpanId, kind: "turn:agent", text: "Thank you. I can help.", endsTrace: false },
      ]);
      await requestGrading(auth, { source: "production", traceId, traceStartedAt: startedAt, endsTrace: true, evidenceReady: true, modality: "voice" });
    }
    await select(firstTrace);
    await editProjectGrader(auth, custom.projectGrader.id, { parameterValues: { llm_provider: "openai", llm_model: "gpt-5.6-terra" }, passThreshold: 0.9 });
    await editGraderDefinition(auth, custom.definition.id, { baseDefinitionVersion: 1, gradingInstructions: "The agent is calm and clear." });
    const [first] = await claimGradingJobs({ claimant: "model-before-edit", capacity: 1 });
    if (!first) throw new Error("missing selected production work");
    expect(first.entries.find((entry) => entry.projectGraderId === custom.projectGrader.id)).toMatchObject({
      graderDefinitionVersion: 1, graderPassThreshold: 0.8,
      parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
      definition: { prompt: custom.definition.gradingInstructions },
    });
    const scripted = scriptedJudge({ answers: {}, otherwise: met("Polite.", [1]) });
    const options = { providerCredentials: { load: async () => ({ openai: "fixture-key" }) }, makers: scripted.makers };
    await gradeClaim(first, options);
    await releaseGradingJob(first.auth, first.id, first.claimedBy, "retry the frozen job");
    const [retry] = await claimGradingJobs({ claimant: "model-retry", capacity: 1 });
    if (!retry) throw new Error("missing retried production work");
    expect(retry.entries).toEqual(first.entries);
    await gradeClaim(retry, options);
    await finishGradingJob(retry.auth, retry.id, retry.claimedBy);
    expect(scripted.configured.map((model) => model.model)).toEqual(["gpt-4o-mini", "gpt-4o-mini"]);
    expect(scripted.asked).toHaveLength(2);
    expect(scripted.asked.every((question) => question.criterion === custom.definition.gradingInstructions && question.expectedBehaviors.length === 0)).toBe(true);
    expect((await readTraceGrades(auth, { source: "production", traceId: firstTrace })).current).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectGraderId: custom.projectGrader.id, score: 1, graderDefinitionVersion: 1, graderPassThreshold: 0.8, parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" } }),
    ]));
    expect((await readProductionGradingPlan(auth, firstTrace))?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectGraderId: custom.projectGrader.id, parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" }, graderDefinitionVersion: 1, graderPassThreshold: 0.8 }),
    ]));
    await select(laterTrace);
    await archiveProjectGrader(auth, custom.projectGrader.id);
    const [later] = await claimGradingJobs({ claimant: "model-after-edit", capacity: 1 });
    if (!later) throw new Error("missing later production work");
    expect(later.entries.find((entry) => entry.projectGraderId === custom.projectGrader.id)).toMatchObject({
      graderDefinitionVersion: 2, graderPassThreshold: 0.9,
      parameterValues: { llm_provider: "openai", llm_model: "gpt-5.6-terra" },
      definition: { prompt: "The agent is calm and clear." },
    });
    const failedProvider = scriptedJudge({ answers: {}, otherwise: new Error("the selected provider failed") });
    await gradeClaim(later, { ...options, makers: failedProvider.makers });
    await finishGradingJob(later.auth, later.id, later.claimedBy);
    expect(failedProvider.configured.at(-1)?.model).toBe("gpt-5.6-terra");
    expect((await readTraceGrades(auth, { source: "production", traceId: laterTrace })).current).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectGraderId: custom.projectGrader.id, score: null, graderDefinitionVersion: 2, graderPassThreshold: 0.9, parameterValues: { llm_provider: "openai", llm_model: "gpt-5.6-terra" }, details: { error: expect.stringContaining("the selected provider failed") } }),
    ]));
  });
});
