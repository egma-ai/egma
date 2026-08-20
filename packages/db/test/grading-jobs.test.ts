import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelRun,
  claimGradingJobs,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  failSimulation,
  finishGradingJob,
  getGradingJob,
  getGradingJobForTrace,
  listGradingJobsForSimulation,
  recordGradingHeartbeat,
  recordProductionTraces,
  releaseGradingJob,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  watchGradingWork,
  type AuthContext,
  type NewSpan,
} from "@egma/db";

import {
  createConnectedDatabase,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The grading queue: how a finished conversation becomes work, and how the
 * grader service takes it.
 *
 * Everything here runs against a real Postgres, because everything under test is
 * a Postgres behaviour — whether the enqueue rides the same transaction as the
 * terminal transition, whether `SKIP LOCKED` keeps two copies of the service off
 * one conversation, whether a lease that ran out makes a job claimable again,
 * and whether a notification raised inside a transaction reaches a listener when
 * it commits and not before.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");

function actingAsAcme(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: gene,
    organizationId: globex.organization,
    projectId: globex.project,
    role: "member",
    via: "session",
  };
}

const auth = actingAsAcme();

let agentId: string;
let connectionId: string;
let personaId: string;
/** What a run executes: a run pins frozen versions, and never names none. */
let testVersionId: string;

/** One conversation, conducted as far as the caller asks and no further. */
async function aSimulation(): Promise<string> {
  const started = await startRun(auth, {
    agentId,
    connectionId,
    testVersionIds: [testVersionId],
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");
  return only.id;
}

async function aRunningSimulation(claimant = "simulator-1"): Promise<string> {
  const id = await aSimulation();
  // The claim is instance-wide and oldest-first, so it takes everything
  // outstanding rather than one — anything less could hand back somebody
  // else's leftovers and leave this test's own row queued.
  await claimSimulations({ claimant, capacity: 50 });
  await startSimulation(auth, id, claimant);
  return id;
}

/** A conversation that happened, which is the ordinary way work arrives. */
async function aCompletedSimulation(): Promise<string> {
  const claimant = "simulator-1";
  const id = await aRunningSimulation(claimant);
  await completeSimulation(auth, id, claimant, {
    endingReason: "persona_concluded",
  });
  return id;
}

/** The one job a conversation has, or a loud failure — never a maybe. */
async function theJobFor(simulationId: string): Promise<string> {
  const jobs = await listGradingJobsForSimulation(auth, simulationId);
  const [only] = jobs;
  if (only === undefined || jobs.length !== 1) {
    throw new Error(
      `simulation ${simulationId} has ${jobs.length} grading jobs, not one`,
    );
  }
  return only.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("grading_jobs");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, gene, "gene@globex.example");
  // **No running graders here, and the claim under test is why that is right.**
  // A grading job is written for every conversation that lands terminal, in the
  // same commit that lands it, whatever the project happens to judge with — one
  // job per conversation, never one per grader. So a project judging with
  // nothing still enqueues, which is exactly the shape these tests assert and
  // is worth having a fixture that shows it.

  const created = await createAgent(auth, {
    name: "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  agentId = created.id;
  connectionId = created.connection?.id ?? "";

  personaId = (
    await createPersona(auth, {
      name: "Impatient Rita",
      traits: { personality: "Speaks plainly.", language: "en-US" },
    })
  ).id;

  testVersionId = (
    await createTest(auth, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [personaId],
    })
  ).versionId;
});

afterAll(async () => {
  await database.drop();
});

/* ------------------------------------------------------------------- *
 * The other source: telemetry at the door.
 * ------------------------------------------------------------------- */

let nextWireId = 0;

/** An id off the wire — fixed-width hex, which egma's own format is not. */
function wireId(bytes: 8 | 16): string {
  nextWireId += 1;
  return nextWireId.toString(16).padStart(bytes * 2, "0");
}

/**
 * A span as the ingest door hands one over. Only four fields decide anything
 * here — the trace it belongs to, whether it names a parent, when it began, and
 * that it is production — so the rest are the door's own defaults.
 */
function aSpan(over: Partial<NewSpan> & { readonly traceId: string }): NewSpan {
  return {
    spanId: wireId(8),
    parentSpanId: wireId(8),
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: BigInt(Date.now()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "user_turn",
    kind: "turn:human",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    agentPlatform: "livekit_agents",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    connectionKind: "livekit",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    ...over,
  };
}

/** A root span: the one that names no parent, and so closes the conversation. */
function aRootSpan(traceId: string, startedAt = Date.now()): NewSpan {
  return aSpan({
    traceId,
    parentSpanId: "",
    name: "agent_session",
    kind: "root",
    startedAtMicroseconds: BigInt(startedAt) * 1_000n,
  });
}

/** The job standing behind a trace, or a loud failure. */
async function theJobForTrace(traceId: string) {
  const job = await getGradingJobForTrace(auth, traceId);
  if (job === undefined) throw new Error(`no job for trace ${traceId}`);
  return job;
}

describe("a terminal transition", () => {
  it("makes the conversation claimable work, in the same commit", async () => {
    const simulationId = await aCompletedSimulation();

    const [job] = await listGradingJobsForSimulation(auth, simulationId);
    expect(job).toMatchObject({
      simulationId,
      source: "simulation",
      status: "pending",
      attempts: 0,
      claimedBy: null,
      finishedAt: null,
      projectId: acme.project,
      organizationId: acme.organization,
    });
  });

  it("makes work of a failed simulation too, because a broken test is still judged", async () => {
    const claimant = "simulator-1";
    const simulationId = await aRunningSimulation(claimant);
    await failSimulation(auth, simulationId, claimant, {
      reason: "simulator_error",
    });

    const [job] = await listGradingJobsForSimulation(auth, simulationId);
    expect(job?.status).toBe("pending");
  });

  it("makes work of a simulation the orphan sweep landed", async () => {
    const claimant = "simulator-that-died";
    const simulationId = await aRunningSimulation(claimant);
    await database.sql(
      "update simulation set heartbeat_at = now() - interval '1 hour' where id = $1",
      [simulationId],
    );

    const swept = await sweepOrphanedSimulations({ staleAfterSeconds: 1 });
    expect(swept.map((simulation) => simulation.id)).toContain(simulationId);

    const [job] = await listGradingJobsForSimulation(auth, simulationId);
    expect(job?.status).toBe("pending");
  });

  it("makes none of a canceled simulation, which nobody asked to be judged", async () => {
    const started = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [testVersionId],
    });
    const [only] = started.simulations;
    if (only === undefined) throw new Error("the run has no simulation");

    await cancelRun(auth, started.id);

    expect(await listGradingJobsForSimulation(auth, only.id)).toEqual([]);
  });

  it("enqueues once per conversation, and the database is what says so", async () => {
    const simulationId = await aCompletedSimulation();
    const before = await listGradingJobsForSimulation(auth, simulationId);
    expect(before).toHaveLength(1);

    // A landing reported twice makes no second job, because the enqueue's
    // idempotence rests on a unique rather than on the application remembering
    // — which is what a replay, a bulk import or a manual fix would go around.
    // Raw, deliberately: the point is that nothing at all can write the second
    // row, not that this module declines to.
    await expect(
      database.sql(
        "insert into grading_job (id, organization_id, project_id, source, simulation_id, status) values ($1, $2, $3, 'simulation', $4, 'pending')",
        [newId("gjb"), acme.organization, acme.project, simulationId],
      ),
    ).rejects.toMatchObject({ code: POSTGRES_ERROR.uniqueViolation });

    expect(await listGradingJobsForSimulation(auth, simulationId)).toEqual(
      before,
    );
  });
});

/**
 * A production trace has no transaction to ride, so its job is written at the
 * door on the first export that mentions it and completed later — by the root
 * span arriving, or by nothing arriving at all for long enough.
 */
describe("a production trace at the door", () => {
  it("becomes known on the first export, and is not claimable while it is still happening", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId })]);

    expect(await theJobForTrace(traceId)).toMatchObject({
      traceId,
      source: "production",
      simulationId: null,
      status: "pending",
      rootClosedAt: null,
      organizationId: acme.organization,
      projectId: acme.project,
    });

    // Pending, and deliberately not claimable: the conversation has not ended,
    // and judging half of one would be a verdict about a call still going on.
    const claimed = await claimGradingJobs({
      claimant: "grader-early",
      capacity: 50,
    });
    expect(claimed.some((claim) => claim.traceId === traceId)).toBe(false);
  });

  it("is one job however many flushes it arrives in, and the window is the widest anybody sent", async () => {
    const traceId = wireId(16);
    const middle = Date.now();

    // Out of order on purpose. An exporter flushes when its queue fills or its
    // timer fires, and nothing promises the batches arrive in the order the
    // spans happened.
    await recordProductionTraces(auth, [
      aSpan({ traceId, startedAtMicroseconds: BigInt(middle) * 1_000n }),
    ]);
    await recordProductionTraces(auth, [
      aSpan({
        traceId,
        startedAtMicroseconds: BigInt(middle + 30_000) * 1_000n,
      }),
      aSpan({
        traceId,
        startedAtMicroseconds: BigInt(middle - 30_000) * 1_000n,
      }),
    ]);

    const job = await theJobForTrace(traceId);
    expect(job.firstSpanAt?.getTime()).toBe(middle - 30_000);
    expect(job.lastSpanAt?.getTime()).toBe(middle + 30_000);

    // One row in this project, and nothing in the module is what makes it one:
    // a second job for the same project and trace is unrepresentable.
    await expect(
      database.sql(
        "insert into grading_job (id, organization_id, project_id, source, trace_id, status, first_span_at, last_span_at, last_seen_at) values ($1, $2, $3, 'production', $4, 'pending', now(), now(), now())",
        [newId("gjb"), acme.organization, acme.project, traceId],
      ),
    ).rejects.toMatchObject({ code: POSTGRES_ERROR.uniqueViolation });
  });

  it("is claimable the moment its root span closes it", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId })]);
    await recordProductionTraces(auth, [aRootSpan(traceId)]);

    expect((await theJobForTrace(traceId)).rootClosedAt).toBeInstanceOf(Date);

    const claimed = await claimGradingJobs({
      claimant: "grader-on-a-closed-root",
      capacity: 50,
    });
    const mine = claimed.find((claim) => claim.traceId === traceId);

    expect(mine).toMatchObject({
      source: "production",
      simulationId: null,
      organizationId: acme.organization,
      projectId: acme.project,
    });
    // The window travels with the claim, because the trace store is filed by
    // the minute a span started in and a read naming only a trace would have
    // nothing to prune with.
    expect(mine?.firstSpanAt).toBeInstanceOf(Date);
    expect(mine?.lastSpanAt).toBeInstanceOf(Date);
  });

  it("is completed by the idle window when its root span never closes", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId })]);

    // Nothing has arrived for a while, which is the only signal there is: the
    // event this waits for is the absence of events, so no notification can
    // ever be raised for it and the claim query is what finds it.
    await database.sql(
      "update grading_job set last_seen_at = now() - interval '10 minutes' where trace_id = $1",
      [traceId],
    );

    const claimed = await claimGradingJobs({
      claimant: "grader-sweeping",
      capacity: 50,
      idleSeconds: 60,
    });
    const mine = claimed.find((claim) => claim.traceId === traceId);
    expect(mine).toBeDefined();
    // Judged with no root ever closing it, and the row still says so.
    expect((await theJobForTrace(traceId)).rootClosedAt).toBeNull();
  });

  it("waits for the whole idle window, not part of it", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId })]);
    await database.sql(
      "update grading_job set last_seen_at = now() - interval '30 seconds' where trace_id = $1",
      [traceId],
    );

    const claimed = await claimGradingJobs({
      claimant: "grader-impatient",
      capacity: 50,
      idleSeconds: 300,
    });
    expect(claimed.some((claim) => claim.traceId === traceId)).toBe(false);
  });

  it("is not resurrected by a late export, however loudly it says the trace ended", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId }), aRootSpan(traceId)]);

    const [claim] = (
      await claimGradingJobs({ claimant: "grader-beta", capacity: 50 })
    ).filter((each) => each.traceId === traceId);
    if (claim === undefined) throw new Error("the trace was not claimed");
    await finishGradingJob(auth, claim.id, "grader-beta");

    const graded = await theJobForTrace(traceId);
    expect(graded.status).toBe("graded");

    // A straggling flush, a root span in it and all. Re-grading history is
    // something somebody asks for, never something a late export causes.
    await recordProductionTraces(auth, [aRootSpan(traceId)]);

    const after = await theJobForTrace(traceId);
    expect(after.status).toBe("graded");
    expect(after.finishedAt).toEqual(graded.finishedAt);
    expect(after.lastSeenAt).toEqual(graded.lastSeenAt);

    const again = await claimGradingJobs({
      claimant: "grader-gamma",
      capacity: 50,
    });
    expect(again.some((each) => each.traceId === traceId)).toBe(false);
  });

  it("records nothing for a credential acting in no project", async () => {
    const traceId = wireId(16);
    const wholeCustomer: AuthContext = {
      ...actingAsAcme(),
      projectId: undefined,
      via: "api_key",
    };

    await recordProductionTraces(wholeCustomer, [
      aSpan({ traceId }),
      aRootSpan(traceId),
    ]);

    // Its spans file under the store's own sentinel, which is not a project row
    // and could not carry the tenancy a job needs — and graders belong to
    // projects, so the trace has nothing to be judged by in the first place.
    expect(await getGradingJobForTrace(wholeCustomer, traceId)).toBeUndefined();
  });

  it("records nothing for a simulation's own spans, whoever exported them", async () => {
    const traceId = wireId(16);
    // Simulations reach the queue through the transaction that ends them. When
    // egma's own runtime starts exporting through this door, its spans must not
    // make a second job for a conversation that already has one.
    await recordProductionTraces(auth, [
      aSpan({ traceId, source: "simulation" }),
      { ...aRootSpan(traceId), source: "simulation" },
    ]);

    expect(await getGradingJobForTrace(auth, traceId)).toBeUndefined();
  });

  it("belongs to one customer, and another cannot see it", async () => {
    const traceId = wireId(16);
    await recordProductionTraces(auth, [aSpan({ traceId }), aRootSpan(traceId)]);

    expect(
      await getGradingJobForTrace(actingAsGlobex(), traceId),
    ).toBeUndefined();
  });

  it("keeps the same wire trace id as separate work in separate projects", async () => {
    const traceId = wireId(16);

    // A customer controls this id. Two exporters can choose the same bytes,
    // and the project on the credential is what makes them two conversations.
    await recordProductionTraces(auth, [aSpan({ traceId })]);
    await recordProductionTraces(actingAsGlobex(), [aRootSpan(traceId)]);

    const acmeJob = await getGradingJobForTrace(auth, traceId);
    const globexJob = await getGradingJobForTrace(actingAsGlobex(), traceId);
    expect(acmeJob).toMatchObject({
      projectId: acme.project,
      rootClosedAt: null,
    });
    expect(globexJob).toMatchObject({
      projectId: globex.project,
      rootClosedAt: expect.any(Date),
    });

    const counted = await database.sql<{ n: string }>(
      "select count(*) as n from grading_job where trace_id = $1",
      [traceId],
    );
    expect(Number(counted.rows[0]?.n ?? 0)).toBe(2);
  });
});

describe("the claim", () => {
  it("hands back the job with the context it is graded under", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);

    const claimed = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 10,
    });
    const mine = claimed.find((claim) => claim.id === jobId);

    expect(mine).toMatchObject({
      source: "simulation",
      simulationId,
      organizationId: acme.organization,
      projectId: acme.project,
      attempts: 1,
      claimedBy: "grader-alpha",
    });
    expect(mine?.auth).toEqual({
      userId: "engine",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "viewer",
      via: "engine",
    });
  });

  /**
   * The window a production trace is read inside travels with the claim, and it
   * belongs on this list rather than beside it: those two instants are stamps
   * egma's own door made off the telemetry it accepted, in the same family as
   * the id and the tenancy. Nothing a customer wrote crosses here — no
   * transcript, no name, no configuration.
   *
   * The grader a re-grade narrowed to is here on the same terms: an identifier
   * egma minted, saying which of this customer's graders to judge with, and
   * never a word of what that grader says — which the engine reads for itself,
   * through the scoped surface, with the context this claim hands back.
   */
  it("carries no conversation out of it — identifiers and tenancy, nothing else", async () => {
    await aCompletedSimulation();
    const [claim] = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 1,
    });
    if (claim === undefined) throw new Error("nothing was claimed");

    expect(Object.keys(claim).sort()).toEqual(
      [
        "attempts",
        "auth",
        "claimedAt",
        "claimedBy",
        "firstSpanAt",
        "id",
        "lastSpanAt",
        "organizationId",
        "projectId",
        "regradeGraderId",
        "simulationId",
        "source",
        "traceId",
      ].sort(),
    );
  });

  it("reaches every customer, because the engine stands behind all of them", async () => {
    // Globex's own world, so that its conversation exists to be found.
    const globexAuth = actingAsGlobex();
    const globexAgent = await createAgent(globexAuth, {
      name: "Support line",
      connection: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-Z9Y8X7W6VUTS" },
      },
    });
    const grace = await createPersona(globexAuth, {
      name: "Careful Grace",
      traits: { personality: "Speaks slowly.", language: "en-US" },
    });
    const globexTest = await createTest(globexAuth, {
      name: "Cancels a booking",
      scenario: "Their cleaning has to be called off.",
      expectedBehaviors: ["confirms the booking is gone before finishing"],
      personaIds: [grace.id],
    });
    const started = await startRun(globexAuth, {
      agentId: globexAgent.id,
      connectionId: globexAgent.connection?.id ?? "",
      testVersionIds: [globexTest.versionId],
    });
    const [conversation] = started.simulations;
    if (conversation === undefined) throw new Error("no simulation");
    await claimSimulations({ claimant: "sim", capacity: 50 });
    await startSimulation(globexAuth, conversation.id, "sim");
    await completeSimulation(globexAuth, conversation.id, "sim", {
      endingReason: "agent_ended",
    });

    const acmeSimulation = await aCompletedSimulation();

    const claimed = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 50,
    });
    const reached = new Set(claimed.map((claim) => claim.organizationId));

    expect(reached.has(acme.organization)).toBe(true);
    expect(reached.has(globex.organization)).toBe(true);
    // And each claim's context is its own customer's, never the other's.
    for (const claim of claimed) {
      expect(claim.auth.organizationId).toBe(claim.organizationId);
      expect(claim.auth.projectId).toBe(claim.projectId);
    }
    expect(
      claimed.some((claim) => claim.simulationId === acmeSimulation),
    ).toBe(true);
  });
});

describe("two copies of the service", () => {
  it("never take the same conversation", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);

    const [blue, green] = await Promise.all([
      claimGradingJobs({ claimant: "grader-blue", capacity: 5 }),
      claimGradingJobs({ claimant: "grader-green", capacity: 5 }),
    ]);

    const both = [...blue, ...green].filter((claim) => claim.id === jobId);
    expect(both).toHaveLength(1);
  });

  it("split a queue between them without overlap and without loss", async () => {
    const queued = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      queued.add(await theJobFor(await aCompletedSimulation()));
    }

    const fleet = await Promise.all(
      ["grader-a", "grader-b", "grader-c"].map((claimant) =>
        claimGradingJobs({ claimant, capacity: 2 }),
      ),
    );

    const taken = fleet.flat().map((claim) => claim.id).filter((id) => queued.has(id));
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken.length).toBe(6);
  });
});

describe("a copy that stopped answering", () => {
  it("loses its claim to the next one, once the lease runs out", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);

    const [held] = await claimGradingJobs({
      claimant: "grader-that-died",
      capacity: 1,
    });
    expect(held?.id).toBe(jobId);

    // Nothing is claimable while the lease holds.
    expect(
      (await claimGradingJobs({ claimant: "grader-next", capacity: 5 })).some(
        (claim) => claim.id === jobId,
      ),
    ).toBe(false);

    await database.sql(
      "update grading_job set heartbeat_at = now() - interval '1 hour' where id = $1",
      [jobId],
    );

    const [reclaimed] = await claimGradingJobs({
      claimant: "grader-next",
      capacity: 5,
    });
    expect(reclaimed).toMatchObject({
      id: jobId,
      claimedBy: "grader-next",
      attempts: 2,
    });

    // And the copy that died can no longer say anything about it.
    expect(
      await recordGradingHeartbeat(reclaimed?.auth ?? held?.auth ?? auth, jobId, "grader-that-died"),
    ).toBeUndefined();
  });

  it("is given up on after three attempts, and abandoned is not failed", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimGradingJobs({
        claimant: `grader-attempt-${attempt}`,
        capacity: 50,
      });
      expect(claimed.some((claim) => claim.id === jobId)).toBe(true);
      await database.sql(
        "update grading_job set heartbeat_at = now() - interval '1 hour' where id = $1",
        [jobId],
      );
    }

    const fourth = await claimGradingJobs({
      claimant: "grader-attempt-4",
      capacity: 50,
    });
    expect(fourth.some((claim) => claim.id === jobId)).toBe(false);

    const job = await getGradingJob(auth, jobId);
    expect(job?.status).toBe("abandoned");
    expect(job?.finishedAt).toBeInstanceOf(Date);
  });
});

describe("holding a job", () => {
  it("heartbeats, finishes, and finishes only once", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);
    const [claim] = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 50,
    });
    const mine = claim?.id === jobId ? claim : undefined;
    if (mine === undefined) throw new Error("the job was not claimed");

    expect(await recordGradingHeartbeat(mine.auth, jobId, "grader-alpha")).toEqual(
      { held: true },
    );

    const finished = await finishGradingJob(mine.auth, jobId, "grader-alpha");
    expect(finished?.status).toBe("graded");
    expect(finished?.finishedAt).toBeInstanceOf(Date);

    expect(await finishGradingJob(mine.auth, jobId, "grader-alpha")).toBeUndefined();
    expect(
      await recordGradingHeartbeat(mine.auth, jobId, "grader-alpha"),
    ).toBeUndefined();

    // And a graded job is never handed out again.
    const after = await claimGradingJobs({ claimant: "grader-beta", capacity: 50 });
    expect(after.some((c) => c.id === jobId)).toBe(false);
  });

  it("releases it back to the queue, keeping why", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);
    const claimed = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 50,
    });
    const mine = claimed.find((claim) => claim.id === jobId);
    if (mine === undefined) throw new Error("the job was not claimed");

    const released = await releaseGradingJob(
      mine.auth,
      jobId,
      "grader-alpha",
      "the trace store would not take the verdicts",
    );
    expect(released).toMatchObject({
      status: "pending",
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      lastError: "the trace store would not take the verdicts",
      attempts: 1,
    });

    const again = await claimGradingJobs({ claimant: "grader-beta", capacity: 50 });
    expect(again.some((claim) => claim.id === jobId)).toBe(true);
  });

  it("refuses a claimant who does not hold it", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);
    const claimed = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 50,
    });
    const mine = claimed.find((claim) => claim.id === jobId);
    if (mine === undefined) throw new Error("the job was not claimed");

    expect(
      await recordGradingHeartbeat(mine.auth, jobId, "grader-somebody-else"),
    ).toBeUndefined();
    expect(
      await finishGradingJob(mine.auth, jobId, "grader-somebody-else"),
    ).toBeUndefined();
  });
});

describe("one customer's job", () => {
  it("is out of another customer's reach entirely", async () => {
    const simulationId = await aCompletedSimulation();
    const jobId = await theJobFor(simulationId);
    const claimed = await claimGradingJobs({
      claimant: "grader-alpha",
      capacity: 50,
    });
    const mine = claimed.find((claim) => claim.id === jobId);
    if (mine === undefined) throw new Error("the job was not claimed");

    const outsider = actingAsGlobex();
    expect(await getGradingJob(outsider, jobId)).toBeUndefined();
    expect(
      await recordGradingHeartbeat(outsider, jobId, "grader-alpha"),
    ).toBeUndefined();
    expect(await finishGradingJob(outsider, jobId, "grader-alpha")).toBeUndefined();
    expect(await listGradingJobsForSimulation(outsider, simulationId)).toEqual([]);
  });
});

describe("the wake", () => {
  it("arrives when a conversation ends, without anybody asking again", async () => {
    let wakes = 0;
    const woken: Promise<void> = new Promise((resolve) => {
      const watching = watchGradingWork(() => {
        wakes += 1;
        // The first wake is the one every established watch fires, which is
        // what makes a service that was not listening catch up; the second is
        // a conversation actually ending.
        if (wakes >= 2) resolve();
      });
      void watching;
    });

    // Given to the listener before the transition, so the notification is the
    // thing that resolves it rather than a race with the watch being set up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(wakes).toBeGreaterThanOrEqual(1);

    await aCompletedSimulation();

    await Promise.race([
      woken,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("no notification arrived within five seconds")),
          5_000,
        ),
      ),
    ]);
  });
});
