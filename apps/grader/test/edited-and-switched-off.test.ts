import {
  deleteGrader,
  editGrader,
  readVerdicts,
  regrade,
  type UseLibraryEntry,
} from "@egma/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  aLatencyCopy,
  conductSimulation,
  eventually,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  theSeededGrader,
  type World,
} from "./support/world.ts";

/**
 * What an edit and a delete actually do to judging — asked of the running
 * service, the real stores and the real fold, because that is the only place
 * the answer lives.
 *
 * **Pressing Use used to be a one-way door.** A bound typed too tight made
 * every run red for ever: there was no route to change the values, no route to
 * turn the blocker into a diagnostic, and no route to switch the copy off. This
 * file is the other half of opening those doors — not that the rows in Postgres
 * changed, which the data-access suite already proves, but that the next
 * conversation is judged differently and the last one is not judged again.
 *
 * The project-owned expected-behaviors copy is switched off before these runs,
 * so what is left is the latency copy this file switches on and one row per
 * conversation —
 * which is what makes "it wrote nothing afterwards" an assertion about the
 * delete rather than about arithmetic.
 *
 * The conducted conversation measures 900 and 1100 milliseconds, and the worst
 * of those is what a bound is held against: 2000 passes, 1000 fails.
 */

let world: World;
const service = oneServiceAtATime();

/** Every copy this case switched on, so the next one starts where this did. */
let switchedOn: string[] = [];

beforeAll(async () => {
  world = await makeWorld("grader_edited_switched_off");
  // These cases isolate computed latency. The minimal test has one required
  // behavior because every real test must be falsifiable, so switch off the
  // model-judged copy before any run freezes its plan.
  await deleteGrader(world.auth, await theSeededGrader(world));
});

/**
 * The project as this file found it: the copy every project is created with,
 * and nothing else.
 *
 * **Switched off through the product's own act**, which is also the point:
 * every case here is about one copy's rows, and a copy left running from an
 * earlier case would judge the next case's conversations and answer for
 * something that case never mentions. Deleting is exactly how a project stops
 * being judged by one, so the tidying and the subject are the same verb.
 */
afterEach(async () => {
  const switching = switchedOn;
  switchedOn = [];
  for (const graderId of switching) await deleteGrader(world.auth, graderId);
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

async function aCopyOnTheProject(grader: UseLibraryEntry): Promise<string> {
  const graderId = await seedGrader(world, grader);
  switchedOn.push(graderId);
  return graderId;
}

/**
 * One conversation, judged to the end.
 *
 * **The job reaching `graded` rather than a row appearing**, and the difference
 * is the whole reliability of this file. A row appearing says *a* grader has
 * spoken; every case here asks what a **particular** copy said, and one of them
 * asks what a copy did **not** say — which no count of rows can ever confirm,
 * because the row that is missing might simply not have been written yet. The
 * job is finished only once every verdict is stored, so it is the one signal
 * that means there is nothing more coming.
 */
async function judged(simulationId: string): Promise<void> {
  await jobFor(world, { simulationId }, "graded", 30_000);
}

/** The rows one copy wrote about one conversation, in the order they came. */
async function rowsFrom(conversationId: string, graderId: string) {
  const read = await readVerdicts(world.auth, conversationId);
  return read.verdicts.filter((row) => row.graderId === graderId);
}

describe("editing what a copy judges by", () => {
  it("uses the version frozen when the run started for initial grading and re-grade", async () => {
    await service.start();
    const graderId = await aCopyOnTheProject(
      aLatencyCopy({ name: "Frozen at two seconds" }),
    );

    let nextVersionId = "";
    const { simulationId, runId } = await conductSimulation(world, {
      afterRunStarted: async () => {
        const edited = await editGrader(world.auth, graderId, {
          params: { metric: "turn_response_latency", bound: 1_000 },
        });
        nextVersionId = edited?.versionId ?? "";
      },
    });
    await judged(simulationId);

    const [frozen] = await rowsFrom(simulationId, graderId);
    expect(frozen?.verdict).toBe("passed");
    expect(frozen?.graderVersionId).not.toBe(nextVersionId);

    const asked = await regrade(world.auth, { runId, graderId });
    expect(asked?.reopened).toHaveLength(1);
    const repeated = await eventually("the pinned version to judge again", async () => {
      const [row] = await rowsFrom(simulationId, graderId);
      return row !== undefined &&
        row.judgedAtMicroseconds > (frozen?.judgedAtMicroseconds ?? 0n)
        ? row
        : undefined;
    });
    expect(repeated.graderVersionId).toBe(frozen?.graderVersionId);
    expect(repeated.graderVersionId).not.toBe(nextVersionId);
    expect(repeated.verdict).toBe("passed");
    expect(await rowsFrom(simulationId, graderId)).toHaveLength(1);
  });

  /**
   * **The next conversation is judged by the new bound, and the last one keeps
   * its own answer.** An edit to the values mints the next version rather than
   * rewriting the current one, so a verdict written under version 1 still names
   * version 1 and still says what it said. That is the whole reason the values
   * are versioned and the live settings are not.
   *
   * It is also why nothing is re-judged: editing a copy changes what happens
   * next, and there is no re-grade in the product to reach backwards with.
   */
  it("judges the next conversation by the new bound, and leaves the earlier one alone", async () => {
    await service.start();

    const graderId = await aCopyOnTheProject(
      aLatencyCopy({ name: "Answers inside two seconds" }),
    );

    const { simulationId: before } = await conductSimulation(world);
    await judged(before);
    const [passed] = await rowsFrom(before, graderId);
    expect(passed?.verdict).toBe("passed");

    // The bound tightened past what this agent manages — sent as the entry's
    // form filled in, which is the shape the edit route hands down.
    const edited = await editGrader(world.auth, graderId, {
      params: { metric: "turn_response_latency", bound: 1000 },
    });
    expect(edited?.version).toBe(2);

    const { simulationId: after } = await conductSimulation(world);
    await judged(after);
    const [failed] = await rowsFrom(after, graderId);

    // Judged by what the copy holds now, and the row names the version that
    // decided it.
    expect(failed?.verdict).toBe("failed");
    expect(failed?.graderVersionId).toBe(edited?.versionId);
    expect(await readVerdicts(world.auth, after)).toMatchObject({
      outcome: { verdict: "failed" },
    });

    // And the conversation judged before the edit is untouched — same word,
    // same version, same instant. Nothing went back for it.
    const [still] = await rowsFrom(before, graderId);
    expect(still?.verdict).toBe("passed");
    expect(still?.graderVersionId).toBe(passed?.graderVersionId);
    expect(still?.judgedAtMicroseconds).toBe(passed?.judgedAtMicroseconds);
    expect(await readVerdicts(world.auth, before)).toMatchObject({
      outcome: { verdict: "passed" },
    });
  });
});

describe("switching a copy off", () => {
  /**
   * **Deleting is the off switch, and this is what that has to mean at both
   * ends.** Nothing the project runs afterwards is judged by the copy, because
   * it stops being resolved at all; and everything it already judged still
   * reads, because the row is marked rather than removed and its versions stay
   * exactly where they are.
   *
   * The second half is what makes the first half safe to press. A team whose
   * grader is failing every run has to be able to stop it without being asked
   * to give up the runs they have already read.
   */
  it("judges nothing afterwards, and everything it already judged still reads", async () => {
    await service.start();

    const graderId = await aCopyOnTheProject(
      aLatencyCopy({ name: "On until it is not" }),
    );

    const { simulationId: itJudged } = await conductSimulation(world);
    await judged(itJudged);
    const [wrote] = await rowsFrom(itJudged, graderId);
    expect(wrote?.verdict).toBe("passed");

    const switchedOff = await deleteGrader(world.auth, graderId);
    expect(switchedOff?.id).toBe(graderId);

    // A whole conversation later: conducted, claimed, judged and finished —
    // and this copy said nothing about it, because it was never resolved.
    const { simulationId: afterwards } = await conductSimulation(world);
    await judged(afterwards);

    expect(await rowsFrom(afterwards, graderId)).toHaveLength(0);
    // Nothing judged it at all, in fact: the conversation names no test, so the
    // copy the project was created with had nothing to say either.
    const nothing = await readVerdicts(world.auth, afterwards);
    expect(nothing.verdicts).toHaveLength(0);
    expect(nothing.outcome.verdict).toBe("skipped");

    // And the conversation it did judge reads exactly as it read before.
    const [kept] = await rowsFrom(itJudged, graderId);
    expect(kept?.verdict).toBe("passed");
    expect(kept?.graderVersionId).toBe(wrote?.graderVersionId);
    expect(await readVerdicts(world.auth, itJudged)).toMatchObject({
      outcome: { verdict: "passed" },
    });
  });

  /**
   * **A switched-off diagnostic stays a diagnostic**, and this is the case that
   * pins it.
   *
   * `required` is read live off the copy rather than off the row that names it,
   * and the copy is read **without a deleted filter** — deliberately. The fold
   * treats a grader it cannot resolve as required, which is the safe direction
   * for a row nobody can place; but a copy somebody switched off is not
   * unplaceable, and reading it as required would turn every failing row a
   * diagnostic ever wrote into a run that suddenly failed, months later,
   * because somebody tidied up. Deleting a copy says what judges from now on.
   * It says nothing about what a past run meant.
   */
  it("leaves a diagnostic's old rows in the lane that only reports", async () => {
    await service.start();

    const reporting = await aCopyOnTheProject(
      aLatencyCopy({
        name: "Reports and never blocks",
        required: false,
        params: { metric: "turn_response_latency", bound: 100 },
      }),
    );

    const { simulationId } = await conductSimulation(world);
    await judged(simulationId);

    const before = await readVerdicts(world.auth, simulationId);
    expect(before.diagnostics?.verdict).toBe("failed");
    // Nothing that can fail anything judged this conversation, so the answer is
    // that nothing was decided — not that something failed.
    expect(before.outcome.verdict).toBe("skipped");
    expect(
      before.byGrader.find((its) => its.graderId === reporting)?.required,
    ).toBe(false);

    await deleteGrader(world.auth, reporting);

    const after = await readVerdicts(world.auth, simulationId);
    expect(after.verdicts).toHaveLength(before.verdicts.length);
    expect(after.diagnostics?.verdict).toBe("failed");
    expect(after.outcome.verdict).toBe("skipped");
    expect(
      after.byGrader.find((its) => its.graderId === reporting)?.required,
    ).toBe(false);
  });
});
