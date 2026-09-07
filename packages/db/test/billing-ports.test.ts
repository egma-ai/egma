import { describe, expect, it } from "vitest";

import {
  billingIsConfigured,
  discardingUsageSink,
  entitlementSourceContract,
  installBillingPlugIn,
  openBillingPlugIn,
  openEntitlementSource,
  usageSinkContract,
} from "../src/index.ts";
import { ALLOWANCE_KINDS } from "../src/billing/allowance.ts";
import { billing } from "../src/billing/ports.ts";

/**
 * The two ports, and the adapters a deployment with no billing runs on.
 *
 * The contract is the same list the cloud adapter in `ee/` will be run
 * through; what is proven here is that the open adapters satisfy it, and that
 * a deployment which names no Stripe secret gets them.
 */

describe("the entitlement source contract, against the open adapter", () => {
  for (const check of entitlementSourceContract(openEntitlementSource)) {
    it(check.name, async () => {
      await check.run();
    });
  }
});

describe("the usage sink contract, against the open adapter", () => {
  for (const check of usageSinkContract(discardingUsageSink)) {
    it(check.name, async () => {
      await check.run();
    });
  }
});

describe("what a deployment with no billing answers", () => {
  it("allows every kind of work, without limit", async () => {
    const decision = await openEntitlementSource().mayStart({
      organizationId: "org_whoever",
      allowances: [...ALLOWANCE_KINDS],
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("lets its own key fund every provider", async () => {
    const decision = await openEntitlementSource().mayPlatformKeyFund({
      organizationId: "org_whoever",
      providers: ["openai", "deepgram", "cartesia"],
    });
    expect(decision).toEqual({ funded: true });
  });

  it("takes usage records and does nothing with them", async () => {
    await expect(discardingUsageSink().receive([])).resolves.toBeUndefined();
  });
});

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

  it("derives nothing from whether this deployment is the cloud", () => {
    // The settings it is given are the whole of what it may read. A region, a
    // hostname or a mode flag reaching it through the process is the failure
    // ADR-0024 exists to prevent — Langfuse's own comments say why — so the
    // rule is checked two ways: it takes one argument, and it reads nothing
    // outside it.
    expect(billingIsConfigured.length).toBe(1);
    expect(billingIsConfigured.toString()).not.toContain("process.env");

    // And the same settings answer the same way whatever the process says
    // about itself.
    const before = process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR;
    try {
      process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR = "cloud";
      const asCloud = billingIsConfigured({});
      process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR = "self-host";
      const asSelfHost = billingIsConfigured({});
      expect(asCloud).toBe(asSelfHost);
    } finally {
      if (before === undefined) delete process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR;
      else process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR = before;
    }
  });
});

describe("the installed plug-in", () => {
  it("is the open one until a process installs another", () => {
    expect(billing().entitlements).toBeDefined();
  });

  it("goes back to what it was when a caller undoes the install", async () => {
    const before = billing();
    const restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      entitlements: {
        mayStart: () =>
          Promise.resolve({
            allowed: false,
            refusals: [
              {
                allowance: "phone_minutes",
                resetsAt: new Date("2026-10-01T00:00:00.000Z"),
                message: "Out of phone minutes until 1 October.",
              },
            ],
          }),
        mayPlatformKeyFund: () => Promise.resolve({ funded: true }),
      },
    });

    const refused = await billing().entitlements.mayStart({
      organizationId: "org_whoever",
      allowances: ["phone_minutes"],
    });
    expect(refused.allowed).toBe(false);

    restore();
    expect(billing()).toBe(before);
    const allowed = await billing().entitlements.mayStart({
      organizationId: "org_whoever",
      allowances: ["phone_minutes"],
    });
    expect(allowed).toEqual({ allowed: true });
  });
});
