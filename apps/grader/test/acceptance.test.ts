import {
  claimGradingJobs,
  getGradingJob,
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
 * project looks like, and until egma computes it from spans a copy of it says
 * `errored` out loud rather than passing.
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
    const testId = await seedTest(world, []);

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
    const testId = await seedTest(world, []);

    const { simulationId, runId } = await conductSimulation(world, { testId });
    const [only] = await verdictsOn(world, simulationId);

    expect(only).toMatchObject({
      traceId: simulationId,
      graderId: await theSeededGrader(world),
      // The behavior's position in the pinned test version, never its words:
      // what a reader sees is fetched from that version at display time.
      dimension: "behavior_1",
      source: "simulation",
      judgedBy: "openai/gpt-4.1-mini",
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

    const testId = await seedTest(world, []);
    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const graders = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(graders.has(judging)).toBe(true);
    // Not skipped, not errored — absent. A grader scoped to production was
    // never about this conversation, so there is no row for it at all.
    expect(graders.has(elsewhere)).toBe(false);
  });

  it("is judged by the graders its pinned test version names", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const attached = await seedGrader(
      world,
      aLatencyCopy({ name: "This scenario only", scope: "production" }),
    );
    const testId = await seedTest(world, [attached]);

    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 2);

    // Named by the test, so it judges this conversation whatever its project
    // scope says: naming it is the scoping decision, made per test.
    expect(
      verdicts.some((verdict) => verdict.graderId === attached),
    ).toBe(true);
  });

  it("counts a grader named by both the project and the test exactly once", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const both = await seedGrader(world, aLatencyCopy({ name: "Named twice" }));
    const testId = await seedTest(world, [both]);

    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 2);

    expect(
      verdicts.filter((verdict) => verdict.graderId === both),
    ).toHaveLength(1);
  });
});

/**
 * A grader egma has not built the engine for yet.
 *
 * `latency` is on the shelf and a project can press Use on it today; computing
 * it from a conversation's spans is a later change. Until then a copy of it
 * must say so out loud rather than pass, because a project's page going green
 * on a check nobody made is the exact false trust this product exists to kill.
 */
describe("a copy of an entry egma cannot execute yet", () => {
  it("is errored, and never passed or skipped", async () => {
    await service.judgingWith({ [THE_BEHAVIOR]: met("it did.") });
    const waiting = await seedGrader(
      world,
      aLatencyCopy({ name: "Waiting on the measures" }),
    );

    const testId = await seedTest(world, []);
    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 2);
    const mine = verdicts.find((verdict) => verdict.graderId === waiting);

    expect(mine).toMatchObject({
      dimension: "latency",
      verdict: "errored",
      score: 0,
      judgedBy: "engine",
    });
    expect(mine?.rationale).toContain("does not execute the latency grader yet");
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

    const testId = await seedTest(world, []);
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
    const testId = await seedTest(world, []);
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

    const testId = await seedTest(world, []);
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
    const testId = await seedTest(world, []);
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
