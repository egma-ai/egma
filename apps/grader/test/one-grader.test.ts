import type { Grader } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { judgmentsOf } from "../src/grade.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

/**
 * What one grader says about one conversation, before anything is written down.
 *
 * The seam between the engine and a grader type is where unknown code runs —
 * every type added after this one arrives through it — so the two things the
 * engine promises about that seam are asserted here rather than inferred from
 * the types that happen to exist today.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript: [],
    events: [],
    metrics: { turn_response_latency: [900] },
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    ...overrides,
  };
}

/**
 * A grader as the factory hands one over. Built rather than read, because what
 * is under test is what the engine does with a grader, not how one is stored.
 *
 * The overrides are deliberately loose: two of the cases below hand over a row
 * the factory would refuse to write, because "an executor that falls over" is
 * exactly the case a well-typed input cannot produce.
 */
function grader(overrides: Record<string, unknown> = {}): Grader {
  return {
    id: "grd_01JQZ0000000000000000000AA",
    projectId: "prj_01JQZ0000000000000000000AA",
    name: "Answers inside two seconds",
    description: null,
    scope: "simulations",
    productionSampleRate: 100,
    version: 1,
    versionId: "grv_01JQZ0000000000000000000AA",
    judgeModel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    type: "metric_threshold",
    config: {
      measure: "turn_response_latency",
      aggregation: "p90",
      comparator: "below",
      threshold: 2_000,
    },
    ...overrides,
  } as Grader;
}

describe("a simulation that never ran", () => {
  /**
   * The check lives above the seam rather than inside each executor, so this is
   * true of every grader type that will ever exist rather than of the ones that
   * remembered to implement it.
   */
  it("is errored for the grader without the grader ever being asked", async () => {
    const [only] = await judgmentsOf(
      grader(),
      conversation({
        nothingToJudgeBecause:
          "this simulation ended agent_never_joined, so there was no conversation to judge.",
        endingReason: "agent_never_joined",
        // Measures the grader would happily have passed, so the answer cannot
        // be coming from the executor having looked at them.
        metrics: { turn_response_latency: [10] },
      }),
      noJudgeWanted(),
    );

    expect(only).toMatchObject({ verdict: "errored", score: 0 });
    expect(only?.rationale).toBe(
      "this simulation ended agent_never_joined, so there was no conversation to judge.",
    );
  });
});

describe("a grader whose execution falls over", () => {
  /**
   * One grader failing is one `errored` row and not a conversation with no
   * verdicts on it. It matters most for the types that are not built yet: a
   * judge model timing out on one check must leave every other check's judgment
   * standing, and the engine rather than each executor is what guarantees it.
   */
  it("is one errored row, and says what went wrong", async () => {
    // A config nothing would write, which is exactly what makes the executor
    // throw rather than answer — the seam runs code the engine does not own.
    const [only] = await judgmentsOf(
      grader({ config: null }),
      conversation(),
      noJudgeWanted(),
    );

    expect(only).toMatchObject({
      assertion: "metric_threshold",
      verdict: "errored",
      score: 0,
      citedSpanIds: [],
    });
    expect(only?.rationale).toContain("this check could not be made");
  });

  it("never says failed, because nothing is being said about the agent", async () => {
    for (const broken of [
      grader({ config: null }),
      grader({ type: "tool_calls" }),
    ]) {
      for (const judgment of await judgmentsOf(
        broken,
        conversation(),
        noJudgeWanted(),
      )) {
        expect(judgment.verdict).toBe("errored");
      }
    }
  });
});
