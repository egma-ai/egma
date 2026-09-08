import { describe, expect, it } from "vitest";

import { loadCloudBilling } from "../src/billing.ts";

describe("optional grader billing", () => {
  it.each([undefined, "", "   "])(
    "needs no billing module for an unset Stripe key (%s)",
    async (stripeSecretKey) => {
      await expect(loadCloudBilling({ stripeSecretKey })).resolves.toBeUndefined();
    },
  );
});
