import {
  claimGradingJobs,
  listGradingJobsForSimulation,
  readVerdicts,
  type GradingJob,
} from "@egma/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  aThreshold,
  conductSimulation,
  eventually,
  makeWorld,
  runService,
  seedGrader,
  testConfig,
  type World,
} from "./support/world.ts";
import type { Service } from "../src/service.ts";

/**
 * Scaling the service is running more copies of it, and this is what that has
 * to mean: two copies drain one queue between them, one conversation is never
 * judged twice, and a copy that dies holding work costs one lease rather than a
 * verdict.
 *
 * Everything here races real transactions against a real Postgres and a real
 * ClickHouse, because the guarantees under test are theirs — `SKIP LOCKED`
 * keeping two claims apart, and the store's identity collapsing a second
 * judgment onto the one it repeats instead of filing it beside it.
 *
 * **Each case starts the copies it needs and stops them afterwards**, rather
 * than the file running a fleet throughout. Two of these are about work being
 * taken back off somebody, and a copy left running in the background would be
 * racing the test to take it first — which is the right behaviour and the wrong
 * experiment.
 */

let world: World;
let running: Service[] = [];

/**
 * A copy of the service, stopped when the case is over.
 *
 * A short lease and a fast backstop, because most of this file is about work
 * that becomes claimable with no transition to announce it: a lease running out
 * is a clock rather than an event, and nothing can notify anybody of it. The
 * acceptance suite keeps its backstop an hour out, which is where the "no
 * interval on the path a verdict travels" claim is actually proved.
 */
function aCopy(claimant: string): Service {
  const service = runService(
    testConfig({
      claimant,
      capacity: 2,
      leaseSeconds: 10,
      heartbeatSeconds: 1,
      sweepSeconds: 1,
    }),
  );
  running.push(service);
  return service;
}

/** The one job a conversation has, once it has settled into a state. */
async function jobFor(
  simulationId: string,
  settled: GradingJob["status"],
): Promise<GradingJob> {
  return eventually(
    `job for ${simulationId} to be ${settled}`,
    async () => {
      const [only] = await listGradingJobsForSimulation(world.auth, simulationId);
      return only?.status === settled ? only : undefined;
    },
    30_000,
  );
}

/**
 * How many rows the store actually holds for this conversation, **without
 * `FINAL`** — which is the only way to tell "one copy wrote once" apart from
 * "two copies wrote and the engine hid it".
 */
async function rowsStoredFor(simulationId: string): Promise<number> {
  const [row] = await world.store.rows<{ how_many: string }>(
    `select count() as how_many from verdicts where trace_id = '${simulationId}'`,
  );
  return Number(row?.how_many ?? 0);
}

beforeAll(async () => {
  world = await makeWorld("grader_two_copies");
  await seedGrader(world, aThreshold());
});

afterEach(async () => {
  const stopping = running;
  running = [];
  for (const service of stopping) service.stop();
  await Promise.all(stopping.map((service) => service.finished));
});

afterAll(async () => {
  await world.drop();
});

describe("two copies running at once", () => {
  it("never judge one conversation twice", async () => {
    aCopy("grader-blue");
    aCopy("grader-green");

    const conducted = await Promise.all(
      Array.from({ length: 6 }, () => conductSimulation(world)),
    );

    const held = new Set<string>();
    for (const { simulationId } of conducted) {
      const job = await jobFor(simulationId, "graded");
      held.add(job.claimedBy ?? "");

      // One grader, one dimension, one row — and asked of the store directly,
      // so a second copy having written the same judgment would show up here as
      // two rows rather than being collapsed out of sight by a read.
      expect(await rowsStoredFor(simulationId)).toBe(1);
      expect(job.attempts).toBe(1);
    }

    // Both copies did work, which is what makes the assertion above about
    // sharing rather than about one copy having been asleep.
    expect(held.size).toBe(2);
  });
});

describe("a copy that died holding a conversation", () => {
  /**
   * A crash is indistinguishable from silence, so this is a crash: the claim is
   * on the row, no verdicts were written, and the heartbeat stops. Nothing
   * releases it, because there is nothing left running to do the releasing.
   */
  it("loses the job to whichever copy is still running, once the lease runs out", async () => {
    const { simulationId } = await conductSimulation(world);

    // Taken while no copy is running, so the dying one is certainly the one
    // that took it — the experiment is what happens next, not who got there.
    const [held] = await claimGradingJobs({
      claimant: "grader-that-died",
      capacity: 1,
      leaseSeconds: 3_600,
    });
    if (held === undefined || held.simulationId !== simulationId) {
      throw new Error("the dying copy did not take the conversation");
    }
    expect(await rowsStoredFor(simulationId)).toBe(0);

    await world.database.sql(
      "update grading_job set heartbeat_at = now() - interval '1 hour' where id = $1",
      [held.id],
    );

    aCopy("grader-that-lived");
    const job = await jobFor(simulationId, "graded");

    expect(job.claimedBy).toBe("grader-that-lived");
    expect(job.attempts).toBe(2);
    // The conversation was judged once in the end, whatever happened in the
    // middle: the dead copy wrote nothing, so there is nothing doubled.
    expect(await rowsStoredFor(simulationId)).toBe(1);
  });
});

describe("judging one conversation again at the same grader version", () => {
  /**
   * Which is what a re-run after a transient failure is, and what ticket 08's
   * explicit re-grade will be: the job is reopened rather than a second one
   * created. The store's identity spans the grader version, so the second
   * judgment is a rewrite of the first rather than a row beside it — the
   * conversation's answer cannot come to disagree with itself.
   */
  it("replaces the judgment rather than doubling it", async () => {
    aCopy("grader-again");

    const { simulationId } = await conductSimulation(world);
    const first = await jobFor(simulationId, "graded");

    const before = await readVerdicts(world.auth, simulationId);
    expect(before.verdicts).toHaveLength(1);

    // Reopened, exactly as a re-grade reopens it. Raw, because the API for
    // asking is ticket 08's and the storage behaviour is what is under test.
    await world.database.sql(
      "update grading_job set status = 'pending', claimed_by = null, claimed_at = null, heartbeat_at = null, finished_at = null, attempts = 0 where id = $1",
      [first.id],
    );

    await eventually(
      "the conversation to be judged again",
      async () => {
        const [only] = await listGradingJobsForSimulation(world.auth, simulationId);
        return only?.status === "graded" && only.attempts === 1 ? only : undefined;
      },
      30_000,
    );

    const after = await readVerdicts(world.auth, simulationId);
    expect(after.verdicts).toHaveLength(before.verdicts.length);
    expect(after.outcome).toEqual(before.outcome);

    const speaking = after.verdicts[0];
    const said = before.verdicts[0];
    expect(speaking?.graderVersionId).toBe(said?.graderVersionId);
    expect(speaking?.verdict).toBe(said?.verdict);
    // The later judgment is the one that survives — the store keeps rows by the
    // moment they were made, and the second grading happened after the first.
    expect(
      (speaking?.judgedAtMicroseconds ?? 0n) > (said?.judgedAtMicroseconds ?? 0n),
    ).toBe(true);
  });
});
