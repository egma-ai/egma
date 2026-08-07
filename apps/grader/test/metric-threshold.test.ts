import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute } from "../src/graders/index.ts";
import type {
  MeasureAggregation,
  MetricThresholdConfig,
  ThresholdComparator,
} from "@egma/db";

/**
 * The one grader type the skeleton executes, judged on its own.
 *
 * No database and no store: a deterministic grader is a function from a
 * conversation and a threshold to a verdict, and that is exactly what is under
 * test here. What it does with the row it produces is the acceptance suite's
 * business.
 */

function conversation(metrics: unknown): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    happened: true,
    endingReason: "persona_concluded",
    transcript: [],
    events: [],
    metrics,
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
  };
}

function threshold(
  overrides: Partial<MetricThresholdConfig> = {},
): MetricThresholdConfig {
  return {
    measure: "turn_response_latency",
    aggregation: "p90",
    comparator: "below",
    threshold: 2_000,
    ...overrides,
  };
}

async function judge(
  metrics: unknown,
  config: Partial<MetricThresholdConfig> = {},
) {
  const [only] = await execute({
    judgment: { type: "metric_threshold", config: threshold(config) },
    conversation: conversation(metrics),
  });
  if (only === undefined) throw new Error("the grader said nothing");
  return only;
}

describe("a measurement held to a threshold", () => {
  it("passes when it is inside, and says what it measured", async () => {
    const judgment = await judge({ turn_response_latency: [900, 1_100, 1_400] });

    expect(judgment).toMatchObject({
      dimension: "metric_threshold",
      verdict: "passed",
      score: 1,
      citedSpanIds: [],
    });
    expect(judgment.rationale).toBe(
      "p90 of turn_response_latency was 1400, which is below 2000.",
    );
  });

  it("fails when it is outside, and the rationale is the same sentence negated", async () => {
    const judgment = await judge({ turn_response_latency: [900, 9_100] });

    expect(judgment).toMatchObject({ verdict: "failed", score: 0 });
    expect(judgment.rationale).toBe(
      "p90 of turn_response_latency was 9100, which is not below 2000.",
    );
  });

  it("reads a measure taken once as well as a measure taken per turn", async () => {
    expect(
      (await judge({ first_response_latency: 800 }, { measure: "first_response_latency" }))
        .verdict,
    ).toBe("passed");
  });

  it("names its one dimension by its type, so a tightened threshold replaces rather than adds", async () => {
    const loose = await judge({ turn_response_latency: [1_500] });
    const tight = await judge({ turn_response_latency: [1_500] }, { threshold: 1_000 });

    expect(loose.verdict).toBe("passed");
    expect(tight.verdict).toBe("failed");
    // Same dimension, which is what makes the second grading supersede the
    // first rather than sit beside it forever with both of them speaking.
    expect(tight.dimension).toBe(loose.dimension);
  });
});

describe("a measure this conversation does not have", () => {
  it("is skipped, because a check that did not apply failed nothing", async () => {
    const judgment = await judge({ some_other_measure: 1 });

    expect(judgment).toMatchObject({ verdict: "skipped", score: 0 });
    expect(judgment.rationale).toBe(
      "this conversation measured no turn_response_latency, so there was nothing to hold to a threshold.",
    );
  });

  it("is skipped when the simulation recorded no measures at all", async () => {
    expect((await judge(null)).verdict).toBe("skipped");
  });

  it("is skipped when the list of samples is empty, which measured nothing", async () => {
    expect((await judge({ turn_response_latency: [] })).verdict).toBe("skipped");
  });
});

describe("a measure recorded in a shape egma never writes", () => {
  /**
   * Deliberately not `skipped`. A missing measurement and a corrupted row are
   * different facts, and filing the second under a word that means "fine, not
   * applicable" is how data corruption hides.
   */
  it("errors rather than skipping, so a broken row is not read as an absent one", async () => {
    for (const broken of [
      { turn_response_latency: "fast" },
      { turn_response_latency: [900, "slow"] },
      { turn_response_latency: { p90: 900 } },
      { turn_response_latency: Number.NaN },
      [900, 1_100],
    ]) {
      const judgment = await judge(broken);
      expect(judgment.verdict).toBe("errored");
      expect(judgment.rationale).toContain("a shape egma never writes");
    }
  });
});

describe("the aggregations", () => {
  const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000];

  const measured = async (aggregation: MeasureAggregation): Promise<number> => {
    const judgment = await judge(
      { turn_response_latency: samples },
      { aggregation, comparator: "below", threshold: 0 },
    );
    const said = /was (-?[\d.]+),/.exec(judgment.rationale)?.[1];
    if (said === undefined) throw new Error(judgment.rationale);
    return Number(said);
  };

  it("reduce the samples the way their names say", async () => {
    expect(await measured("mean")).toBe(550);
    expect(await measured("sum")).toBe(5_500);
    expect(await measured("min")).toBe(100);
    expect(await measured("max")).toBe(1_000);
    // Nearest-rank: every percentile is a measurement that actually happened,
    // rather than an interpolation between two that did.
    expect(await measured("p50")).toBe(500);
    expect(await measured("p90")).toBe(900);
    expect(await measured("p95")).toBe(1_000);
    expect(await measured("p99")).toBe(1_000);
  });

  it("aggregate a single measurement to itself, whichever one is asked for", async () => {
    for (const aggregation of ["mean", "sum", "min", "max", "p50", "p99"] as const) {
      expect(
        (
          await judge(
            { turn_response_latency: 750 },
            { aggregation, comparator: "below", threshold: 1_000 },
          )
        ).verdict,
      ).toBe("passed");
    }
  });

  it("round a long float to something a person can read", async () => {
    const judgment = await judge(
      { turn_response_latency: [100, 200, 250] },
      { aggregation: "mean" },
    );
    expect(judgment.rationale).toContain("was 183.33,");
  });
});

describe("the comparators", () => {
  const holds = async (
    comparator: ThresholdComparator,
    measured: number,
  ): Promise<boolean> =>
    (
      await judge(
        { turn_response_latency: measured },
        { aggregation: "max", comparator, threshold: 1_000 },
      )
    ).verdict === "passed";

  it("mean what their words say at the boundary, which is where they differ", async () => {
    expect(await holds("below", 1_000)).toBe(false);
    expect(await holds("at_most", 1_000)).toBe(true);
    expect(await holds("above", 1_000)).toBe(false);
    expect(await holds("at_least", 1_000)).toBe(true);
  });
});

describe("a grader type egma has not built yet", () => {
  /**
   * The alternative would be silence, and silence is what makes a page go green
   * because a check quietly judged nothing. That is the exact false trust this
   * product exists to kill, so an unbuilt type says so out loud.
   */
  it("errors rather than being skipped or ignored", async () => {
    const [only] = await execute({
      judgment: { type: "phrase_match", config: { required: [], banned: [], speaker: "agent" } },
      conversation: conversation({}),
    });

    expect(only).toMatchObject({ dimension: "phrase_match", verdict: "errored" });
    expect(only?.rationale).toContain("does not execute phrase_match graders yet");
  });
});
