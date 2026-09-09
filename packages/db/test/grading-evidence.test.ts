import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appendGrades,
  appendSpans,
  claimGradingJobs,
  claimSimulations,
  completeSimulation,
  connectClickHouse,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  disconnectClickHouse,
  getGradingJobForTrace,
  pinnedSimulationGraders,
  readTraceGrading,
  reconcileGraderCatalog,
  recordSimulationTraces,
  regradeTrace,
  resolveRunStartReach,
  settleSimulationsPastTheAgentPovBound,
  startRun,
  startSimulation,
  type AuthContext,
  type NewSpan,
  type SimulationClaim,
} from "../src/index.ts";
import { simulationEvidenceReadiness } from "../src/access/grading.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;
let suiteId: string;

const organizationId = newId("org");
const projectId = newId("prj");
const userId = newId("usr");
const auth: AuthContext = {
  organizationId,
  projectId,
  userId,
  role: "member",
  via: "session",
};
const SIMULATOR = "final-evidence-simulator";
type Platform = "livekit" | "retell";

type CompletedConversation = {
  readonly claim: SimulationClaim;
  readonly traceId: string;
  readonly completedAt: Date;
  readonly span: NewSpan;
};

async function completedConversation(
  platform: Platform,
  reportedEndOffsetMilliseconds = 0,
): Promise<CompletedConversation> {
  const name = `${platform}-${newId("agt")}`;
  const created = await createAgent(auth, {
    agentPlatform: platform,
    name,
    connection: platform === "livekit"
      ? {
          agentPlatform: "livekit",
          connectionType: "livekit_room",
          accessVariant: "livekit_room.project_credentials",
          modality: "voice",
          config: { url: "wss://evidence.livekit.cloud", agentName: name },
          credentials: { apiKey: "livekit-key-A1B2C3D4", apiSecret: "livekit-secret-A1B2C3D4" },
        }
      : {
          agentPlatform: "retell",
          connectionType: "retell_web_call",
          accessVariant: "retell_web_call.api_key",
          modality: "voice",
          config: { retellAgentId: name },
          credentials: { apiKey: "retell-secret-A1B2C3D4" },
        },
  });
  const connectionId = created.connection?.id ?? "";
  const reach = platform === "retell"
    ? await resolveRunStartReach(auth, created.id, connectionId)
    : undefined;
  const started = await startRun(auth, {
    suiteId,
    agentId: created.id,
    connectionId,
    ...(reach === undefined ? {} : {
      agentVersion: 1,
      conductedConnectionIdentity: reach.connectionIdentity,
    }),
  });
  const claim = (await claimSimulations({ claimant: SIMULATOR, capacity: 50 }))
    .find((one) => one.runId === started.id);
  if (claim === undefined) throw new Error("the conversation was not claimed");
  const traceId = traceIdOfSimulation(claim.id);
  if (traceId === undefined) throw new Error("the conversation has no trace id");
  await startSimulation(auth, claim.id, SIMULATOR);
  const completedAt = new Date();
  const span: NewSpan = {
    traceId,
    spanId: "1111111111111111",
    parentSpanId: "",
    source: "simulation",
    emitter: "egma-runtime",
    environment: "default",
    startedAtMicroseconds: BigInt(completedAt.getTime()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_turn",
    kind: "turn:agent",
    status: "ok",
    text: "Your booking is confirmed.",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: name,
    agentPlatform: platform,
    platformAgentId: name,
    platformAgentName: name,
    platformAgentVersion: "1",
    connectionType: platform === "livekit" ? "livekit_room" : "retell_web_call",
    runId: claim.runId,
    agentId: claim.agentId,
    agentVersionId: "",
    testVersionId: claim.testVersionId,
    personaVersionId: claim.personaVersionId,
    payload: "{}",
    endsTrace: false,
  };
  await appendSpans(auth, [span]);
  await completeSimulation(auth, claim.id, SIMULATOR, {
    endingReason: "agent_ended",
    providerReference: name,
    endedAt: new Date(completedAt.getTime() + reportedEndOffsetMilliseconds),
    ...(reportedEndOffsetMilliseconds >= 0 ? {} : {
      startedAt: new Date(completedAt.getTime() + reportedEndOffsetMilliseconds - 1_000),
    }),
  });
  return { claim, traceId, completedAt, span };
}

function finalEvidence(conversation: CompletedConversation): NewSpan {
  return {
    ...conversation.span,
    spanId: "2222222222222222",
    emitter: "agent",
    kind: conversation.span.agentPlatform === "livekit" ? "root" : "conversation",
    name: conversation.span.agentPlatform === "livekit" ? "agent_session" : "retell_call",
    payload: JSON.stringify({
      call_status: "ended",
      end_timestamp: conversation.completedAt.getTime(),
      egma_normalised: { degraded: false },
    }),
  };
}

function afterCompletion(conversation: CompletedConversation, milliseconds: number): void {
  vi.setSystemTime(new Date(conversation.completedAt.getTime() + milliseconds));
}

async function readiness(conversation: CompletedConversation) {
  return simulationEvidenceReadiness(auth, {
    traceId: conversation.traceId,
    runId: conversation.claim.runId,
    window: {
      from: BigInt(conversation.completedAt.getTime() - 1_000) * 1_000n,
      to: BigInt(Date.now() + 1_000) * 1_000n,
    },
    producesAnAgentPov: true,
    completedAt: conversation.completedAt,
  });
}

beforeAll(async () => {
  database = await createConnectedDatabase("grading_evidence");
  store = await createMigratedTraceStore("grading_evidence");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 3 });
  await seedOrganization(database, organizationId, [{ id: projectId, slug: "default" }]);
  await seedUser(database, userId, "grading-evidence@example.com");
  await reconcileGraderCatalog();
  const persona = await createPersona(auth, {
    name: "Rita",
    identityName: "Rita Alvarez",
    personality: "Patient",
    language: "en-US",
  });
  suiteId = (await createTestSuite(auth, { name: "Final evidence" })).id;
  await createTest(auth, {
    suiteId,
    name: "Confirm booking",
    scenario: "Confirm a booking.",
    expectedBehaviors: ["confirms the booking"],
    personaIds: [persona.id],
  });
});

afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

describe.each<Platform>(["livekit", "retell"])("%s final evidence", (platform) => {
  it("keeps grading pending past thirty seconds and queues when the final record arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversation = await completedConversation(platform);
    const ref = { source: "simulation" as const, traceId: conversation.traceId, runId: conversation.claim.runId };
    const partial: NewSpan = {
      ...finalEvidence(conversation),
      spanId: "3333333333333333",
      name: platform === "livekit" ? "agent_turn" : "retell_call",
      kind: platform === "livekit" ? "turn:agent" : "conversation",
      payload: JSON.stringify({ call_status: "ongoing", egma_normalised: { degraded: true } }),
    };
    await appendSpans(auth, [partial]);
    for (const milliseconds of [30_000, 60_000, 180_000, 240_000, 244_999]) {
      afterCompletion(conversation, milliseconds);
      await expect(readiness(conversation)).resolves.toMatchObject({ ready: false, agentPovFiled: false });
      await recordSimulationTraces(auth, [conversation.span]);
      await settleSimulationsPastTheAgentPovBound();
      expect(await getGradingJobForTrace(auth, conversation.traceId)).toBeUndefined();
      await expect(readTraceGrading(auth, ref)).resolves.toMatchObject({ state: "pending", current: [] });
      await expect(regradeTrace(auth, ref)).resolves.toEqual({ kind: "waiting", for: "evidence" });
      expect(await getGradingJobForTrace(auth, conversation.traceId)).toBeUndefined();
    }

    const final = finalEvidence(conversation);
    await appendSpans(auth, [final]);
    await recordSimulationTraces(auth, [final]);
    await expect(readiness(conversation)).resolves.toMatchObject({ ready: true, agentPovFiled: true });
    const job = await getGradingJobForTrace(auth, conversation.traceId);
    expect(job).toMatchObject({ status: "pending", attempts: 0 });
    await recordSimulationTraces(auth, [final]);
    expect((await getGradingJobForTrace(auth, conversation.traceId))?.id).toBe(job?.id);
  });

  it("files an evidence error at 245 seconds without model work and allows regrading after late final evidence arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversation = await completedConversation(platform);
    const ref = { source: "simulation" as const, traceId: conversation.traceId, runId: conversation.claim.runId };
    afterCompletion(conversation, 245_000);
    const settled = await settleSimulationsPastTheAgentPovBound();
    expect(settled).toContainEqual({
      id: conversation.claim.id,
      runId: conversation.claim.runId,
      agentPovFiled: false,
      outcome: "evidence_error",
    });
    const terminal = await getGradingJobForTrace(auth, conversation.traceId);
    expect(terminal).toMatchObject({
      status: "abandoned",
      attempts: 0,
      lastError: "evidence_collection_error",
    });
    expect(
      (await claimGradingJobs({
        claimant: "final-evidence-grader",
        capacity: 50,
      })).map(({ traceId }) => traceId),
    ).not.toContain(conversation.traceId);
    await expect(readTraceGrading(auth, ref)).resolves.toMatchObject({
      state: "error",
      evidenceError: {
        error: "evidence_collection_error",
        message: expect.stringContaining("complete evidence"),
      },
      current: [],
      history: [],
    });
    expect(await settleSimulationsPastTheAgentPovBound()).toEqual([]);
    expect((await getGradingJobForTrace(auth, conversation.traceId))?.id)
      .toBe(terminal?.id);
    await expect(regradeTrace(auth, ref)).resolves.toEqual({
      kind: "waiting",
      for: "evidence",
    });
    expect(await getGradingJobForTrace(auth, conversation.traceId)).toMatchObject({
      status: "abandoned",
      attempts: 0,
    });

    afterCompletion(conversation, 300_000);
    const final = finalEvidence(conversation);
    await appendSpans(auth, [final]);
    await recordSimulationTraces(auth, [final]);
    await expect(readiness(conversation)).resolves.toMatchObject({ ready: true, agentPovFiled: true });
    expect(await getGradingJobForTrace(auth, conversation.traceId)).toMatchObject({
      status: "abandoned",
      attempts: 0,
    });
    await expect(readTraceGrading(auth, ref)).resolves.toMatchObject({ state: "error" });
    await expect(regradeTrace(auth, ref)).resolves.toMatchObject({ kind: "queued", reopened: true, alreadyWaiting: false });
    expect(await getGradingJobForTrace(auth, conversation.traceId)).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    expect((await readTraceGrading(auth, ref))?.history).toEqual([]);
  });

  it("never replaces a successful grade with an evidence error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversation = await completedConversation(platform);
    const [entry] = await pinnedSimulationGraders(auth, conversation.claim.id) ?? [];
    if (entry === undefined) throw new Error("the simulation has no pinned grader");
    await appendGrades(auth, [{
      source: "simulation",
      traceId: conversation.traceId,
      traceStartedAtMicroseconds: conversation.span.startedAtMicroseconds,
      runId: conversation.claim.runId,
      projectGraderId: entry.projectGraderId,
      graderDefinitionId: entry.definition.definitionId,
      graderDefinitionVersion: entry.definition.definitionVersion,
      parameterValues: entry.parameterValues,
      graderPassThreshold: entry.passThreshold,
      gradingSequence: 1,
      gradedAtMicroseconds: BigInt(Date.now()) * 1_000n,
      score: 1,
      details: { rationale: "The expected behavior passed." },
    }]);

    afterCompletion(conversation, 245_000);
    expect(await settleSimulationsPastTheAgentPovBound()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: conversation.claim.id }),
      ]),
    );
    await expect(readTraceGrading(auth, {
      source: "simulation",
      traceId: conversation.traceId,
      runId: conversation.claim.runId,
    })).resolves.toMatchObject({
      state: "complete",
      current: [{ score: 1 }],
    });
  });

  it.each([-3_600_000, 3_600_000])("uses the full server wait when the reported end is offset by %i ms", async (offset) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversation = await completedConversation(platform, offset);
    afterCompletion(conversation, 244_999);
    await recordSimulationTraces(auth, [conversation.span]);
    await settleSimulationsPastTheAgentPovBound();
    expect(await getGradingJobForTrace(auth, conversation.traceId)).toBeUndefined();
    await expect(regradeTrace(auth, {
      source: "simulation",
      traceId: conversation.traceId,
      runId: conversation.claim.runId,
    })).resolves.toEqual({ kind: "waiting", for: "evidence" });
    afterCompletion(conversation, 245_000);
    expect(await settleSimulationsPastTheAgentPovBound()).toContainEqual({
      id: conversation.claim.id,
      runId: conversation.claim.runId,
      agentPovFiled: false,
      outcome: "evidence_error",
    });
  });
});

it("does not treat a Retell root or duplicate span IDs as a complete record", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const conversation = await completedConversation("retell");
  const root = {
    ...finalEvidence(conversation),
    payload: JSON.stringify({
      end_timestamp: conversation.completedAt.getTime(),
      egma_normalised: { degraded: false, expected_span_count: 3 },
    }),
  };

  await appendSpans(auth, [root, root]);
  await expect(readiness(conversation)).resolves.toMatchObject({
    ready: false,
    agentPovFiled: false,
  });
  await recordSimulationTraces(auth, [root]);
  expect(await getGradingJobForTrace(auth, conversation.traceId)).toBeUndefined();

  await appendSpans(auth, [
    { ...conversation.span, spanId: "3333333333333333", emitter: "agent" },
    { ...conversation.span, spanId: "4444444444444444", emitter: "agent" },
  ]);
  await expect(readiness(conversation)).resolves.toMatchObject({
    ready: true,
    agentPovFiled: true,
  });
});
