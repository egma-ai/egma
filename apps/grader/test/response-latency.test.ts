import {
  MAXIMUM_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
  type GraderDefinitionSnapshot,
} from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute } from "../src/graders/index.ts";
import { noJudgeWanted } from "./support/scripted-judge.ts";

function definition(): GraderDefinitionSnapshot {
  return {
    definitionId: PREDEFINED_GRADERS.responseLatency,
    definitionVersion: 1,
    type: "code",
    prompt: null,
    parameterContract: [],
    modalities: ["chat", "voice"],
  };
}

function conversation(samples: readonly number[]): Conversation {
  return {
    source: "production",
    traceId: "1111111111111111111111111111cccc",
    nothingToJudgeBecause: null,
    endingReason: null,
    transcript: [],
    events: [],
    measures: samples.length === 0
      ? []
      : [{
          measure: "turn_response_latency",
          unit: "milliseconds",
          origin: "timed",
          reportedBy: "",
          samples: samples.map((value, at) => ({
            value,
            spanId: `${String(at + 1).padStart(16, "0")}`,
          })),
        }],
    runId: "",
    agentId: "",
  };
}

function grade(samples: readonly number[], maximum = 3_000) {
  return execute({
    definition: definition(),
    parameterValues: {
      [MAXIMUM_RESPONSE_TIME_PARAMETER]: maximum,
    },
    conversation: conversation(samples),
    judging: noJudgeWanted(),
    reading: {
      async expectedBehaviors() {
        return [];
      },
    },
  });
}

describe("Response latency", () => {
  it("passes when the p90 is at or below the project maximum", async () => {
    // Ten samples, so the p90 is the ninth of them and not the slowest: the
    // one nine-second turn is exactly what a mean would have hidden and what
    // this grader is now built to catch, but at rank nine it is still inside
    // the bound.
    const ten = [
      500, 600, 700, 800, 900, 1_000, 1_100, 1_200, 3_000, 9_000,
    ];
    await expect(grade(ten)).resolves.toEqual({
      score: 1,
      details: {
        rationale: "The p90 response time was 3000 ms; the maximum was 3000 ms.",
        observedP90ResponseTimeMs: 3_000,
        maximumResponseTimeMs: 3_000,
      },
    });
  });

  it("fails when the p90 is above the project maximum", async () => {
    const ten = [
      500, 600, 700, 800, 900, 1_000, 1_100, 1_200, 3_001, 9_000,
    ];
    await expect(grade(ten)).resolves.toMatchObject({
      score: 0,
      details: { observedP90ResponseTimeMs: 3_001 },
    });
  });

  it("returns a grading error when the metric is missing", async () => {
    await expect(grade([])).resolves.toEqual({
      score: null,
      details: {
        error: "this trace has no valid turn response latency measurements",
      },
    });
  });
});
