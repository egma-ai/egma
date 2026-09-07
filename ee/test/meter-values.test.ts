import { describe, expect, it } from "vitest";

import { minuteValueAdded } from "../src/stripe/facts.ts";

describe("per-second usage sent to minute meters", () => {
  it("retains a ten-second call instead of dropping a fractional minute", () => {
    expect(minuteValueAdded(0, 10)).toBe("0.166666666667");
  });

  it("carries decimal rounding across reports to total exactly one minute", () => {
    expect(minuteValueAdded(10, 20)).toBe("0.166666666666");
    expect(minuteValueAdded(20, 60)).toBe("0.666666666667");
    expect(minuteValueAdded(60, 90)).toBe("0.500000000000");
  });

  it("refuses decreasing or unsafe totals instead of inventing usage", () => {
    expect(() => minuteValueAdded(60, 59)).toThrow();
    expect(() => minuteValueAdded(0, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
