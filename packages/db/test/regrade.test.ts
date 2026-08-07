import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimGradingJobs,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  finishGradingJob,
  getGradingJob,
  listGradingJobsForSimulation,
  NotPermittedError,
  regrade,
  reopenGradingJob,
  startRun,
  startSimulation,
  watchGradingWork,
  type AuthContext,
  type GradingJob,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Asking for a conversation to be judged again.
 *
 * This is the queue half of a re-grade — which conversations are named, and what
 * happens to their jobs. What comes of it, the rows landing beside the old ones
 * at a new grader version, is the grader service's own acceptance suite, because
 * that is where a conversation is actually judged.
 *
 * Everything here runs against a real Postgres, because everything under test is
 * a Postgres behaviour: a unique that makes a second ask a reopen rather than a
 * duplicate, a state machine's check constraints that a reopened row has to
 * satisfy, and the notification the reopen raises inside its own transaction.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");

function actingAsAcme(role: AuthContext["role"] = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

const auth = actingAsAcme();

const outsider: AuthContext = {
  userId: gene,
  organizationId: globex.organization,
  projectId: globex.project,
  role: "member",
  via: "session",
};

let agentId: string;
let connectionId: string;
let personaId: string;

type Conducted = { readonly runId: string; readonly simulationId: string };

/** One conversation, ended — which is the moment it becomes grading work. */
async function aFinishedSimulation(): Promise<Conducted> {
  const claimant = "simulator-1";
  const started = await startRun(auth, {
    agentId,
    connectionId,
    personaIds: [personaId],
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");

  await claimSimulations(auth, { claimant, capacity: 50 });
  await startSimulation(auth, only.id, claimant);
  await completeSimulation(auth, only.id, claimant, {
    endingReason: "persona_concluded",
    transcript: [{ speaker: "agent", text: "Booked for Tuesday at four." }],
    metrics: { turn_response_latency: [900, 1_800] },
  });

  return { runId: started.id, simulationId: only.id };
}

/** The one job a conversation has, or a loud failure — never a maybe. */
async function theJobFor(simulationId: string): Promise<GradingJob> {
  const jobs = await listGradingJobsForSimulation(auth, simulationId);
  const [only] = jobs;
  if (only === undefined || jobs.length !== 1) {
    throw new Error(
      `simulation ${simulationId} has ${jobs.length} grading jobs, not one`,
    );
  }
  return only;
}

/**
 * A conversation carried all the way through one grading, so that asking for it
 * again is a re-grade rather than a first grading arriving late.
 */
async function aJudgedSimulation(): Promise<Conducted> {
  const conducted = await aFinishedSimulation();
  const job = await theJobFor(conducted.simulationId);

  const claimant = `grader-${job.id.slice(-6)}`;
  const claimed = await claimGradingJobs({ claimant, capacity: 50 });
  const mine = claimed.find((claim) => claim.id === job.id);
  if (mine === undefined) throw new Error("the job was not claimed");
  await finishGradingJob(mine.auth, job.id, claimant);

  return conducted;
}

/** Where in time a job says it became judgeable. Set, so a window can be aimed. */
async function becameJudgeableAt(jobId: string, when: string): Promise<void> {
  await database.sql("update grading_job set created_at = $2 where id = $1", [
    jobId,
    when,
  ]);
}

beforeAll(async () => {
  database = await createConnectedDatabase("regrade");

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

describe("reopening one conversation's job", () => {
  it("makes a judged conversation claimable again, with the claim cleared and the attempts back to nothing", async () => {
    const { simulationId } = await aJudgedSimulation();
    const before = await theJobFor(simulationId);
    expect(before.status).toBe("graded");
    expect(before.attempts).toBe(1);

    const reopened = await reopenGradingJob(auth, before.id);

    expect(reopened).toMatchObject({
      id: before.id,
      status: "pending",
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      lastError: null,
      attempts: 0,
    });

    // The same row, reopened — not a second job beside it. The unique on the
    // conversation is what makes that true rather than this call's manners.
    expect(await listGradingJobsForSimulation(auth, simulationId)).toHaveLength(
      1,
    );
    // And it says it became judgeable when the conversation ended, still, so a
    // window means the same thing after a re-grade as it did before one.
    expect(reopened?.createdAt).toEqual(before.createdAt);

    const claimed = await claimGradingJobs({
      claimant: "grader-again",
      capacity: 50,
    });
    expect(claimed.some((claim) => claim.id === before.id)).toBe(true);
  });

  it("gives an abandoned conversation the three attempts back, or it would be abandoned again at once", async () => {
    const { simulationId } = await aFinishedSimulation();
    const job = await theJobFor(simulationId);

    // Three copies take it and vanish, which is what abandons it.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await claimGradingJobs({ claimant: `grader-${attempt}`, capacity: 50 });
      await database.sql(
        "update grading_job set heartbeat_at = now() - interval '1 hour' where id = $1",
        [job.id],
      );
    }
    await claimGradingJobs({ claimant: "grader-4", capacity: 50 });
    expect((await getGradingJob(auth, job.id))?.status).toBe("abandoned");

    const reopened = await reopenGradingJob(auth, job.id);
    expect(reopened).toMatchObject({ status: "pending", attempts: 0 });

    const claimed = await claimGradingJobs({
      claimant: "grader-after-giving-up",
      capacity: 50,
    });
    expect(claimed.some((claim) => claim.id === job.id)).toBe(true);
  });

  it("leaves a conversation that is already waiting exactly alone", async () => {
    const { simulationId } = await aFinishedSimulation();
    const waiting = await theJobFor(simulationId);
    expect(waiting.status).toBe("pending");

    expect(await reopenGradingJob(auth, waiting.id)).toBeUndefined();
    expect(await getGradingJob(auth, waiting.id)).toEqual(waiting);
  });

  it("is out of another customer's reach entirely", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);

    expect(await reopenGradingJob(outsider, job.id)).toBeUndefined();
    expect((await getGradingJob(auth, job.id))?.status).toBe("graded");
  });

  it("is refused to a viewer, who cannot spend the judge on history", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);

    await expect(reopenGradingJob(actingAsAcme("viewer"), job.id)).rejects.toThrow(
      NotPermittedError,
    );
    expect((await getGradingJob(auth, job.id))?.status).toBe("graded");
  });

  it("wakes a service the same way a conversation ending does", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);

    let wakes = 0;
    const woken: Promise<void> = new Promise((resolve) => {
      void watchGradingWork(() => {
        wakes += 1;
        // The first is the one every established watch fires, so that a service
        // which was not listening catches up; the second is this reopen.
        if (wakes >= 2) resolve();
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(wakes).toBeGreaterThanOrEqual(1);

    await reopenGradingJob(auth, job.id);

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

describe("re-grading a run", () => {
  it("asks for every conversation in it again, and for nothing outside it", async () => {
    const mine = await aJudgedSimulation();
    const somebody_elses = await aJudgedSimulation();

    const asked = await regrade(auth, { runId: mine.runId });

    expect(asked?.reopened.map((job) => job.simulationId)).toEqual([
      mine.simulationId,
    ]);
    expect(asked?.alreadyWaiting).toBe(0);
    expect((await theJobFor(mine.simulationId)).status).toBe("pending");
    // The other run's conversation was never named, so it is still judged.
    expect((await theJobFor(somebody_elses.simulationId)).status).toBe("graded");
  });

  it("counts the conversations already waiting rather than asking twice for them", async () => {
    const waiting = await aFinishedSimulation();

    const asked = await regrade(auth, { runId: waiting.runId });

    expect(asked?.reopened).toEqual([]);
    expect(asked?.alreadyWaiting).toBe(1);
    // Untouched: a conversation in the queue is already going to be judged at
    // today's grader versions, which is everything a re-grade would have asked.
    expect((await theJobFor(waiting.simulationId)).attempts).toBe(0);
  });

  it("answers with nothing at all for a run nobody can reach", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    expect(await regrade(outsider, { runId })).toBeUndefined();
    expect(await regrade(auth, { runId: newId("run") })).toBeUndefined();
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("is refused to a viewer", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await expect(regrade(actingAsAcme("viewer"), { runId })).rejects.toThrow(
      NotPermittedError,
    );
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });
});

describe("re-grading a window", () => {
  /**
   * The half that covers production, which belongs to no run and never will.
   * The conversations are simulations here because they are the only source the
   * queue carries today; what the window is measured on — the moment a
   * conversation became judgeable — is the same column for both.
   */
  it("asks for the conversations inside it again, and leaves the ones outside", async () => {
    const inside = await aJudgedSimulation();
    const before = await aJudgedSimulation();
    const after = await aJudgedSimulation();

    await becameJudgeableAt(
      (await theJobFor(inside.simulationId)).id,
      "2026-03-15T12:00:00Z",
    );
    await becameJudgeableAt(
      (await theJobFor(before.simulationId)).id,
      "2026-03-14T23:59:59Z",
    );
    await becameJudgeableAt(
      (await theJobFor(after.simulationId)).id,
      "2026-03-16T00:00:01Z",
    );

    const asked = await regrade(auth, {
      window: {
        from: new Date("2026-03-15T00:00:00Z"),
        to: new Date("2026-03-16T00:00:00Z"),
      },
    });

    expect(asked?.reopened.map((job) => job.simulationId)).toEqual([
      inside.simulationId,
    ]);
    expect((await theJobFor(before.simulationId)).status).toBe("graded");
    expect((await theJobFor(after.simulationId)).status).toBe("graded");
  });

  it("names the same conversations the second time, because reopening moves nothing", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);
    await becameJudgeableAt(job.id, "2026-04-01T09:00:00Z");

    const window = {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-02T00:00:00Z"),
    };

    const first = await regrade(auth, { window });
    expect(first?.reopened.map((reopened) => reopened.id)).toEqual([job.id]);

    // Judged again, and asked again — the window still holds it, because the
    // moment it became judgeable is not the moment anybody asked about it.
    const claimant = "grader-second-time";
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    const mine = claimed.find((claim) => claim.id === job.id);
    if (mine === undefined) throw new Error("the reopened job was not claimed");
    await finishGradingJob(mine.auth, job.id, claimant);

    const second = await regrade(auth, { window });
    expect(second?.reopened.map((reopened) => reopened.id)).toEqual([job.id]);
  });

  it("reaches no conversation of another customer's, however wide it is asked", async () => {
    const { simulationId } = await aJudgedSimulation();

    const asked = await regrade(outsider, {
      window: {
        from: new Date("2000-01-01T00:00:00Z"),
        to: new Date("2100-01-01T00:00:00Z"),
      },
    });

    expect(asked?.reopened).toEqual([]);
    expect(asked?.alreadyWaiting).toBe(0);
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("refuses a window that ends before it starts, rather than judging nothing and saying so", async () => {
    await expect(
      regrade(auth, {
        window: {
          from: new Date("2026-05-02T00:00:00Z"),
          to: new Date("2026-05-01T00:00:00Z"),
        },
      }),
    ).rejects.toThrow("starts before it ends");

    await expect(
      regrade(auth, {
        window: {
          from: new Date("not a moment"),
          to: new Date("2026-05-01T00:00:00Z"),
        },
      }),
    ).rejects.toThrow("two moments");
  });
});
