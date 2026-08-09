import {
  claimGradingJobs,
  getGradingJob,
  readVerdicts,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aThreshold,
  conductSimulation,
  jobFor,
  makeWorld,
  runService,
  seedGrader,
  seedTest,
  testConfig,
  verdictsOn,
  type World,
} from "./support/world.ts";
import type { Service } from "../src/service.ts";

/**
 * The walking skeleton, end to end: a conversation ends, the service takes it,
 * and the verdict rows are there.
 *
 * **The contract is the seam.** A conversation and a grader configuration go in;
 * the assertions are on the verdict rows and on nothing about how they got
 * written — not which function was called, not in what order, not how many times
 * the service woke up. That is what lets tickets 05, 06 and 07 change the
 * middle of this without rewriting the suite that proves it works.
 *
 * **No model key is present anywhere in this file, or needed anywhere under
 * it.** The one grader type the skeleton executes is deterministic: it reads a
 * number off the conversation and applies a threshold, in-process, instantly.
 * A judge arrives in ticket 05 behind a seam, and until it does the whole path
 * runs for free.
 *
 * **The backstop is set an hour away on purpose.** Nothing here waits for a
 * poll: if a conversation is judged within a test's patience, it was judged
 * because ending it woke the service, which is the acceptance box's whole point.
 */

let world: World;
let service: Service;

beforeAll(async () => {
  world = await makeWorld("grader_acceptance");
  service = runService(testConfig());
});

afterAll(async () => {
  service.stop();
  await service.finished;
  await world.drop();
});

describe("a conversation reaching its terminal transition", () => {
  it("is claimed and judged, with no interval in the way", async () => {
    await seedGrader(world, aThreshold());

    const started = Date.now();
    const { simulationId, runId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 1_100] } },
    });

    const verdicts = await verdictsOn(world, simulationId);

    // The service's backstop sweep is an hour out, so anything that arrived in
    // seconds arrived because the terminal transition woke it.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.runId).toBe(runId);
  });

  it("lands the whole verdict row — the word, the number, the reason, the priority", async () => {
    const graderId = await seedGrader(
      world,
      aThreshold({ name: "P1 latency", priority: "P1" }),
    );
    const { simulationId, runId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900, 9_100] } },
    });

    const verdicts = await verdictsOn(world, simulationId, 2);
    const mine = verdicts.find((verdict) => verdict.graderId === graderId);

    expect(mine).toMatchObject({
      traceId: simulationId,
      graderId,
      dimension: "metric_threshold",
      source: "simulation",
      judgedBy: "engine",
      verdict: "failed",
      score: 0,
      priority: "P1",
      runId,
      agentId: world.agentId,
      citedSpanIds: [],
    });
    expect(mine?.rationale).toContain("p90 of turn_response_latency was 9100");
    expect(mine?.graderVersionId).toMatch(/^grv_/);
  });

  it("is judged by every project grader whose scope includes simulations, and by no other", async () => {
    const judging = await seedGrader(
      world,
      aThreshold({ name: "Both sources", scope: "both" }),
    );
    const elsewhere = await seedGrader(
      world,
      aThreshold({ name: "Production only", scope: "production" }),
    );

    const { simulationId } = await conductSimulation(world);
    const verdicts = await verdictsOn(world, simulationId, 3);
    const graders = new Set(verdicts.map((verdict) => verdict.graderId));

    expect(graders.has(judging)).toBe(true);
    // Not skipped, not errored — absent. A grader scoped to production was
    // never about this conversation, so there is no row for it at all.
    expect(graders.has(elsewhere)).toBe(false);
  });

  it("is judged by the graders its pinned test version names", async () => {
    const attached = await seedGrader(
      world,
      aThreshold({ name: "This scenario only", scope: "production" }),
    );
    const testId = await seedTest(world, [attached]);

    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 3);

    // Named by the test, so it judges this conversation whatever its project
    // scope says: naming it is the scoping decision, made per test.
    expect(
      verdicts.some((verdict) => verdict.graderId === attached),
    ).toBe(true);
  });

  it("counts a grader named by both the project and the test exactly once", async () => {
    const both = await seedGrader(world, aThreshold({ name: "Named twice" }));
    const testId = await seedTest(world, [both]);

    const { simulationId } = await conductSimulation(world, { testId });
    const verdicts = await verdictsOn(world, simulationId, 3);

    expect(
      verdicts.filter((verdict) => verdict.graderId === both),
    ).toHaveLength(1);
  });
});

describe("a simulation that never ran", () => {
  /**
   * The one normalisation a test product cannot get wrong. An agent that never
   * joined is not an agent that behaved badly, and a run whose simulator broke
   * must never read as a run whose agent broke.
   */
  it("is errored for every applicable grader, and never failed", async () => {
    await seedGrader(world, aThreshold({ name: "Latency, on a broken test" }));

    const { simulationId } = await conductSimulation(world, {
      failedBecause: "agent_never_joined",
    });

    const verdicts = await verdictsOn(world, simulationId);

    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) {
      expect(verdict.verdict).toBe("errored");
      expect(verdict.rationale).toContain("no conversation to judge");
    }
    expect(verdicts.map((verdict) => verdict.verdict)).not.toContain("failed");
  });

  it("folds to errored rather than to failed, all the way up to the headline", async () => {
    const { simulationId } = await conductSimulation(world, {
      failedBecause: "not_answered",
    });
    await verdictsOn(world, simulationId);

    const read = await readVerdicts(world.auth, simulationId);
    expect(read.outcome.verdict).toBe("errored");
  });
});

describe("a completed conversation missing the measure a grader wants", () => {
  it("is skipped, and leaves the score's denominator", async () => {
    await seedGrader(
      world,
      aThreshold({
        name: "Audio band",
        config: {
          measure: "measured_audio_band_hertz",
          aggregation: "min",
          comparator: "at_least",
          threshold: 16_000,
        },
      }),
    );

    const { simulationId } = await conductSimulation(world, {
      spans: { measured: { turn_response_latency: [900] } },
    });
    await verdictsOn(world, simulationId, 2);

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
    await seedGrader(world, aThreshold({ name: "One more" }));
    const { simulationId } = await conductSimulation(world);
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
