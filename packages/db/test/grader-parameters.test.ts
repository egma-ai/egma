import { describe, expect, it } from "vitest";

import {
  validateGraderParameterContract,
  validateGraderParameterValues,
} from "../src/grader-library/parameters.ts";

const contract = [{
  key: "maximum_response_time_ms",
  label: "Maximum response time (p90)",
  valueType: "integer",
  defaultValue: 3_000,
  unit: "milliseconds",
  minimum: 1,
  maximum: null,
}] as const;

describe("grader settings", () => {
  it("accepts the small typed contract with its default", () => {
    expect(validateGraderParameterContract(contract)).toEqual(contract);
  });

  it("accepts one complete value object and refuses missing or extra values", () => {
    expect(validateGraderParameterValues(contract, {
      maximum_response_time_ms: 2_500,
    })).toEqual({ maximum_response_time_ms: 2_500 });

    expect(() => validateGraderParameterValues(contract, {}))
      .toThrow("need values for maximum_response_time_ms");
    expect(() => validateGraderParameterValues(contract, {
      maximum_response_time_ms: 2_500,
      hidden: 1,
    })).toThrow("unsupported fields hidden");
  });

  it("refuses fractions and values outside the declared range", () => {
    expect(() => validateGraderParameterValues(contract, {
      maximum_response_time_ms: 2.5,
    })).toThrow("must be a whole number");
    expect(() => validateGraderParameterValues(contract, {
      maximum_response_time_ms: 0,
    })).toThrow("must be at least 1");
  });
});
