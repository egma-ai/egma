import type { MeasureAggregation, ThresholdComparator } from "@egma/db";

import { theOneCheck, type ExecutionOf, type Judgment } from "./contract.ts";

/**
 * A measurement turned into a judgment — "p90 of turn_response_latency under
 * 2000ms" — and no model is asked anything.
 *
 * A metric measures and a grader judges: nobody decided that a turn took nine
 * seconds, and somebody had to decide that nine seconds is too long. This
 * executor is that decision applied, in-process, instantly, and identically
 * every time. That is the whole reason a deterministic type exists beside the
 * judged ones.
 *
 * ## What it reads, and what it does when it is not there
 *
 * The measures a simulation produced live on its header row, as an object whose
 * keys are the measure names the simulator emits. A value is either one number
 * — a measure taken once, like the first response — or a list of numbers, a
 * measure taken per turn. Both are aggregated by the same eight aggregations;
 * one number aggregates to itself under every one of them.
 *
 * Three absences, and they are deliberately not one:
 *
 * - **The measure is not there** — no key, a null, or an empty list. `skipped`:
 *   this conversation did not produce the thing the check is about, so the check
 *   did not apply, and a check that did not apply neither passed nor failed
 *   anything. The fold leaves it out of the score's denominator, which is what
 *   stops a chat simulation being marked down for having no audio latency.
 * - **The measure is there in a shape egma never writes** — a string, an object,
 *   a list with something in it that is not a number. `errored`: this is a
 *   broken row rather than a missing measurement, and calling it `skipped` would
 *   quietly hide data corruption behind a word that means "fine, not
 *   applicable".
 * - **The simulation never ran at all.** That one never reaches here: the engine
 *   writes `errored` for every grader without executing any of them, because a
 *   test that could not run is never a test that failed.
 */
export function executeMetricThreshold(
  execution: ExecutionOf<"metric_threshold">,
): readonly Judgment[] {
  const { config } = execution.judgment;
  const dimension = theOneCheck("metric_threshold");
  const read = samplesOf(execution.conversation.metrics, config.measure);

  if (read.kind === "unreadable") {
    return [
      {
        dimension,
        verdict: "errored",
        score: 0,
        rationale: `${config.measure} is recorded in a shape egma never writes, so it could not be read.`,
        citedSpanIds: [],
      },
    ];
  }

  if (read.kind === "absent") {
    return [
      {
        dimension,
        verdict: "skipped",
        score: 0,
        rationale: `this conversation measured no ${config.measure}, so there was nothing to hold to a threshold.`,
        citedSpanIds: [],
      },
    ];
  }

  const measured = aggregate(read.samples, config.aggregation);
  const passed = holds(measured, config.comparator, config.threshold);

  return [
    {
      dimension,
      verdict: passed ? "passed" : "failed",
      score: passed ? 1 : 0,
      rationale: `${config.aggregation} of ${config.measure} was ${round(measured)}, which is ${passed ? "" : "not "}${inWords(config.comparator)} ${config.threshold}.`,
      // Empty, and honestly so: this judgment is about a number the whole
      // conversation produced rather than about anything anybody said, so there
      // is no turn to point a reader at. A cited span here would be decoration.
      citedSpanIds: [],
    },
  ];
}

/** What reading one measure off a conversation can come to. */
type Reading =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "measured"; readonly samples: readonly number[] };

function samplesOf(metrics: unknown, measure: string): Reading {
  if (metrics === undefined || metrics === null) return { kind: "absent" };
  if (typeof metrics !== "object" || Array.isArray(metrics)) {
    return { kind: "unreadable" };
  }

  const value = (metrics as Record<string, unknown>)[measure];
  if (value === undefined || value === null) return { kind: "absent" };

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "measured", samples: [value] }
      : { kind: "unreadable" };
  }

  if (!Array.isArray(value)) return { kind: "unreadable" };
  if (value.length === 0) return { kind: "absent" };
  for (const sample of value) {
    if (typeof sample !== "number" || !Number.isFinite(sample)) {
      return { kind: "unreadable" };
    }
  }
  return { kind: "measured", samples: value as number[] };
}

/**
 * The samples reduced to the one number a threshold is applied to.
 *
 * Percentiles are nearest-rank on the sorted samples — the p90 of ten
 * measurements is the ninth of them, not an interpolation between the ninth and
 * the tenth. Nearest-rank is a measurement that actually happened, which is what
 * somebody reading "p90 was 1800ms" expects to be able to find in the
 * transcript; an interpolated 1783ms is a number no turn ever took.
 */
function aggregate(
  samples: readonly number[],
  aggregation: MeasureAggregation,
): number {
  const sum = samples.reduce((total, sample) => total + sample, 0);

  switch (aggregation) {
    case "mean":
      return sum / samples.length;
    case "sum":
      return sum;
    case "max":
      return Math.max(...samples);
    case "min":
      return Math.min(...samples);
    case "p50":
      return percentile(samples, 50);
    case "p90":
      return percentile(samples, 90);
    case "p95":
      return percentile(samples, 95);
    case "p99":
      return percentile(samples, 99);
  }
}

function percentile(samples: readonly number[], at: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((at / 100) * sorted.length);
  const found = sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
  // Unreachable: the list is non-empty by the time it gets here, and the rank
  // is clamped into it. Stated anyway, because the alternative is a `!`.
  if (found === undefined) throw new Error("a percentile of nothing was asked for");
  return found;
}

function holds(
  measured: number,
  comparator: ThresholdComparator,
  threshold: number,
): boolean {
  switch (comparator) {
    case "below":
      return measured < threshold;
    case "at_most":
      return measured <= threshold;
    case "above":
      return measured > threshold;
    case "at_least":
      return measured >= threshold;
  }
}

/** The comparator as somebody reads it in a sentence. */
function inWords(comparator: ThresholdComparator): string {
  switch (comparator) {
    case "below":
      return "below";
    case "at_most":
      return "at most";
    case "above":
      return "above";
    case "at_least":
      return "at least";
  }
}

/**
 * The measured number as a rationale should say it. A mean of three latencies is
 * 1633.3333333333333 milliseconds in a float and 1633.33 in a sentence, and the
 * digits after that are noise a person has to read past.
 */
function round(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(2));
}
