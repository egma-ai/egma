import { describe, expect, it } from "vitest";

import { meanOf, worstSampleOf, type MeasuredFromSpans } from "../src/index.ts";

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

describe("meanOf", () => {
  it("averages the samples and rounds to the nearest whole unit", () => {
    expect(meanOf(measured([100, 200, 400]))).toBe(233);
    expect(meanOf(measured([1, 2]))).toBe(2);
  });

  it("answers the single sample itself for a measure taken once", () => {
    expect(meanOf(measured([1840]))).toBe(1840);
  });

  it("is undefined for an empty series, exactly as the worst is", () => {
    expect(meanOf(measured([]))).toBeUndefined();
    expect(worstSampleOf(measured([]))).toBeUndefined();
  });

  it("keeps fractional reported samples honest in the rounding", () => {
    expect(meanOf(measured([2387.5, 2387.5]))).toBe(2388);
  });
});
