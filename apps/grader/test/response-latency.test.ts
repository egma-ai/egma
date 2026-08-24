import {
  MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
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
    outputContract: null,
    modalities: ["chat", "voice"],
    judgeModel: null,
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
      [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: maximum,
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
  it("passes when the arithmetic mean is at or below the project maximum", async () => {
    await expect(grade([2_000, 3_000, 4_000])).resolves.toEqual({
      score: 1,
      details: {
        rationale: "Average response time was 3000 ms; the maximum was 3000 ms.",
        observedAverageResponseTimeMs: 3_000,
        maximumAverageResponseTimeMs: 3_000,
      },
    });
  });

  it("fails when the arithmetic mean is above the project maximum", async () => {
    await expect(grade([3_001, 4_000])).resolves.toMatchObject({
      score: 0,
      details: { observedAverageResponseTimeMs: 3_500.5 },
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
