import { describe, expect, it } from "vitest";

import { aggregateOf, worstSampleOf, type MeasuredFromSpans } from "../src/index.ts";

/**
 * The two reductions, held to their stated words: the mean is the average
 * rounded to the nearest whole unit, the worst is the largest sample — and the
 * rounding lives in the module, once, so no surface ever rounds for itself.
 */
function measured(values: readonly number[]): MeasuredFromSpans {
  return {
    measure: "turn_response_latency",
    unit: "milliseconds",
    origin: "timed",
    reportedBy: "",
    samples: values.map((value, at) => ({ value, spanId: `span-${String(at)}` })),
  };
}

describe("aggregateOf", () => {
  it("averages the samples and rounds to the nearest whole unit", () => {
    expect(aggregateOf(measured([100, 200, 400]), "mean")).toBe(233);
    expect(aggregateOf(measured([1, 2]), "mean")).toBe(2);
  });

  it("answers the single sample itself for a measure taken once", () => {
    for (const aggregation of ["mean", "p50", "p90", "max"] as const) {
      expect(aggregateOf(measured([1840]), aggregation)).toBe(1840);
    }
  });

  it("is undefined for an empty series, exactly as the worst is", () => {
    expect(aggregateOf(measured([]), "mean")).toBeUndefined();
    expect(worstSampleOf(measured([]))).toBeUndefined();
  });

  it("keeps fractional reported samples honest in the rounding", () => {
    expect(aggregateOf(measured([2387.5, 2387.5]), "mean")).toBe(2388);
  });

  /**
   * Nearest-rank, exactly as the catalog states it: the p90 of ten
   * measurements is the ninth of them — a measurement that actually happened,
   * findable in the transcript — never an interpolation.
   */
  it("answers percentiles by nearest rank", () => {
    const ten = measured([600, 620, 650, 700, 700, 720, 750, 800, 850, 4000]);
    expect(aggregateOf(ten, "p50")).toBe(700);
    expect(aggregateOf(ten, "p90")).toBe(850);
    expect(aggregateOf(ten, "p95")).toBe(4000);
    expect(aggregateOf(ten, "p99")).toBe(4000);
    // Unsorted input answers the same: the module sorts, the caller need not.
    expect(aggregateOf(measured([1100, 420]), "p50")).toBe(420);
    expect(aggregateOf(measured([1100, 420]), "p90")).toBe(1100);
  });

  it("answers the remaining reductions plainly", () => {
    const three = measured([100, 200, 400]);
    expect(aggregateOf(three, "sum")).toBe(700);
    expect(aggregateOf(three, "min")).toBe(100);
    expect(aggregateOf(three, "max")).toBe(400);
  });
});
