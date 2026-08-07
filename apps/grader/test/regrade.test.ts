import {
  editGrader,
  listGradingJobsForSimulation,
  readVerdicts,
  regrade,
  speakingVerdicts,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aThreshold,
  conductSimulation,
  eventually,
  makeWorld,
  runService,
  seedGrader,
  testConfig,
  type ConductedSimulation,
  type World,
} from "./support/world.ts";
import type { Service } from "../src/service.ts";

/**
 * Re-grading, end to end: a grader is tightened, history is asked for again on
 * purpose, and the new grading lands beside the old rather than over it.
 *
 * **The whole point is what does *not* happen.** Editing a grader is the
 * ordinary act — somebody fixes a threshold on a Tuesday — and this file's first
 * case is that the fix reaches nothing already judged. Everything after it is
 * what a person gets when they ask for history back, deliberately, having
 * decided that is what they want.
 *
 * The contract is the seam here as everywhere in this suite: a conversation, a
 * grader edit and a re-grade go in; the assertions are on the verdict rows and
 * on the folded answer over them. Nothing here knows how the service found the
 * work.
 */

let world: World;
let service: Service;
let graderId: string;

/** The conversation's rows once there are at least this many. */
async function verdictsOn(
  simulationId: string,
  atLeast: number,
): Promise<readonly RecordedVerdict[]> {
  return eventually(`${atLeast} verdicts on ${simulationId}`, async () => {
    const read = await readVerdicts(world.auth, simulationId);
    return read.verdicts.length >= atLeast ? read.verdicts : undefined;
  });
}

/** One judged conversation the agent answered quickly. */
async function aFastConversation(): Promise<ConductedSimulation> {
  const conducted = await conductSimulation(world, {
    metrics: { turn_response_latency: [900, 1_100] },
  });
  await verdictsOn(conducted.simulationId, 1);
  return conducted;
}

/**
 * Long enough for the service to have done something wrong, if it were going
 * to. A test that asserts nothing happened has to give the thing a chance to
 * happen, or it is asserting that the assertion ran first.
 */
async function aMoment(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

beforeAll(async () => {
  world = await makeWorld("grader_regrade");
  // P1 and two seconds, so that tightening it later changes both what the
  // grader says and how loudly it says it.
  graderId = await seedGrader(
    world,
    aThreshold({ name: "Answers inside two seconds", priority: "P1" }),
  );
  service = runService(testConfig());
});

afterAll(async () => {
  service.stop();
  await service.finished;
  await world.drop();
});

describe("editing a grader", () => {
  let judged: ConductedSimulation;
  let alsoJudged: ConductedSimulation;
  let before: readonly RecordedVerdict[];
  let alsoBefore: readonly RecordedVerdict[];

  it("changes no verdict row that was already written, anywhere", async () => {
    judged = await aFastConversation();
    alsoJudged = await aFastConversation();

    before = await verdictsOn(judged.simulationId, 1);
    alsoBefore = await verdictsOn(alsoJudged.simulationId, 1);
    expect(before[0]).toMatchObject({ verdict: "passed", priority: "P1" });

    // The edit: a tighter threshold, and the warning promoted to a blocker.
    // Both of them are what somebody does after deciding the grader was wrong.
    const edited = await editGrader(world.auth, graderId, {
      priority: "P0",
      config: {
        measure: "turn_response_latency",
        aggregation: "p90",
        comparator: "below",
        threshold: 1_000,
      },
    });
    expect(edited?.version).toBe(2);
    expect(edited?.priority).toBe("P0");

    await aMoment();

    // Row for row, byte for byte: the version that decided them, the word, the
    // priority they were made under, the moment they were stamped at. A
    // tightened grader reaches yesterday through one call and this is not it.
    expect((await readVerdicts(world.auth, judged.simulationId)).verdicts).toEqual(
      before,
    );
    expect(
      (await readVerdicts(world.auth, alsoJudged.simulationId)).verdicts,
    ).toEqual(alsoBefore);
  });

  it("leaves the conversations judged and asks nothing of the queue", async () => {
    const [job] = await listGradingJobsForSimulation(
      world.auth,
      judged.simulationId,
    );
    expect(job?.status).toBe("graded");
    expect(job?.attempts).toBe(1);
  });

  describe("and then a re-grade of the run it judged", () => {
    it("writes the new grading beside the old one, with both readable", async () => {
      const asked = await regrade(world.auth, { runId: judged.runId });
      expect(asked?.reopened).toHaveLength(1);

      const rows = await verdictsOn(judged.simulationId, 2);
      expect(rows).toHaveLength(2);

      const first = before[0];
      const older = rows.find(
        (row) => row.graderVersionId === first?.graderVersionId,
      );
      const newer = rows.find(
        (row) => row.graderVersionId !== first?.graderVersionId,
      );

      // The old grading, untouched and still fetchable — the same row, not a
      // rewrite of it.
      expect(older).toEqual(first);
      // And the new one beside it, at the version that decided it.
      expect(newer).toMatchObject({
        graderId,
        dimension: "metric_threshold",
        verdict: "failed",
        source: "simulation",
        judgedBy: "engine",
      });
      expect(newer?.graderVersionId).not.toBe(first?.graderVersionId);
    });

    it("reads back as the newest grading, with the older one underneath", async () => {
      const read = await readVerdicts(world.auth, judged.simulationId);

      const speaking = speakingVerdicts(read.verdicts);
      expect(speaking).toHaveLength(1);
      expect(speaking[0]?.verdict).toBe("failed");

      // The conversation passed under the old grader and fails under the new
      // one, and the headline is the newest grading's, computed over rows that
      // both still exist.
      expect(read.outcome.verdict).toBe("failed");
      expect(read.outcome.counts).toMatchObject({ passed: 0, failed: 1, total: 1 });
      expect(read.verdicts).toHaveLength(2);
    });

    it("snapshots today's priority on the new rows and leaves yesterday's alone", async () => {
      const rows = await readVerdicts(world.auth, judged.simulationId);
      const first = before[0];

      const older = rows.verdicts.find(
        (row) => row.graderVersionId === first?.graderVersionId,
      );
      const newer = rows.verdicts.find(
        (row) => row.graderVersionId !== first?.graderVersionId,
      );

      // The priority is a live setting, snapshotted at the moment of judging.
      // Yesterday's row was made when this check was a warning and still says
      // so; today's was made after it became a blocker.
      expect(older?.priority).toBe("P1");
      expect(newer?.priority).toBe("P0");
    });

    it("reopened the conversation's one job rather than filing a second", async () => {
      const jobs = await listGradingJobsForSimulation(
        world.auth,
        judged.simulationId,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("graded");
      // Claimed once for the first grading and once for this one, on the same
      // row, with the attempts reset in between.
      expect(jobs[0]?.attempts).toBe(1);
    });

    it("left every conversation nobody asked about exactly as it was", async () => {
      expect(
        (await readVerdicts(world.auth, alsoJudged.simulationId)).verdicts,
      ).toEqual(alsoBefore);
    });
  });
});

describe("a re-grade of a window", () => {
  /**
   * The half that will cover production, which belongs to no run. The
   * conversation is a simulation because that is the only source the queue
   * carries today; what the window is measured on — when a conversation became
   * judgeable — is the same fact for both.
   */
  it("re-judges what became judgeable inside it, at the grader's current version", async () => {
    const from = new Date();
    const judged = await aFastConversation();
    const before = await verdictsOn(judged.simulationId, 1);

    const edited = await editGrader(world.auth, graderId, {
      config: {
        measure: "turn_response_latency",
        aggregation: "p90",
        comparator: "below",
        threshold: 500,
      },
    });
    expect(edited?.version).toBe(3);

    const asked = await regrade(world.auth, {
      window: { from, to: new Date(Date.now() + 60_000) },
    });
    expect(asked?.reopened.map((job) => job.simulationId)).toEqual([
      judged.simulationId,
    ]);

    const rows = await verdictsOn(judged.simulationId, 2);
    const versions = new Set(rows.map((row) => row.graderVersionId));

    expect(versions.size).toBe(2);
    expect(versions.has(before[0]?.graderVersionId ?? "")).toBe(true);
    expect(
      (await readVerdicts(world.auth, judged.simulationId)).outcome.verdict,
    ).toBe("failed");
  });
});
