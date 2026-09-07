import { describe, expect, it } from "vitest";

import { loadCloudBilling } from "../src/billing.ts";

describe("optional API billing", () => {
  it.each([undefined, "", "   "])(
    "needs no billing module for an unset Stripe key (%s)",
    async (stripeSecretKey) => {
      await expect(
        loadCloudBilling({ stripeSecretKey, baseUrl: "https://egma.test" }),
      ).resolves.toBeUndefined();
    },
  );
});
