import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimGradingJobs,
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  deleteGrader,
  finishGradingJob,
  getGradingJob,
  listGradingJobsForSimulation,
  NotPermittedError,
  regrade,
  reopenGradingJob,
  PREDEFINED_GRADERS,
  startRun,
  startSimulation,
  useLibraryEntry,
  watchGradingWork,
  type AuthContext,
  type GradingJob,
} from "@egma/db";

import {
  createConnectedDatabase,
  openSingleConnection,
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
/** What a run executes: a run pins frozen versions, and never names none. */
let testVersionId: string;
/** One of this project's graders, for the asks that narrow to one. */
let graderId: string;

/** A grader on the project, so a re-grade has something to name. */
async function aGrader(
  who: AuthContext = auth,
  name = `Answers inside two seconds ${newId("grd").slice(-6)}`,
): Promise<string> {
  const created = await useLibraryEntry(who, {
    libraryId: PREDEFINED_GRADERS.latency,
    name,
    params: { metric: "turn_response_latency", bound: 2_000 },
  });
  return created.id;
}

/** What a job says it stands reopened for, read straight off the row. */
async function narrowedTo(jobId: string): Promise<string | null> {
  const { rows } = await database.sql<{ regrade_grader_id: string | null }>(
    "select regrade_grader_id from grading_job where id = $1",
    [jobId],
  );
  return rows[0]?.regrade_grader_id ?? null;
}

type Conducted = { readonly runId: string; readonly simulationId: string };

/** One conversation, ended — which is the moment it becomes grading work. */
async function aFinishedSimulation(): Promise<Conducted> {
  const claimant = "simulator-1";
  const started = await startRun(auth, {
    agentId,
    connectionId,
    testVersionIds: [testVersionId],
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");

  await claimSimulations({ claimant, capacity: 50 });
  await startSimulation(auth, only.id, claimant);
  await completeSimulation(auth, only.id, claimant, {
    endingReason: "persona_concluded",
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
  // No seeded expected-behaviors copy: every grader a test here names is made
  // by `aGrader` above, because a re-grade is asked for by naming graders and a
  // copy nobody named would be a row the asks never mention.

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

  graderId = await aGrader();
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

/**
 * The grain somebody reading one conversation's evidence asks at.
 *
 * **It is not a one-run window and it is not a one-conversation run**, which is
 * why it is a target of its own. A window names conversations by the moment they
 * became judgeable, and two conversations of one run land inside the same second
 * — so asking about one through a window would ask about its neighbour too, and
 * spend the judge on a conversation nobody was looking at.
 */
describe("re-grading one conversation", () => {
  /** A run of two conversations, both judged: the pair the narrowing is proved on. */
  async function aJudgedPair(): Promise<{
    readonly runId: string;
    readonly opened: string;
    readonly neighbour: string;
  }> {
    const suffix = newId("prs").slice(-6);
    const callers = await Promise.all(
      [`Impatient Rita ${suffix}`, `Deliberate Sam ${suffix}`].map(
        async (name) =>
          (
            await createPersona(auth, {
              name,
              traits: { personality: "Speaks plainly.", language: "en-US" },
            })
          ).id,
      ),
    );

    const pair = await createTest(auth, {
      name: `Reschedules for two callers ${suffix}`,
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: callers,
    });

    const claimant = `simulator-${suffix}`;
    const started = await startRun(auth, {
      agentId,
      connectionId,
      testVersionIds: [pair.versionId],
    });
    expect(started.simulations).toHaveLength(2);

    await claimSimulations({ claimant, capacity: 50 });
    for (const one of started.simulations) {
      await startSimulation(auth, one.id, claimant);
      await completeSimulation(auth, one.id, claimant, {
        endingReason: "persona_concluded",
      });
    }

    const grader = `grader-${suffix}`;
    const claimed = await claimGradingJobs({ claimant: grader, capacity: 50 });
    for (const one of started.simulations) {
      const job = await theJobFor(one.id);
      const mine = claimed.find((claim) => claim.id === job.id);
      if (mine === undefined) throw new Error("the job was not claimed");
      await finishGradingJob(mine.auth, job.id, grader);
    }

    const [opened, neighbour] = started.simulations;
    if (opened === undefined || neighbour === undefined) {
      throw new Error("the run has fewer than two conversations");
    }
    return { runId: started.id, opened: opened.id, neighbour: neighbour.id };
  }

  it("reaches that conversation and never the one beside it in the same run", async () => {
    const { opened, neighbour } = await aJudgedPair();

    const asked = await regrade(auth, { simulationId: opened });

    expect(asked?.reopened.map((job) => job.simulationId)).toEqual([opened]);
    expect(asked?.graderId).toBeNull();
    expect((await theJobFor(opened)).status).toBe("pending");
    // The other conversation of the same run, landed in the same second, was
    // never named — so nobody spent the judge on it.
    expect((await theJobFor(neighbour)).status).toBe("graded");
  });

  it("counts a conversation already waiting rather than asking twice for it", async () => {
    const { simulationId } = await aFinishedSimulation();

    const asked = await regrade(auth, { simulationId });

    expect(asked?.reopened).toEqual([]);
    expect(asked?.alreadyWaiting).toBe(1);
    expect((await theJobFor(simulationId)).attempts).toBe(0);
  });

  it("narrows to one grader exactly as a run does, and leaves it on the job", async () => {
    const { simulationId } = await aJudgedSimulation();

    const asked = await regrade(auth, { simulationId, graderId });

    expect(asked?.graderId).toBe(graderId);
    expect(await narrowedTo((await theJobFor(simulationId)).id)).toBe(graderId);
  });

  it("answers with nothing at all for a conversation nobody can reach", async () => {
    const { simulationId } = await aJudgedSimulation();

    expect(await regrade(outsider, { simulationId })).toBeUndefined();
    expect(await regrade(auth, { simulationId: newId("sim") })).toBeUndefined();
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("answers with nothing at all for a grader nobody can reach", async () => {
    const { simulationId } = await aJudgedSimulation();
    const gone = await aGrader();
    await deleteGrader(auth, gone);

    expect(await regrade(auth, { simulationId, graderId: gone })).toBeUndefined();
    // An archived grader judges nothing from now on, and a re-grade is from now
    // on — so nothing was reopened on the strength of naming one.
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("is refused to a viewer, who cannot spend the judge on history", async () => {
    const { simulationId } = await aJudgedSimulation();

    await expect(
      regrade(actingAsAcme("viewer"), { simulationId }),
    ).rejects.toThrow(NotPermittedError);
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

/**
 * The half of the ticket that is about spend rather than about rows.
 *
 * Re-judging a conversation whole accumulates exactly the rows re-judging one
 * grader would — a grader nobody edited rewrites its own row in place — so
 * naming a grader changes nothing about what the record comes to say. What it
 * changes is how many judges are asked, and somebody who fixed one rubric did
 * not ask to pay for the other four. Everything below is that instruction
 * surviving the trip from the person asking to the engine reading it: it goes on
 * the job, it comes back off the claim, and it is gone the moment the work is.
 */
describe("re-grading with a grader named", () => {
  it("leaves the grader on the reopened job, which is where the engine will read it", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    const asked = await regrade(auth, { runId, graderId });

    // Echoed back, so a caller sees the ask that was actually made.
    expect(asked?.graderId).toBe(graderId);
    const reopened = await theJobFor(simulationId);
    expect(reopened.status).toBe("pending");
    expect(reopened.regradeGraderId).toBe(graderId);
    expect(await narrowedTo(reopened.id)).toBe(graderId);
  });

  it("hands it to whoever claims the work, and takes it back when the work is done", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);

    const claimant = "grader-narrowed";
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    const mine = claimed.find((claim) => claim.id === job.id);
    if (mine === undefined) throw new Error("the narrowed job was not claimed");

    // The whole point of the column: the person who asked has gone, and the
    // engine learns which grader they meant off the claim.
    expect(mine.regradeGraderId).toBe(graderId);

    const finished = await finishGradingJob(mine.auth, job.id, claimant);
    // The instruction was for that one piece of work, and the work is done. A
    // job that carried it forward would judge less and less of a conversation
    // the more often anybody asked about it.
    expect(finished?.regradeGraderId).toBeNull();
    expect(await narrowedTo(job.id)).toBeNull();
  });

  it("starts from the whole conversation again the next time nobody names one", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    await regrade(auth, { runId, graderId });

    const job = await theJobFor(simulationId);
    const claimant = "grader-then-widened";
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    const mine = claimed.find((claim) => claim.id === job.id);
    if (mine === undefined) throw new Error("the narrowed job was not claimed");
    await finishGradingJob(mine.auth, job.id, claimant);

    const again = await regrade(auth, { runId });

    expect(again?.graderId).toBeNull();
    expect(again?.reopened.map((row) => row.regradeGraderId)).toEqual([null]);
    expect(await narrowedTo(job.id)).toBeNull();
  });

  it("is not something reopening one job can ask for, so that verb never inherits one", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    await regrade(auth, { runId, graderId });

    const job = await theJobFor(simulationId);
    const claimant = "grader-before-the-reopen";
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    const mine = claimed.find((claim) => claim.id === job.id);
    if (mine === undefined) throw new Error("the narrowed job was not claimed");
    await finishGradingJob(mine.auth, job.id, claimant);

    // `reopenGradingJob` asks for the conversation and cannot ask for less, so
    // it writes the un-narrowing rather than leaving whatever was last asked.
    const reopened = await reopenGradingJob(auth, job.id);
    expect(reopened?.regradeGraderId).toBeNull();
  });

  it("widens a conversation already waiting under a different grader, rather than judging neither", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    const otherGrader = await aGrader();

    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);
    expect(await narrowedTo(job.id)).toBe(graderId);

    // A second ask about a different grader on work nobody has taken. Leaving
    // it alone was sound while an outstanding job judged everything; a job
    // queued for one grader would answer this one by judging neither.
    const second = await regrade(auth, { runId, graderId: otherGrader });

    expect(second?.reopened).toEqual([]);
    expect(second?.alreadyWaiting).toBe(1);
    expect(await narrowedTo(job.id)).toBeNull();
  });

  it("leaves a conversation waiting under the same grader exactly as it is", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await regrade(auth, { runId, graderId });
    const waiting = await theJobFor(simulationId);

    const second = await regrade(auth, { runId, graderId });

    expect(second?.reopened).toEqual([]);
    expect(second?.alreadyWaiting).toBe(1);
    expect(second?.beingJudgedNarrower).toBe(0);
    expect(await getGradingJob(auth, waiting.id)).toEqual(waiting);
  });

  /**
   * The one case a re-grade cannot carry out, counted so that a surface can say
   * so. A claimed job is judged under the instruction it was claimed with, and
   * widening the column decides nothing for it any more — so the ask is neither
   * carried out nor queued, and "already waiting" is the wrong word for it.
   */
  it("counts a claimed narrowing that does not cover the ask, apart from the rest", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    const otherGrader = await aGrader();

    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);
    const claimant = `grader-narrowed-${job.id.slice(-6)}`;
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    if (!claimed.some((claim) => claim.id === job.id)) {
      throw new Error("the narrowed job was not claimed");
    }

    const second = await regrade(auth, { runId, graderId: otherGrader });

    expect(second?.reopened).toEqual([]);
    // Still one conversation left alone, and now the reason it was left alone
    // is one nobody should be reassured by.
    expect(second?.alreadyWaiting).toBe(1);
    expect(second?.beingJudgedNarrower).toBe(1);
    // And the running judgment is untouched: nothing interrupts it.
    expect(await narrowedTo(job.id)).toBe(graderId);
    expect((await getGradingJob(auth, job.id))?.status).toBe("claimed");
  });

  it("counts the same claimed narrowing against an ask for the whole conversation", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);
    const claimant = `grader-whole-${job.id.slice(-6)}`;
    await claimGradingJobs({ claimant, capacity: 50 });

    // Narrower than the whole conversation is still narrower. Four of five
    // graders go unjudged, and nothing behind this job will judge them.
    const second = await regrade(auth, { runId });

    expect(second?.alreadyWaiting).toBe(1);
    expect(second?.beingJudgedNarrower).toBe(1);
  });

  it("counts nothing narrowed away when the claimed job judges the whole conversation", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await regrade(auth, { runId });
    const job = await theJobFor(simulationId);
    const claimant = `grader-covers-${job.id.slice(-6)}`;
    await claimGradingJobs({ claimant, capacity: 50 });
    expect(await narrowedTo(job.id)).toBeNull();

    // Judging everything includes judging this grader, so the ask is carried
    // out by the work already running.
    const second = await regrade(auth, { runId, graderId });

    expect(second?.alreadyWaiting).toBe(1);
    expect(second?.beingJudgedNarrower).toBe(0);
  });

  it("counts nothing narrowed away when the claimed narrowing is the ask", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);
    const claimant = `grader-same-${job.id.slice(-6)}`;
    await claimGradingJobs({ claimant, capacity: 50 });

    const second = await regrade(auth, { runId, graderId });

    expect(second?.alreadyWaiting).toBe(1);
    expect(second?.beingJudgedNarrower).toBe(0);
  });

  it("gives up on a narrowed job with the narrowing given up too", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    await regrade(auth, { runId, graderId });
    const job = await theJobFor(simulationId);

    // Three copies take it and vanish, which is what abandons it. egma is not
    // going to judge this conversation for that grader, and a job left narrowed
    // after it settles would hand the instruction to whoever reopens it next.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await claimGradingJobs({ claimant: `narrowed-${attempt}`, capacity: 50 });
      await database.sql(
        "update grading_job set heartbeat_at = now() - interval '1 hour' where id = $1",
        [job.id],
      );
    }
    await claimGradingJobs({ claimant: "narrowed-4", capacity: 50 });

    expect((await getGradingJob(auth, job.id))?.status).toBe("abandoned");
    expect(await narrowedTo(job.id)).toBeNull();
  });

  it("is refused by the table on work that has settled, rather than by every writer remembering", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);
    expect(job.status).toBe("graded");

    await expect(
      database.sql(
        "update grading_job set regrade_grader_id = $2 where id = $1",
        [job.id, graderId],
      ),
    ).rejects.toThrow("grading_job_only_outstanding_work_is_narrowed");
  });

  it("answers with nothing at all for a grader nobody can reach", async () => {
    const { runId, simulationId } = await aJudgedSimulation();
    const theirs = await aGrader(outsider, "Globex's own");
    const deleted = await aGrader();
    await deleteGrader(auth, deleted);

    // Another customer's, one that was never created, and one that has gone:
    // three ways of naming a thing that is not there, and the same answer to
    // all three — which is what keeps this call from confirming a grader exists.
    expect(await regrade(auth, { runId, graderId: theirs })).toBeUndefined();
    expect(
      await regrade(auth, { runId, graderId: newId("grd") }),
    ).toBeUndefined();
    expect(await regrade(auth, { runId, graderId: deleted })).toBeUndefined();

    // And nothing was reopened on the way to saying so.
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("refuses out loud a name that is not a grader identifier at all", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await expect(
      regrade(auth, { runId, graderId: "Answers inside two seconds" }),
    ).rejects.toThrow("not one");
    await expect(
      regrade(auth, { runId, graderId: newId("tst") }),
    ).rejects.toThrow("not one");

    expect((await theJobFor(simulationId)).status).toBe("graded");
  });

  it("narrows a window exactly as it narrows a run", async () => {
    const { simulationId } = await aJudgedSimulation();
    const job = await theJobFor(simulationId);
    await becameJudgeableAt(job.id, "2026-06-01T09:00:00Z");

    const asked = await regrade(auth, {
      window: {
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-02T00:00:00Z"),
      },
      graderId,
    });

    expect(asked?.graderId).toBe(graderId);
    expect(asked?.reopened.map((row) => row.id)).toEqual([job.id]);
    expect(await narrowedTo(job.id)).toBe(graderId);
  });

  it("is refused to a viewer, who cannot spend the judge on history at any width", async () => {
    const { runId, simulationId } = await aJudgedSimulation();

    await expect(
      regrade(actingAsAcme("viewer"), { runId, graderId }),
    ).rejects.toThrow(NotPermittedError);
    expect((await theJobFor(simulationId)).status).toBe("graded");
  });
});

/**
 * A re-grade is asked for most often while grading is running, which is exactly
 * when the queue is moving under it.
 *
 * Which conversations have settled, which are already waiting, which are being
 * judged under a narrowing that does not cover the ask, and which are reopened
 * are four readings of one queue. Read apart, a worker moving one job between
 * two of them made them four readings of four different queues — and the worst
 * of those said *already waiting, nothing was asked twice* about a job that had
 * just gone back into the queue still narrowed to somebody else's grader. The
 * ask went nowhere and nobody was told.
 *
 * So the whole decision is one transaction over jobs held still, and that is
 * what is proved here: not by reading the source, but by holding a worker's own
 * transaction open at the moment the race needs it and watching the re-grade
 * refuse to answer across it.
 *
 * Deterministic: the worker's transaction is held open by hand and released by a
 * statement, never by a timer.
 */
describe("a re-grade asked while a worker is moving the same job", () => {
  /** Long enough for a blocked query to be blocked rather than merely slow. */
  const A_BEAT = 250;

  async function hasFinished(work: Promise<unknown>): Promise<boolean> {
    const finished = Symbol("finished");
    const outcome = await Promise.race([
      work.then(
        () => finished,
        () => finished,
      ),
      new Promise((resolve) => setTimeout(resolve, A_BEAT)),
    ]);
    return outcome === finished;
  }

  /**
   * One conversation queued for `graderId` alone and taken by a copy of the
   * grader service — the state both races below start from, because the column
   * decides nothing for a claimed job and finishing or releasing it is what
   * changes what the ask should be told.
   */
  async function aNarrowedJudgmentUnderWay(): Promise<{
    readonly runId: string;
    readonly jobId: string;
  }> {
    const { runId, simulationId } = await aJudgedSimulation();
    await regrade(auth, { runId, graderId });

    const job = await theJobFor(simulationId);
    const claimant = `grader-holding-${job.id.slice(-6)}`;
    const claimed = await claimGradingJobs({ claimant, capacity: 50 });
    if (!claimed.some((claim) => claim.id === job.id)) {
      throw new Error("the narrowed job was not claimed");
    }
    expect(await narrowedTo(job.id)).toBe(graderId);

    return { runId, jobId: job.id };
  }

  it("waits for a release to land, and widens the job the worker put back", async () => {
    const { runId, jobId } = await aNarrowedJudgmentUnderWay();
    const otherGrader = await aGrader();

    const worker = await openSingleConnection(database.url);
    try {
      // The copy that took this conversation gives it up, in its own
      // transaction and not yet committed: the row is held, and outside this
      // connection the job still reads as claimed.
      await worker.sql("begin");
      await worker.sql(
        `update grading_job
            set status = 'pending', claimed_by = null, claimed_at = null,
                heartbeat_at = null, last_error = 'this copy could not finish'
          where id = $1`,
        [jobId],
      );

      const asking = regrade(auth, { runId, graderId: otherGrader });
      // Held rather than raced. A re-grade that answered here would answer about
      // a queue the worker is in the middle of moving.
      expect(await hasFinished(asking)).toBe(false);

      await worker.sql("commit");
      const second = await asking;

      // And what it answers is about the queue as the worker left it: the job is
      // waiting again, narrowed to a grader nobody asked about, so the widen
      // reaches it. This is the whole of what was lost when the statements ran
      // apart — the ask used to be reported as covered and the job used to stay
      // narrowed to somebody else's grader.
      expect(await narrowedTo(jobId)).toBeNull();
      expect(second?.reopened).toEqual([]);
      expect(second?.alreadyWaiting).toBe(1);
      expect(second?.beingJudgedNarrower).toBe(0);
    } finally {
      await worker.sql("rollback").catch(() => undefined);
      await worker.close();
    }
  });

  it("waits for a finish to land, and asks again for the conversation it judged", async () => {
    const { runId, jobId } = await aNarrowedJudgmentUnderWay();

    const worker = await openSingleConnection(database.url);
    try {
      // The judgment finishes, in its own transaction and not yet committed.
      await worker.sql("begin");
      await worker.sql(
        `update grading_job
            set status = 'graded', finished_at = now(), heartbeat_at = now(),
                last_error = null, regrade_grader_id = null
          where id = $1`,
        [jobId],
      );

      const asking = regrade(auth, { runId });
      expect(await hasFinished(asking)).toBe(false);

      await worker.sql("commit");
      const second = await asking;

      // The conversation was judged a moment ago, so there is something to ask
      // for again. Answering across the finish found it neither settled nor
      // outstanding and reported a conversation nobody had ever judged.
      expect(second?.reopened.map((row) => row.id)).toEqual([jobId]);
      expect(second?.alreadyWaiting).toBe(0);
      expect(second?.beingJudgedNarrower).toBe(0);
      expect((await getGradingJob(auth, jobId))?.status).toBe("pending");
    } finally {
      await worker.sql("rollback").catch(() => undefined);
      await worker.close();
    }
  });

  /**
   * The other half of holding a whole window still: what it costs the service
   * that is trying to work. A claim is `for update skip locked`, so it never
   * queues behind a re-grade — it passes the held conversations over and takes
   * whatever else is waiting, and the reopen's notification brings it back.
   */
  it("costs a claim nothing: held work is passed over rather than waited on", async () => {
    // Whatever this file has left waiting is taken out of the way first, so what
    // the claim below reaches is about the hold and about nothing else.
    for (let sweep = 0; sweep < 20; sweep += 1) {
      const drained = await claimGradingJobs({
        claimant: "grader-clearing-the-way",
        capacity: 50,
      });
      if (drained.length === 0) break;
    }

    const held = await aFinishedSimulation();
    const free = await aFinishedSimulation();
    const heldJob = await theJobFor(held.simulationId);
    const freeJob = await theJobFor(free.simulationId);

    const holder = await openSingleConnection(database.url);
    try {
      // Exactly the hold a re-grade takes, on one of the two.
      await holder.sql("begin");
      await holder.sql(
        "select id from grading_job where id = $1 order by id for update",
        [heldJob.id],
      );

      const claimant = `grader-past-a-hold-${heldJob.id.slice(-6)}`;
      const claiming = claimGradingJobs({ claimant, capacity: 50 });
      expect(await hasFinished(claiming)).toBe(true);

      const claimed = await claiming;
      expect(claimed.some((claim) => claim.id === heldJob.id)).toBe(false);
      expect(claimed.some((claim) => claim.id === freeJob.id)).toBe(true);

      // And the moment the hold ends, the conversation is claimable again — it
      // was passed over for the length of a transaction, never lost.
      await holder.sql("rollback");
      const after = await claimGradingJobs({
        claimant: `${claimant}-again`,
        capacity: 50,
      });
      expect(after.some((claim) => claim.id === heldJob.id)).toBe(true);
    } finally {
      await holder.sql("rollback").catch(() => undefined);
      await holder.close();
    }
  });
});
