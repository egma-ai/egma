import { describe, expect, it } from "vitest";

import { billingIsConfigured } from "../src/index.ts";

/**
 * Whether a deployment's settings name a Stripe secret, which decides whether
 * `apps/api` loads the cloud billing plug-in or runs on the open one.
 */

describe("what a deployment's settings say about billing", () => {
  it("says billing is unconfigured when no Stripe secret is named", () => {
    // Both shapes of absent: the setting missing, and the setting present and
    // blank — a compose file with an empty variable is the common way to have
    // one without meaning to.
    for (const settings of [
      {},
      { stripeSecretKey: undefined },
      { stripeSecretKey: "" },
      { stripeSecretKey: "   " },
    ]) {
      expect(billingIsConfigured(settings)).toBe(false);
    }
  });

  it("says billing is configured when a Stripe secret is named", () => {
    // What the secret then selects is decided in `apps/api`, which is the one
    // place allowed to import the commercially licensed package — and only
    // through an import taken when this answers true.
    expect(billingIsConfigured({ stripeSecretKey: "sk_test_whatever" })).toBe(
      true,
    );
  });
});
