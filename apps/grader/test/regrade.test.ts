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
  aLatencyCopy,
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  runService,
  seedGrader,
  seedTest,
  testConfig,
  theSeededGrader,
  verdictsOn,
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

/**
 * One judged conversation the agent answered quickly — **judged and settled.**
 *
 * The verdict row lands a moment before the job that produced it is marked
 * `graded`, and a re-grade reopens *settled* jobs and nothing else. Waiting only
 * for the row leaves a gap in which `regrade` finds nothing to reopen and
 * answers an empty list, which is a correct answer to a question this file did
 * not mean to ask. So the wait is for the job, which is the thing every case
 * below actually depends on.
 */
async function aFastConversation(): Promise<ConductedSimulation> {
  const conducted = await conductSimulation(world, {
    spans: { measured: { turn_response_latency: [900, 1_100] } },
  });
  await verdictsOn(world, conducted.simulationId, 1);
  await jobFor(world, { simulationId: conducted.simulationId }, "graded");
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
  // A bound somebody will tighten later, which is the ordinary reason a grader
  // gets a second version at all.
  graderId = await seedGrader(
    world,
    aLatencyCopy({ name: "Answers inside two seconds" }),
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

    before = await verdictsOn(world, judged.simulationId, 1);
    alsoBefore = await verdictsOn(world, alsoJudged.simulationId, 1);
    // Inside the two seconds this copy asks for: the conversation's worst turn
    // took 1100 milliseconds. What this file is about is the verdict store's
    // mechanics — which version decided a row, and what a re-grade does to the
    // rows already there — and the tightening below is what makes the same
    // conversation answer differently at the next version.
    expect(before[0]).toMatchObject({
      assertion: "turn_response_latency",
      verdict: "passed",
    });

    // The edit: a tighter bound, which is what somebody does after deciding the
    // grader was wrong.
    const edited = await editGrader(world.auth, graderId, {
      config: { assertions: [{ metric: "turn_response_latency", bound: 1_000 }] },
    });
    expect(edited?.version).toBe(2);

    await aMoment();

    // Row for row, byte for byte: the version that decided them, the word, the
    // moment they were stamped at. A tightened grader reaches yesterday through
    // one call and this is not it.
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

      const rows = await verdictsOn(world, judged.simulationId, 2);
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
      // And the new one beside it, at the version that decided it — the same
      // conversation, now over the bound somebody tightened to a second.
      expect(newer).toMatchObject({
        graderId,
        assertion: "turn_response_latency",
        verdict: "failed",
        source: "simulation",
      });
      expect(newer?.graderVersionId).not.toBe(first?.graderVersionId);
    });

    it("reads back as the newest grading, with the older one underneath", async () => {
      const read = await readVerdicts(world.auth, judged.simulationId);

      const speaking = speakingVerdicts(read.verdicts);
      expect(speaking).toHaveLength(1);
      expect(speaking[0]?.graderVersionId).not.toBe(before[0]?.graderVersionId);

      // **One voice per check, and it is the newest grading's** — computed over
      // rows that both still exist. The older row is not deleted and not
      // rewritten; it simply stops speaking, which is what keeps "what did we
      // think last week" answerable at all. The headline is the tightened
      // grader's `failed`, and the `passed` underneath it is still readable.
      expect(read.outcome.counts).toMatchObject({ failed: 1, total: 1 });
      expect(read.verdicts).toHaveLength(2);
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
    const before = await verdictsOn(world, judged.simulationId, 1);

    const edited = await editGrader(world.auth, graderId, {
      config: { assertions: [{ metric: "turn_response_latency", bound: 500 }] },
    });
    expect(edited?.version).toBe(3);

    const asked = await regrade(world.auth, {
      window: { from, to: new Date(Date.now() + 60_000) },
    });
    expect(asked?.reopened.map((job) => job.simulationId)).toEqual([
      judged.simulationId,
    ]);

    const rows = await verdictsOn(world, judged.simulationId, 2);
    const versions = new Set(rows.map((row) => row.graderVersionId));

    expect(versions.size).toBe(2);
    expect(versions.has(before[0]?.graderVersionId ?? "")).toBe(true);
    // Judged again at the version the edit minted, and the headline is that
    // grading's — computed over both rows, with the older one still there and
    // no longer speaking.
    const read = await readVerdicts(world.auth, judged.simulationId);
    expect(read.outcome.counts.total).toBe(1);
    expect(speakingVerdicts(read.verdicts)[0]?.graderVersionId).toBe(
      edited?.versionId,
    );
  });
});

/**
 * **A copy whose list of checks changes shape underneath a conversation.**
 *
 * This is the case that decides how a latency verdict is keyed, and the premise
 * is worth stating because it is the opposite of what the spec's phrase "copy
 * config pinned" suggests: **a run pins no grader version.** A simulation pins
 * its test version and its persona version and nothing else, and judging always
 * reads the copy through `grader.current_version_id` — `applicableGraders` →
 * `listGraders` → the join on that column — so a re-grade of an old run judges
 * it by *today's* config, at a new version, writing rows beside the old ones.
 *
 * The fold then counts one assertion once per `[trace, grader, assertion,
 * source]`, deliberately without the version, which is what makes a re-grade
 * supersede rather than double. So two config versions really do meet in one
 * fold for one conversation, and whatever the key is has to survive that.
 *
 * A **position** does not. Drop the first of two entries and the second becomes
 * the first: the key that meant `turn_response_latency` on Monday means
 * `first_response_latency` on Tuesday, and Tuesday's row silently replaces
 * Monday's. That is a verdict about one measure overwritten by a verdict about
 * another, filed under a name saying it is about something else.
 *
 * The **measure** does survive it, which is why it is the key.
 */
describe("a copy that loses one of its checks", () => {
  /** The copy and the conversation the second case reads back. */
  let twoChecks: string;
  let conducted: ConductedSimulation;

  it("never lets one measure's verdict be replaced by another's", async () => {
    // A copy checking two measures, and a conversation that measures both.
    twoChecks = await seedGrader(
      world,
      aLatencyCopy({
        name: "Two measures, one copy",
        params: { metric: "turn_response_latency", bound: 2_000 },
      }),
    );
    const both = await editGrader(world.auth, twoChecks, {
      config: {
        assertions: [
          { metric: "turn_response_latency", bound: 2_000 },
          { metric: "first_response_latency", bound: 1_000 },
        ],
      },
    });
    expect(both?.version).toBe(2);

    conducted = await conductSimulation(world, {
      spans: {
        measured: {
          // Inside its bound, and the first response is well outside its own.
          turn_response_latency: [900],
          first_response_latency: [4_000],
        },
      },
    });
    await jobFor(world, { simulationId: conducted.simulationId }, "graded");

    const before = (await readVerdicts(world.auth, conducted.simulationId))
      .verdicts.filter((row) => row.graderId === twoChecks);

    // **Named for what they are about**, which is the whole change: two rows,
    // one per measure, and neither of them a position.
    expect(before.map((row) => row.assertion).sort()).toEqual([
      "first_response_latency",
      "turn_response_latency",
    ]);
    expect(
      before.find((row) => row.assertion === "turn_response_latency")?.verdict,
    ).toBe("passed");
    expect(
      before.find((row) => row.assertion === "first_response_latency")?.verdict,
    ).toBe("failed");

    // Now the edit that used to break this: **the first entry is removed**, so
    // what was the second check is now the copy's first.
    const narrowed = await editGrader(world.auth, twoChecks, {
      config: { assertions: [{ metric: "first_response_latency", bound: 1_000 }] },
    });
    expect(narrowed?.version).toBe(3);

    const asked = await regrade(world.auth, {
      runId: conducted.runId,
      graderId: twoChecks,
    });
    expect(asked?.reopened).toHaveLength(1);

    const after = await eventually(
      `${twoChecks} judged again at ${narrowed?.versionId}`,
      async () => {
        const read = await readVerdicts(world.auth, conducted.simulationId);
        const mine = read.verdicts.filter((row) => row.graderId === twoChecks);
        return mine.some((row) => row.graderVersionId === narrowed?.versionId)
          ? mine
          : undefined;
      },
    );

    /**
     * **Nothing was mis-attributed.** Every row still says which measure it is
     * about, and every row about a measure agrees about that measure: the
     * `turn_response_latency` rows all say `passed`, the
     * `first_response_latency` rows all say `failed`. Under a positional key the
     * new `assertion_1` would be the first-response check landing on top of the
     * turn-latency verdict, and this is the assertion that would fail.
     */
    for (const row of after) {
      expect(
        row.assertion,
        `${row.assertion} at ${row.graderVersionId} said ${row.verdict}`,
      ).toBe(
        row.verdict === "passed"
          ? "turn_response_latency"
          : "first_response_latency",
      );
    }

    // The re-graded check superseded its own earlier row rather than landing
    // beside it: one voice per measure.
    const speaking = speakingVerdicts(after);
    expect(speaking.map((row) => row.assertion).sort()).toEqual([
      "first_response_latency",
      "turn_response_latency",
    ]);
    expect(
      speaking.find((row) => row.assertion === "first_response_latency")
        ?.graderVersionId,
    ).toBe(narrowed?.versionId);
  });

  /**
   * **And what a removed check leaves behind, pinned as a decision.**
   *
   * The row a deleted entry already wrote keeps speaking, because nothing writes
   * that key again and the fold does not know the entry is gone. **No keying
   * scheme changes this** — position, measure, or a minted id all leave the same
   * row — so it is not a defect in the key; it is the same shape a **deleted
   * grader** has, whose verdicts keep speaking by an explicit product decision:
   * "a grader deleted after a run keeps its versions, so what it already said
   * stays readable" (`resolve.ts`).
   *
   * Written down here so it stays a decision somebody made rather than a
   * surprise somebody finds. If the founders would rather a removed check stop
   * counting, that is a change to the fold or a tombstone row, and it belongs to
   * whoever owns the fold.
   */
  it("keeps what a removed check already said, exactly as a deleted grader does", async () => {
    const read = await readVerdicts(world.auth, conducted.simulationId);
    const mine = read.verdicts.filter((row) => row.graderId === twoChecks);

    // The removed check's row is still in the store and still speaking, at the
    // version that wrote it — the copy has one entry now and two voices.
    const speaking = speakingVerdicts(mine);
    expect(speaking.map((row) => row.assertion).sort()).toEqual([
      "first_response_latency",
      "turn_response_latency",
    ]);
    const removed = speaking.find(
      (row) => row.assertion === "turn_response_latency",
    );
    expect(removed?.verdict).toBe("passed");
  });
});

/**
 * The ask that names a grader, which the ticket's words allow for: "a run (or a
 * time window) **and a grader**".
 *
 * **It is a question about spend and never about the rows.** Re-judging the
 * conversation whole accumulates exactly the rows re-judging one grader would,
 * because a grader nobody edited rewrites its own row in place. What it also
 * does is ask every judge on that conversation again, and somebody who fixed one
 * rubric did not ask to pay for the other four. So the assertions below are
 * about what stayed byte for byte where it was: the other grader's rows, and the
 * built-in's — the two things a narrowed re-grade must not spend a judge on.
 */
describe("a re-grade that names one grader", () => {
  /** The second authored grader, and the one every ask below names. */
  let alsoJudging: string;
  let conducted: ConductedSimulation;
  let before: readonly RecordedVerdict[];
  /** The version the narrowed re-grade wrote its first row at. */
  let tightened: string;

  const rowsFrom = (
    verdicts: readonly RecordedVerdict[],
    grader: string,
  ): readonly RecordedVerdict[] =>
    verdicts.filter((row) => row.graderId === grader);

  /** The conversation judged and settled, so the next ask is a re-grade. */
  async function judgedAndSettled(): Promise<readonly RecordedVerdict[]> {
    await jobFor(world, { simulationId: conducted.simulationId }, "graded");
    return (await readVerdicts(world.auth, conducted.simulationId)).verdicts;
  }

  it("judges the grader it names, and leaves every other row exactly where it was", async () => {
    // Three voices on one conversation: the file's grader, a second one, and
    // the project's expected-behaviors copy judging the test's behaviors. Only
    // one of them is asked again, and the other two are the assertion.
    alsoJudging = await seedGrader(
      world,
      aLatencyCopy({
        name: "Answers inside five seconds",
        params: { metric: "turn_response_latency", bound: 5_000 },
      }),
    );
    const testId = await seedTest(world);
    conducted = await conductSimulation(world, {
      testId,
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });

    before = await verdictsOn(world, conducted.simulationId, 3);
    await judgedAndSettled();
    expect(rowsFrom(before, alsoJudging)).toHaveLength(1);
    expect(rowsFrom(before, graderId)).toHaveLength(1);
    // No judge is configured in this file, so the expected-behaviors copy says
    // out loud that it could not make the check. That it is `errored` rather
    // than absent is what makes it a row this re-grade could have rewritten and
    // did not.
    const seeded = await theSeededGrader(world);
    expect(rowsFrom(before, seeded)).toHaveLength(1);

    // The fix somebody made, on one grader: a tighter bound.
    const edited = await editGrader(world.auth, alsoJudging, {
      config: { assertions: [{ metric: "turn_response_latency", bound: 500 }] },
    });
    expect(edited?.version).toBe(2);
    tightened = edited?.versionId ?? "";

    const asked = await regrade(world.auth, {
      runId: conducted.runId,
      graderId: alsoJudging,
    });
    expect(asked?.graderId).toBe(alsoJudging);
    expect(asked?.reopened).toHaveLength(1);

    const after = await eventually(
      `the second grading of ${alsoJudging}`,
      async () => {
        const read = await readVerdicts(world.auth, conducted.simulationId);
        return rowsFrom(read.verdicts, alsoJudging).length >= 2
          ? read.verdicts
          : undefined;
      },
    );

    // The named grader judged, at the version that decided it.
    expect(rowsFrom(after, alsoJudging)).toHaveLength(2);
    expect(
      rowsFrom(after, alsoJudging).find(
        (row) => row.graderVersionId === tightened,
      ),
    ).toMatchObject({
      verdict: "failed",
      assertion: "turn_response_latency",
    });

    // And nothing else was asked anything. Row for row, byte for byte — the
    // moment each was stamped at included, which is what tells "not judged
    // again" apart from "judged again and said the same thing".
    expect(rowsFrom(after, graderId)).toEqual(rowsFrom(before, graderId));
    expect(rowsFrom(after, seeded)).toEqual(rowsFrom(before, seeded));
  });

  it("rewrites that grader's own row when nothing about the grader changed", async () => {
    const rewriting = rowsFrom(await judgedAndSettled(), alsoJudging).find(
      (row) => row.graderVersionId === tightened,
    );
    if (rewriting === undefined) throw new Error("nothing to rewrite");

    const asked = await regrade(world.auth, {
      runId: conducted.runId,
      graderId: alsoJudging,
    });
    expect(asked?.reopened).toHaveLength(1);

    const after = await eventually(
      `${alsoJudging} judged again at ${tightened}`,
      async () => {
        const read = await readVerdicts(world.auth, conducted.simulationId);
        const now = rowsFrom(read.verdicts, alsoJudging).find(
          (row) => row.graderVersionId === tightened,
        );
        return now !== undefined &&
          now.judgedAtMicroseconds > rewriting.judgedAtMicroseconds
          ? read.verdicts
          : undefined;
      },
    );

    // Still two rows for this grader, not three: the same grader at the same
    // version saying something about the same assertion again replaces itself,
    // which is why re-judging one grader and re-judging the conversation
    // accumulate identically and the narrowing is only ever about spend.
    const seeded = await theSeededGrader(world);
    expect(rowsFrom(after, alsoJudging)).toHaveLength(2);
    expect(rowsFrom(after, graderId)).toEqual(rowsFrom(before, graderId));
    expect(rowsFrom(after, seeded)).toEqual(rowsFrom(before, seeded));

    await judgedAndSettled();
  });
});
