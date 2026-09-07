import { MAXIMUM_RESPONSE_TIME_PARAMETER } from "@egma/db";
import { p90Of } from "@egma/metrics";

import type { Execution, GraderResult } from "./contract.ts";

const RESPONSE_LATENCY_MEASURE = "turn_response_latency";

/**
 * Grade p90 turn response latency, the same reduction shown by the UI.
 * Nearest-rank p90 uses the slowest turn below ten samples and never
 * interpolates an unobserved value.
 */
export function executeResponseLatency(execution: Execution): GraderResult {
  const nothingToGrade = execution.conversation.nothingToJudgeBecause;
  if (nothingToGrade !== null) {
    return { score: null, details: { error: nothingToGrade } };
  }

  const maximum = execution.parameterValues[MAXIMUM_RESPONSE_TIME_PARAMETER];
  if (
    typeof maximum !== "number" ||
    !Number.isInteger(maximum) ||
    maximum <= 0
  ) {
    return {
      score: null,
      details: {
        error:
          "Maximum response time must be a positive whole number of milliseconds",
      },
    };
  }

  const measured = execution.conversation.measures.find(
    (one) => one.measure === RESPONSE_LATENCY_MEASURE,
  );
  const observed = measured === undefined ? undefined : p90Of(measured);
  if (observed === undefined) {
    return {
      score: null,
      details: {
        error: "this trace has no valid turn response latency measurements",
      },
    };
  }

  const passed = observed <= maximum;
  return {
    score: passed ? 1 : 0,
    details: {
      rationale:
        `The p90 response time was ${formatMilliseconds(observed)} ms; ` +
        `the maximum was ${maximum} ms.`,
      observedP90ResponseTimeMs: observed,
      maximumResponseTimeMs: maximum,
    },
  };
}

function formatMilliseconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
