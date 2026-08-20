import { editGrader, readVerdicts } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aLatencyCopy,
  conductSimulation,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedTest,
  theSeededGrader,
  verdictsOn,
  type World,
} from "./support/world.ts";
import { met, notMet } from "./support/scripted-judge.ts";

/**
 * The two lanes a verdict can be in: what decides, and what only reports.
 *
 * **The grading contract is the seam** — a conversation and a project's running
 * copies in, verdict rows and folded outcomes out — so every case here goes
 * through the real service, the real stores and the real fold. Where the
 * `required` flag is read, and by what, is deliberately not asserted anywhere in
 * between: it is a property of the answer a page shows, and a test that watched
 * the machinery would go on passing after the machinery stopped mattering.
 *
 * **This file keeps its own deployment**, unlike the cases in the acceptance
 * suite that share one. Both halves of the diagnostic promise are comparisons —
 * the same conversation judged with and without a copy switched on — and a
 * project accumulating graders from earlier cases would leave the baseline
 * meaning something different by the time the comparison was made.
 */

let world: World;
const service = oneServiceAtATime();

/** The behavior every test here writes down, and the judge answers. */
const THE_BEHAVIOR = "confirms the new time back before finishing";

beforeAll(async () => {
  world = await makeWorld("grader_lanes");
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

describe("a required copy", () => {
  /**
   * The default, and the reason it is the default. A grader somebody bothered
   * to switch on is one they expect to be believed, so its failure is the
   * conversation's failure with nothing in between.
   */
  it("fails the conversation when one of its assertions fails", async () => {
    await service.judgingWith({
      [THE_BEHAVIOR]: notMet("the agent finished without repeating the time."),
    });

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    await verdictsOn(world, simulationId);

    const read = await readVerdicts(world.auth, simulationId);

    expect(read.outcome.verdict).toBe("failed");
    // In the lane that decides, which is what let it say so — and the project
    // has no diagnostic at all, so there is no second lane to report.
    expect(read.byGrader.every((its) => its.required)).toBe(true);
    expect(read.diagnostics).toBeUndefined();
  });
});

describe("a diagnostic copy", () => {
  /**
   * `required: false` is the only loudness switch v0 has, and this is the whole
   * of what it promises: the rows exist, the fraction is reported, and the
   * conversation's answer is exactly what it would have been with the copy
   * switched off. A diagnostic that could redden a run would not be one.
   *
   * The copy is of `latency`, which egma cannot execute yet, so every row it
   * writes is `errored` — the loudest word a diagnostic can say, and still not
   * one that reaches an outcome.
   */
  it("is judged and reported, and changes no outcome by failing", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("the agent named it back.") });

    const testId = await seedTest(world);
    const { simulationId: alone } = await conductSimulation(world, { testId });
    await verdictsOn(world, alone);
    const without = await readVerdicts(world.auth, alone);

    expect(without.outcome.verdict).toBe("passed");
    expect(without.diagnostics).toBeUndefined();

    // A bound this conversation misses, so the diagnostic genuinely **fails** —
    // which is what the case is named for. It used to be a copy of an entry
    // egma could not execute, answering `errored`; now that latency is computed
    // the same test is made with the word the lane is actually about, and
    // `failed` is the stronger of the two: it is the one a required copy would
    // have turned the whole conversation red with.
    const reporting = await seedGrader(
      world,
      aLatencyCopy({
        name: "Reports and never blocks",
        required: false,
        params: { metric: "turn_response_latency", bound: 100 },
      }),
    );
    const { simulationId: beside } = await conductSimulation(world, { testId });
    await verdictsOn(world, beside, 2);
    const with_ = await readVerdicts(world.auth, beside);

    // Its rows are there, under its own grader id: it was resolved and judged
    // exactly as a blocking copy is, which is what makes its fraction worth
    // anything at all.
    expect(
      with_.verdicts.filter((its) => its.graderId === reporting).length,
    ).toBeGreaterThan(0);

    // And the conversation's answer is what it was without the copy: same word,
    // same score, same counts, down to the last digit.
    expect(with_.outcome).toEqual(without.outcome);
    expect(with_.outcome.verdict).toBe("passed");

    // Its own fraction is reported, in its own lane, beside that answer — and
    // it is red in that lane while the answer to its left stays green, which is
    // the whole of what a diagnostic is.
    const its = with_.byGrader.find((one) => one.graderId === reporting);
    expect(its?.required).toBe(false);
    expect(its?.outcome.verdict).toBe("failed");
    expect(with_.diagnostics?.verdict).toBe("failed");
    expect(with_.diagnostics?.counts.failed).toBeGreaterThan(0);

    // The copy the project was born with stays in the lane that decides.
    const seeded = await theSeededGrader(world);
    expect(with_.byGrader.find((one) => one.graderId === seeded)?.required).toBe(
      true,
    );
  });

  /**
   * Turning the flag round is a live setting rather than a new version, so it
   * reaches every judgment already made — including the ones being looked at.
   * Nothing about those judgments changed; what changed is what the project
   * lets a failure do, and that answer has to be the one in force now.
   */
  it("changes lane the moment the flag does, for judgments already made", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("the agent named it back.") });

    // Blocking, and failing: a bound this conversation misses.
    const blocking = await seedGrader(
      world,
      aLatencyCopy({
        name: "Blocks until it does not",
        params: { metric: "turn_response_latency", bound: 100 },
      }),
    );
    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    await verdictsOn(world, simulationId, 2);

    const before = await readVerdicts(world.auth, simulationId);
    expect(before.outcome.verdict).toBe("failed");
    expect(before.byGrader.find((its) => its.graderId === blocking)?.required).toBe(
      true,
    );

    await editGrader(world.auth, blocking, { required: false });

    const after = await readVerdicts(world.auth, simulationId);
    // The same rows, read again: the failing ones are now in the lane that only
    // reports, and the conversation passes on what is left.
    expect(after.verdicts).toHaveLength(before.verdicts.length);
    expect(after.outcome.verdict).toBe("passed");
    expect(after.diagnostics?.verdict).toBe("failed");
    expect(after.byGrader.find((its) => its.graderId === blocking)?.required).toBe(
      false,
    );
  });
});

describe("a copy whose scope excludes this source", () => {
  /**
   * Absence rather than a `skipped` row, and the difference is the whole point:
   * `skipped` means the check applied and could not be made, which would drag a
   * conversation the grader was never about into the record as evidence of
   * something.
   *
   * It is also the last thing a test could once have overridden. A grader named
   * by a test's array judged whatever its scope said; a test names none now, so
   * scope is the entire answer.
   */
  it("writes no rows at all, and the test cannot ask it to", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("the agent named it back.") });

    const elsewhere = await seedGrader(
      world,
      aLatencyCopy({ name: "Production only", scope: "production" }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    await verdictsOn(world, simulationId);

    const read = await readVerdicts(world.auth, simulationId);
    const graders = new Set(read.verdicts.map((its) => its.graderId));

    expect(graders.has(elsewhere)).toBe(false);
    expect(read.byGrader.some((its) => its.graderId === elsewhere)).toBe(false);
  });
});
