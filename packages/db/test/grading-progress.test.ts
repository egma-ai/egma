import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  finishGradingJob,
  reconcileGraderCatalog,
  releaseGradingJob,
  requestGrading,
  startRun,
  startSimulation,
  type AuthContext,
  type GradingClaim,
  type NewSpan,
  type SimulationClaim,
} from "../src/index.ts";

import {
  readRunGradingProgress,
  readSimulationGradingStates,
} from "../src/access/grading.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import {
  seedOrganization,
  seedUser,
} from "./support/tenancy.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;

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

const SIMULATOR = "progress-simulator";

function simulationSpan(
  claim: SimulationClaim,
  traceId: string,
  startedAtMicroseconds: bigint,
): NewSpan {
  return {
    traceId,
    spanId: "1111111111111111",
    parentSpanId: "",
    source: "simulation",
    emitter: "egma-runtime",
    environment: "default",
    startedAtMicroseconds,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_turn",
    kind: "turn:agent",
    status: "ok",
    text: "Friday works.",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    agentPlatform: "retell",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionKind: "retell_chat_api",
    runId: claim.runId,
    agentId: claim.agentId,
    agentVersionId: "",
    testVersionId: claim.testVersionId,
    personaVersionId: claim.personaVersionId,
    payload: "{}",
  };
}

async function ownClaims(runId: string): Promise<readonly SimulationClaim[]> {
  return (await claimSimulations({ claimant: SIMULATOR, capacity: 50 }))
    .filter((claim) => claim.runId === runId);
}

async function gradingClaim(traceId: string): Promise<GradingClaim> {
  const claim = (await claimGradingJobs({
    claimant: `progress-grader-${traceId.slice(-6)}`,
    capacity: 50,
  })).find((one) => one.traceId === traceId);
  if (claim === undefined) throw new Error(`trace ${traceId} was not claimed`);
  return claim;
}

async function requestSimulationGrade(claim: SimulationClaim): Promise<string> {
  const traceId = traceIdOfSimulation(claim.id);
  if (traceId === undefined) throw new Error(`${claim.id} has no trace identity`);
  const { rows } = await database.sql<{ started_at: Date }>(
    "select started_at from simulation where id = $1",
    [claim.id],
  );
  const startedAt = rows[0]?.started_at;
  if (startedAt === undefined) throw new Error(`${claim.id} has no start time`);
  await requestGrading(auth, {
    source: "simulation",
    traceId,
    traceStartedAt: startedAt,
    runId: claim.runId,
    endsTrace: false,
    evidenceReady: true,
    modality: "chat",
  });
  return traceId;
}

async function appendSuccess(claim: GradingClaim): Promise<void> {
  const entry = claim.entries[0];
  if (entry === undefined) throw new Error(`${claim.id} has no grader`);
  await appendGrades(claim.auth, [{
    source: "simulation",
    traceId: claim.traceId,
    traceStartedAtMicroseconds: BigInt(claim.traceStartedAt.getTime()) * 1_000n,
    runId: claim.runId ?? "",
    projectGraderId: entry.projectGraderId,
    graderDefinitionId: entry.graderDefinitionId,
    graderDefinitionVersion: entry.graderDefinitionVersion,
    score: 1,
    details: { rationale: "met" },
    graderPassThreshold: entry.graderPassThreshold,
    gradedAtMicroseconds: BigInt(Date.now()) * 1_000n,
  }]);
}

beforeAll(async () => {
  database = await createConnectedDatabase("grading_progress");
  store = await createMigratedTraceStore("grading_progress");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 3 });

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, userId, "grading-progress@example.com");
  await reconcileGraderCatalog();
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

describe("run grading progress", () => {
  it("counts gradable completed traces and only terminal grading states", async () => {
    const created = await createAgent(auth, {
      name: "Front desk",
      connection: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_progress" },
        credentials: { apiKey: "retell-progress-secret-A1B2C3D4" },
      },
    });
    const firstPersona = await createPersona(auth, {
      name: "Rita",
      traits: { personality: "Patient", language: "en-US" },
    });
    const secondPersona = await createPersona(auth, {
      name: "Sam",
      traits: { personality: "Direct", language: "en-US" },
    });
    const suite = await createTestSuite(auth, { name: "Progress" });
    await createTest(auth, {
      suiteId: suite.id,
      name: "Reschedule",
      scenario: "Move a booking to Friday.",
      expectedBehaviors: ["confirms Friday"],
      personaIds: [firstPersona.id, secondPersona.id],
    });
    const run = await startRun(auth, {
      suiteId: suite.id,
      agentId: created.id,
      connectionId: created.connection?.id ?? "",
      idempotencyKey: newId("run"),
    });
    const claims = await ownClaims(run.id);
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      await startSimulation(auth, claim.id, SIMULATOR);
      await completeSimulation(auth, claim.id, SIMULATOR, {
        endingReason: "agent_ended",
      });
    }

    await expect(readRunGradingProgress(auth, [run.id])).resolves.toEqual([{
      runId: run.id,
      gradable: 2,
      graded: 0,
    }]);
    await expect(readSimulationGradingStates(auth, claims.map((claim) => ({
      simulationId: claim.id,
      runId: claim.runId,
    })))).resolves.toEqual(claims.map((claim) => ({
      simulationId: claim.id,
      state: "pending",
    })));

    const firstTrace = await requestSimulationGrade(claims[0]!);
    const firstGrade = await gradingClaim(firstTrace);
    await appendSuccess(firstGrade);
    await finishGradingJob(firstGrade.auth, firstGrade.id, firstGrade.claimedBy);
    await expect(readRunGradingProgress(auth, [run.id])).resolves.toEqual([{
      runId: run.id,
      gradable: 2,
      graded: 1,
    }]);
    await expect(readSimulationGradingStates(auth, claims.map((claim) => ({
      simulationId: claim.id,
      runId: claim.runId,
    })))).resolves.toEqual([
      { simulationId: claims[0]!.id, state: "complete" },
      { simulationId: claims[1]!.id, state: "pending" },
    ]);

    const secondTrace = await requestSimulationGrade(claims[1]!);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await gradingClaim(secondTrace);
      await releaseGradingJob(
        failed.auth,
        failed.id,
        failed.claimedBy,
        `failed ${attempt + 1}`,
      );
    }
    await expect(readRunGradingProgress(auth, [run.id])).resolves.toEqual([{
      runId: run.id,
      gradable: 2,
      graded: 2,
    }]);
    await expect(readSimulationGradingStates(auth, claims.map((claim) => ({
      simulationId: claim.id,
      runId: claim.runId,
    })))).resolves.toEqual([
      { simulationId: claims[0]!.id, state: "complete" },
      { simulationId: claims[1]!.id, state: "error" },
    ]);
  });

  it("freezes the provider span time when it precedes the simulation clock", async () => {
    const created = await createAgent(auth, {
      name: "Skewed provider clock",
      connection: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_skewed_clock" },
        credentials: { apiKey: "retell-skewed-clock-secret-A1B2C3D4" },
      },
    });
    const persona = await createPersona(auth, {
      name: "Tess",
      traits: { personality: "Patient", language: "en-US" },
    });
    const suite = await createTestSuite(auth, { name: "Provider clock skew" });
    await createTest(auth, {
      suiteId: suite.id,
      name: "Book Friday",
      scenario: "Book an appointment on Friday.",
      expectedBehaviors: ["confirms Friday"],
      personaIds: [persona.id],
    });
    const run = await startRun(auth, {
      suiteId: suite.id,
      agentId: created.id,
      connectionId: created.connection?.id ?? "",
      idempotencyKey: newId("run"),
    });
    const [claim] = await ownClaims(run.id);
    if (claim === undefined) throw new Error(`${run.id} has no simulation`);
    await startSimulation(auth, claim.id, SIMULATOR);

    const { rows } = await database.sql<{ started_at: Date }>(
      "select started_at from simulation where id = $1",
      [claim.id],
    );
    const simulationStartedAt = rows[0]?.started_at;
    if (simulationStartedAt === undefined) {
      throw new Error(`${claim.id} has no start time`);
    }
    const traceId = traceIdOfSimulation(claim.id);
    if (traceId === undefined) {
      throw new Error(`${claim.id} has no trace identity`);
    }
    const providerStartedAt = new Date(
      simulationStartedAt.getTime() - 2 * 60 * 1_000,
    );
    await appendSpans(auth, [
      simulationSpan(
        claim,
        traceId,
        BigInt(providerStartedAt.getTime()) * 1_000n,
      ),
    ]);

    await completeSimulation(auth, claim.id, SIMULATOR, {
      endingReason: "agent_ended",
    });

    const queued = await gradingClaim(traceId);
    expect(queued.traceStartedAt).toEqual(providerStartedAt);
    await appendSuccess(queued);
    await finishGradingJob(queued.auth, queued.id, queued.claimedBy);
  });
});
