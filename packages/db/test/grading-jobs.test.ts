import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelRun,
  claimGradingJobs,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  failSimulation,
  finishGradingJob,
  getGradingJob,
  listGradingJobsForSimulation,
  recordGradingHeartbeat,
  releaseGradingJob,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  watchGradingWork,
  type AuthContext,
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

/** One conversation, conducted as far as the caller asks and no further. */
async function aSimulation(): Promise<string> {
  const started = await startRun(auth, {
    agentId,
    connectionId,
    personaIds: [personaId],
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");
  return only.id;
}

async function aRunningSimulation(claimant = "simulator-1"): Promise<string> {
  const id = await aSimulation();
  await claimSimulations(auth, { claimant, capacity: 1 });
  await startSimulation(auth, id, claimant);
  return id;
}

/** A conversation that happened, which is the ordinary way work arrives. */
async function aCompletedSimulation(): Promise<string> {
  const claimant = "simulator-1";
  const id = await aRunningSimulation(claimant);
  await completeSimulation(auth, id, claimant, {
    endingReason: "persona_concluded",
    transcript: [{ speaker: "agent", text: "Booked for Tuesday at four." }],
    metrics: { turn_response_latency: [900, 1_800] },
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

  const created = await createAgent(auth, {
    name: "Front desk",
    connection: {
      type: "retell",
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
      traits: {
        personality: "Speaks plainly.",
        language: "en-US",
        voice: {
          provider: "elevenlabs",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          speed: 1,
        },
      },
    })
  ).id;
});

afterAll(async () => {
  await database.drop();
});

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

    const swept = await sweepOrphanedSimulations(auth, { staleAfterSeconds: 1 });
    expect(swept.map((simulation) => simulation.id)).toContain(simulationId);

    const [job] = await listGradingJobsForSimulation(auth, simulationId);
    expect(job?.status).toBe("pending");
  });

  it("makes none of a canceled simulation, which nobody asked to be judged", async () => {
    const started = await startRun(auth, {
      agentId,
      connectionId,
      personaIds: [personaId],
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
        "id",
        "organizationId",
        "projectId",
        "simulationId",
        "source",
      ].sort(),
    );
  });

  it("reaches every customer, because the engine stands behind all of them", async () => {
    // Globex's own world, so that its conversation exists to be found.
    const globexAuth = actingAsGlobex();
    const globexAgent = await createAgent(globexAuth, {
      name: "Support line",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_2" },
        credentials: { apiKey: "retell-secret-Z9Y8X7W6VUTS" },
      },
    });
    const grace = await createPersona(globexAuth, {
      name: "Careful Grace",
      traits: {
        personality: "Speaks slowly.",
        language: "en-US",
        voice: {
          provider: "elevenlabs",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          speed: 1,
        },
      },
    });
    const started = await startRun(globexAuth, {
      agentId: globexAgent.id,
      connectionId: globexAgent.connection?.id ?? "",
      personaIds: [grace.id],
    });
    const [conversation] = started.simulations;
    if (conversation === undefined) throw new Error("no simulation");
    await claimSimulations(globexAuth, { claimant: "sim", capacity: 1 });
    await startSimulation(globexAuth, conversation.id, "sim");
    await completeSimulation(globexAuth, conversation.id, "sim", {
      endingReason: "agent_ended",
      transcript: [],
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
