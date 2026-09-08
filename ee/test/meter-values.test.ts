import { describe, expect, it } from "vitest";

import { minuteValueAdded } from "../src/stripe/facts.ts";
import {
  periodOverageCents,
  latePaymentDefaults,
} from "../src/stripe/late-facts.ts";
import { creditAmountRefusal } from "../src/stripe/actions.ts";

describe("per-second usage sent to minute meters", () => {
  it("uses the current customer card or the original subscription card without inventing a payment method", () => {
    const subscriptionOnly = {
      customerPaymentMethod: null,
      subscriptionPaymentMethod: "pm_subscription",
      customerSource: null,
      subscriptionSource: null,
    };
    expect(latePaymentDefaults(subscriptionOnly)).toEqual({
      default_payment_method: "pm_subscription",
    });
    expect(
      latePaymentDefaults({
        ...subscriptionOnly,
        customerPaymentMethod: "pm_current",
      }),
    ).toEqual({ default_payment_method: "pm_current" });
    expect(
      latePaymentDefaults({
        ...subscriptionOnly,
        subscriptionPaymentMethod: null,
        subscriptionSource: "src_saved",
      }),
    ).toEqual({ default_source: "src_saved" });
    expect(
      latePaymentDefaults({
        ...subscriptionOnly,
        subscriptionPaymentMethod: null,
      }),
    ).toBeUndefined();
  });
  it("rejects sub-cent credit purchases before rounding can change their paid amount", () => {
    expect(creditAmountRefusal(5_000_001)).toContain("whole cents");
    expect(creditAmountRefusal(5_010_000)).toBeUndefined();
  });
  it("rounds the complete original period once and preserves its included allowance", () => {
    expect(periodOverageCents(300, 300, 1)).toBe(0);
    expect(periodOverageCents(329, 300, 1)).toBe(0);
    expect(periodOverageCents(330, 300, 1)).toBe(1);
    expect(periodOverageCents(360, 300, 2)).toBe(2);
    expect(() => periodOverageCents(-1, 300, 2)).toThrow();
  });
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
