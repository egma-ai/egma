import { MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER } from "@egma/db";

import type { Execution, GraderResult } from "./contract.ts";

const RESPONSE_LATENCY_MEASURE = "turn_response_latency";

/** Grade the arithmetic mean of every measured turn response time. */
export function executeResponseLatency(execution: Execution): GraderResult {
  const nothingToGrade = execution.conversation.nothingToJudgeBecause;
  if (nothingToGrade !== null) {
    return { score: null, details: { error: nothingToGrade } };
  }

  const maximum =
    execution.parameterValues[MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER];
  if (
    typeof maximum !== "number" ||
    !Number.isInteger(maximum) ||
    maximum <= 0
  ) {
    return {
      score: null,
      details: {
        error:
          "Maximum average response time must be a positive whole number of milliseconds",
      },
    };
  }

  const measured = execution.conversation.measures.find(
    (one) => one.measure === RESPONSE_LATENCY_MEASURE,
  );
  const samples = measured?.samples.map((sample) => sample.value) ?? [];
  if (
    samples.length === 0 ||
    samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    return {
      score: null,
      details: {
        error: "this trace has no valid turn response latency measurements",
      },
    };
  }

  const average = samples.reduce((sum, sample) => sum + sample, 0) /
    samples.length;
  const passed = average <= maximum;
  return {
    score: passed ? 1 : 0,
    details: {
      rationale:
        `Average response time was ${formatMilliseconds(average)} ms; ` +
        `the maximum was ${maximum} ms.`,
      observedAverageResponseTimeMs: average,
      maximumAverageResponseTimeMs: maximum,
    },
  };
}

function formatMilliseconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
