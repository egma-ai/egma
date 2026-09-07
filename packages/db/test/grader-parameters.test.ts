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
  it("accepts complete text and decimal settings without converting their types", () => {
    const models = [
      { key: "llm_model", label: "Model", valueType: "string", defaultValue: "gpt-5.2", unit: null, minimum: null, maximum: null },
      { key: "tts_speed", label: "Speed", valueType: "number", defaultValue: 1, unit: null, minimum: 0.6, maximum: 1.5 },
    ];
    expect(validateGraderParameterValues(models, { llm_model: "gpt-5.2", tts_speed: 0.8 }))
      .toEqual({ llm_model: "gpt-5.2", tts_speed: 0.8 });
    expect(() => validateGraderParameterValues(models, { llm_model: 5, tts_speed: 1 }))
      .toThrow("must be nonempty text");
    expect(() => validateGraderParameterValues(models, { llm_model: "gpt-5.2", tts_speed: "1" }))
      .toThrow("must be a number");
  });
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
