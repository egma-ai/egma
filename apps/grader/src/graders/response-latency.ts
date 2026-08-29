import { MAXIMUM_RESPONSE_TIME_PARAMETER } from "@egma/db";
import { p90Of } from "@egma/metrics";

import type { Execution, GraderResult } from "./contract.ts";

const RESPONSE_LATENCY_MEASURE = "turn_response_latency";

/**
 * Grade the p90 of every measured turn response time.
 *
 * **The p90 rather than the mean, since 2026-08-29.** A mean hides the one
 * turn that took nine seconds, and the tail is what a caller feels. It is also
 * the reduction the simulation page leads with, so a developer reading a
 * conversation's latency and this grader judging it are now reading one
 * number — which the mean-against-p90 split they had before made impossible.
 *
 * Below ten samples the nearest-rank p90 is the slowest turn. That is the
 * honest answer for a short conversation rather than an accident: nearest-rank
 * never interpolates a number nothing measured.
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
