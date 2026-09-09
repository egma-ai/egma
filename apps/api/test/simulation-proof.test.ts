import { describe, expect, it } from "vitest";

import { assertValidGrade } from "./support/simulation-proof.ts";

function grade(result: "passed" | "failed" | "errored", score: number | null) {
  return {
    result,
    score,
    graderPassThreshold: 0.7,
    details: {},
  } as const;
}

describe("full-path grade proof", () => {
  it.each([
    ["passed", 0.8],
    ["failed", 0.6],
  ] as const)("accepts one valid %s grade stored and returned publicly", (result, score) => {
    expect(assertValidGrade(grade(result, score), {
      grades: [{ result, score, passThreshold: 0.7 }],
    })).toEqual({ result, score });
  });

  it("rejects an errored grader", () => {
    expect(() => assertValidGrade(grade("errored", null), {
      grades: [{ result: "errored", score: null, passThreshold: 0.7 }],
    })).toThrow();
  });

  it("rejects a result that disagrees with its frozen threshold", () => {
    expect(() => assertValidGrade(grade("passed", 0.6), {
      grades: [{ result: "passed", score: 0.6, passThreshold: 0.7 }],
    })).toThrow();
  });
});
