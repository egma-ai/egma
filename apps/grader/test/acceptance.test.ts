import {
  claimGradingJobs,
  getGrader,
  getGradingJob,
  readRunVerdicts,
  readVerdicts,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aLatencyCopy,
  conductSimulation,
  jobFor,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedJudge,
  seedTest,
  testConfig,
  theSeededGrader,
  verdictsOn,
  type World,
} from "./support/world.ts";
import { cannotDetermine, met, notMet } from "./support/scripted-judge.ts";

/**
 * The walking skeleton, end to end: a conversation ends, the service takes it,
 * and the verdict rows are there.
 *
 * **The contract is the seam.** A conversation and a project's running graders
 * go in; the assertions are on the verdict rows and on nothing about how they
 * got written — not which function was called, not in what order, not how many
 * times the service woke up. That is what lets later work change the middle of
 * this without rewriting the suite that proves it works.
 *
 * **The graders are the two egma ships, because those are the only two there
 * are.** A project is created holding an active copy of `expected_behaviors`,
 * so the conversation below is judged against its test's own sentences with
 * nothing set up at all; a copy of `latency` is what a second grader on the
 * project looks like, and it is computed from the conversation's own spans with
 * no model asked anything.
 *
 * **And a test names no graders**, because there is nowhere for it to. The
 * junction is gone: which copies judge a conversation is each copy's own scope
 * and nothing about the test in front of it.
 *
 * **The judge is scripted and no key is present anywhere in this file.** What
 * is under test here is egma's side of the seam — which graders applied, what
 * their rows say, what a broken conversation comes to — and asserting that
 * against a real model would be paying an account to learn something a model
 * cannot tell you reliably anyway.
 *
 * **The backstop is set an hour away on purpose.** Nothing here waits for a
 * poll: if a conversation is judged within a test's patience, it was judged
 * because ending it woke the service, which is the acceptance box's whole point.
 */

let world: World;
const service = oneServiceAtATime();

/** The behavior every test in this file writes down, and the judge answers. */
const THE_BEHAVIOR = "confirms the new time back before finishing";

beforeAll(async () => {
  world = await makeWorld("grader_acceptance");
  await seedJudge(world);
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

describe("a conversation reaching its terminal transition", () => {
  it("is claimed and judged, with no interval in the way", async () => {
    await service.judgingWith({
      [THE_BEHAVIOR]: met("the agent named the new time back."),
    });
    const testId = await seedTest(world);

    const started = Date.now();
    const { simulationId, runId } = await conductSimulation(world, {
      testId,
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });

    const verdicts = await verdictsOn(world, simulationId);

    // The service's backstop sweep is an hour out, so anything that arrived in
    // seconds arrived because the terminal transition woke it.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.runId).toBe(runId);
  });

  /**
   * **The row names a real grader**, which is the whole of what the seeded copy
   * bought. A verdict used to carry the word `expected_behaviors` where a
   * grader id belongs, because the built-in was never a row in any table; every
   * project now runs a copy of the library entry, so the row names it and the
   * version that decided it.
   */
  it("lands the whole verdict row — the grader, the word, the number, the reason", async () => {
    await service.judgingWith({
      [THE_BEHAVIOR]: notMet("the agent finished without repeating the time.", [3]),
    });
    const testId = await seedTest(world);

    const { simulationId, runId } = await conductSimulation(world, { testId });
    const [only] = await verdictsOn(world, simulationId);

    expect(only).toMatchObject({
      traceId: simulationId,
      graderId: await theSeededGrader(world),
      // The behavior's position in the pinned test version, never its words:
      // what a reader sees is fetched from that version at display time.
      assertion: "behavior_1",
      source: "simulation",
      verdict: "failed",
      score: 0,
      runId,
      agentId: world.agentId,
    });
    expect(only?.rationale).toBe(
      "the agent finished without repeating the time.",
    );
    expect(only?.graderVersionId).toMatch(/^grv_/);
  });

  it("is judged by every project grader whose scope includes simulations, and by no other", async () => {
    await service.judgingWith({
      [THE_BEHAVIOR]: met("it did."),
    });
    const judging = await seedGrader(
      world,
      aLatencyCopy({ name: "Both sources", scope: "both" }),
    );
    const elsewhere = await seedGrader(
      world,
      aLatencyCopy({ name: "Production only", scope: "production" }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const graders = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(graders.has(judging)).toBe(true);
    // Not skipped, not errored — absent. A grader scoped to production was
    // never about this conversation, so there is no row for it at all.
    expect(graders.has(elsewhere)).toBe(false);
  });

  /**
   * The whole of the resolution, said as the absence it now is.
   *
   * A test names no graders and there is nowhere it could: the junction is gone
   * from the schema and no code path reads test content to decide what judges. A
   * copy scoped away from simulations therefore cannot be dragged back in by the
   * test in front of it, which is exactly what an attached grader used to do —
   * and the run is judged by precisely the copies the project switched on.
   */
  it("is judged by nothing its test says, because a test names no graders", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const elsewhere = await seedGrader(
      world,
      aLatencyCopy({ name: "Production only, whatever a test wanted", scope: "production" }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId);
    const graders = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(graders.has(await theSeededGrader(world))).toBe(true);
    // No row at all — not skipped, not errored. Its scope excludes this source,
    // and nothing about the test can widen it.
    expect(graders.has(elsewhere)).toBe(false);
  });
});

/**
 * The other predefined grader, end to end: a measure off the conversation's own
 * spans, held to a bound somebody typed.
 *
 * **No model is asked anything on this path.** The judge is scripted for the
 * behaviors grader beside it, and the rows below come from egma's own engine
 * reading the numbers the shared measure module worked out — the same numbers
 * the metrics display shows for this conversation.
 */
describe("a latency copy", () => {
  it("passes a conversation inside its bound, one row per config entry", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const quick = await seedGrader(
      world,
      aLatencyCopy({ name: "Answers inside two seconds" }),
    );

    const testId = await seedTest(world);
    const { simulationId, runId } = await conductSimulation(world, {
      testId,
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const mine = verdicts.filter((verdict) => verdict.graderId === quick);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      // The config entry's position, one-based. Never the measure and never the
      // bound: a re-grade at a tightened bound has to write *over* this row
      // rather than beside it, and a key made of what somebody typed would not.
      assertion: "turn_response_latency",
      verdict: "passed",
      score: 1,
    });
    // The worst measurement decides, and the row says which one it was.
    expect(mine[0]?.rationale).toContain("1100 milliseconds at its worst");
    // And it cites the span that measurement happened in, which is what the
    // column is for.
    expect(mine[0]?.citedSpanIds).toHaveLength(1);

    /**
     * **And the run read path shows it**, which is the grain a results page and
     * a CI gate actually read. `readRunVerdicts` is the function behind
     * `GET /api/runs/:runId`; asserting only the per-conversation read would
     * leave the last join between a latency verdict and the page somebody looks
     * at unexercised by anything but hand-written rows.
     */
    const run = await readRunVerdicts(world.auth, runId);
    const its = run.byGrader.find((one) => one.graderId === quick);

    expect(run.simulations.map((one) => one.simulationId)).toContain(
      simulationId,
    );
    expect(its?.outcome).toMatchObject({ verdict: "passed", score: 1 });

    // The run's own headline is folded over the same rows at read time, so the
    // counts underneath it add up to it — a stored rollup is what could drift,
    // and there is not one.
    const beneath = run.simulations.reduce(
      (total, one) => total + one.outcome.counts.total,
      0,
    );
    expect(run.outcome.counts.total).toBe(beneath);
  });

  it("fails a conversation over its bound, and says by how much", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const strict = await seedGrader(
      world,
      aLatencyCopy({
        name: "Answers inside half a second",
        params: { metric: "turn_response_latency", bound: 500 },
      }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, {
      testId,
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const mine = verdicts.find((verdict) => verdict.graderId === strict);

    expect(mine).toMatchObject({
      assertion: "turn_response_latency",
      verdict: "failed",
      score: 0,
    });
    expect(mine?.rationale).toContain("over the bound of 500");
  });

  /**
   * **`skipped`, and out of the fraction's denominator.** A measure this
   * conversation never took is a check that did not apply — a chat simulation
   * has no audio and therefore no `time_to_first_word` — and marking an agent
   * down for a measurement nobody took is the false signal this product exists
   * to kill. Never `failed`, and never `errored` either: nothing broke.
   */
  it("is skipped for a measure the conversation's spans do not carry", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const voiceOnly = await seedGrader(
      world,
      aLatencyCopy({
        name: "Speaks up inside a second",
        params: { metric: "time_to_first_word", bound: 1_000 },
      }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, {
      testId,
      // A chat conversation: it measured its turn latency and no audio at all.
      spans: { measured: { turn_response_latency: [900] } },
    });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const mine = verdicts.find((verdict) => verdict.graderId === voiceOnly);

    expect(mine).toMatchObject({ assertion: "time_to_first_word", verdict: "skipped" });
    expect(mine?.rationale).toContain("nothing in this conversation measured time_to_first_word");

    const read = await readVerdicts(world.auth, simulationId);
    const its = read.byGrader.find((one) => one.graderId === voiceOnly);
    // Nothing was scored, so there is no fraction — not a nought, which would
    // read as a grader that found something wrong.
    expect(its?.outcome.counts.skipped).toBe(1);
    expect(its?.outcome.score).toBeUndefined();
  });

  /**
   * **A diagnostic reports and gates nothing.** `required: false` is v0's only
   * loudness switch: the copy is judged like any other, its rows land beside
   * everything else's, and its failure is the run's business to display rather
   * than to fail anything with. What the run's results make of that is the
   * results page's own concern; what is asserted here is that the copy behaves
   * as a diagnostic — judged, written, and separable by the grader it names.
   */
  it("is judged and written when it is a diagnostic, and fails on its own", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const watching = await seedGrader(
      world,
      aLatencyCopy({
        name: "Watching the tail",
        required: false,
        params: { metric: "turn_response_latency", bound: 100 },
      }),
    );

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, {
      testId,
      spans: { measured: { turn_response_latency: [900] } },
    });
    const verdicts = await verdictsOn(world, simulationId, 2);

    const copy = await getGrader(world.auth, watching);
    expect(copy?.required).toBe(false);

    const mine = verdicts.find((verdict) => verdict.graderId === watching);
    expect(mine).toMatchObject({ verdict: "failed", assertion: "turn_response_latency" });

    // **Its failure is its own.** The rows fold per grader, so a diagnostic
    // going red changes nothing about what any other copy answered — which is
    // what lets a results page put these in a lane of their own and leave the
    // gating graders' fold untouched.
    const seeded = await theSeededGrader(world);
    const read = await readVerdicts(world.auth, simulationId);
    const diagnostic = read.byGrader.find((one) => one.graderId === watching);
    const behaviors = read.byGrader.find((one) => one.graderId === seeded);

    expect(diagnostic?.outcome.verdict).toBe("failed");
    expect(behaviors?.outcome.verdict).toBe("passed");
  });
});

describe("a simulation that never ran", () => {
  /**
   * The one normalisation a test product cannot get wrong. An agent that never
   * joined is not an agent that behaved badly, and a run whose simulator broke
   * must never read as a run whose agent broke.
   */
  it("is errored for every applicable grader, and never failed", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    await seedGrader(world, aLatencyCopy({ name: "On a broken test" }));

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, {
      testId,
      failedBecause: "agent_never_joined",
    });

    const verdicts = await verdictsOn(world, simulationId, 2);

    expect(verdicts.length).toBeGreaterThan(1);
    for (const verdict of verdicts) {
      expect(verdict.verdict).toBe("errored");
      expect(verdict.rationale).toContain("no conversation to judge");
    }
    expect(verdicts.map((verdict) => verdict.verdict)).not.toContain("failed");
  });

  it("folds to errored rather than to failed, all the way up to the headline", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, {
      testId,
      failedBecause: "not_answered",
    });
    await verdictsOn(world, simulationId);

    const read = await readVerdicts(world.auth, simulationId);
    expect(read.outcome.verdict).toBe("errored");
  });
});

describe("a conversation the judge cannot settle", () => {
  /**
   * `cannot_determine` is a real answer, not a failure and not an error: the
   * evidence did not settle the criterion. It becomes `skipped` and leaves the
   * score's denominator, so a behavior nobody could judge neither passes nor
   * fails anything.
   */
  it("is skipped, and leaves the score's denominator", async () => {
    await service.judgingWith({
      [THE_BEHAVIOR]: cannotDetermine(
        "the conversation never reached the subject.",
      ),
    });

    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    await verdictsOn(world, simulationId);

    const read = await readVerdicts(world.auth, simulationId);
    const skipped = read.verdicts.filter(
      (verdict) => verdict.verdict === "skipped",
    );

    expect(skipped.length).toBeGreaterThan(0);
    expect(read.outcome.counts.skipped).toBe(skipped.length);
    // Out of the denominator: the score is over what was actually judged.
    expect(read.outcome.counts.total - read.outcome.counts.skipped).toBe(
      read.outcome.counts.passed +
        read.outcome.counts.failed +
        read.outcome.counts.errored,
    );
  });
});

describe("the job behind it", () => {
  it("is finished once the verdicts are written, and never handed out again", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") }, testConfig());
    const testId = await seedTest(world);
    const { simulationId } = await conductSimulation(world, { testId });
    await verdictsOn(world, simulationId);

    const job = await jobFor(world, { simulationId }, "graded");

    expect(job).toMatchObject({ status: "graded", claimedBy: "grader-under-test" });
    expect(job.finishedAt).toBeInstanceOf(Date);

    // And nothing claims it again, however hard anybody asks.
    const claimed = await claimGradingJobs({
      claimant: "another-copy",
      capacity: 50,
    });
    expect(claimed.some((claim) => claim.id === job.id)).toBe(false);
    expect((await getGradingJob(world.auth, job.id))?.status).toBe("graded");
  });
});
