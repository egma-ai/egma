import { describe, expect, it } from "vitest";

import {
  billingPlugInFor,
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

describe("which plug-in a deployment's settings select", () => {
  it("selects the open one when no Stripe secret is named", () => {
    // Both shapes of absent: the setting missing, and the setting present and
    // blank — a compose file with an empty variable is the common way to have
    // one without meaning to.
    for (const settings of [
      {},
      { stripeSecretKey: undefined },
      { stripeSecretKey: "" },
      { stripeSecretKey: "   " },
    ]) {
      const plugIn = billingPlugInFor(settings);
      expect(plugIn.entitlements).toBeDefined();
      expect(plugIn.usage).toBeDefined();
    }
  });

  it("refuses a Stripe secret out loud, because the adapter it names is not here yet", () => {
    // Never quietly "unlimited": an operator who set a Stripe key expects to
    // be charging, and a deployment that took the key and billed nobody is the
    // worse of the two failures.
    expect(() => billingPlugInFor({ stripeSecretKey: "sk_test_whatever" })).toThrow(
      /ee\//u,
    );
  });

  it("derives nothing from whether this deployment is the cloud", () => {
    // The settings it is given are the whole of what it may read. A region, a
    // hostname or a mode flag reaching it through the process is the failure
    // ADR-0024 exists to prevent — Langfuse's own comments say why — so the
    // rule is checked two ways: it takes one argument, and it reads nothing
    // outside it.
    expect(billingPlugInFor.length).toBe(1);
    expect(billingPlugInFor.toString()).not.toContain("process.env");

    // And the same settings answer the same way whatever the process says
    // about itself.
    const before = process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR;
    try {
      process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR = "cloud";
      const asCloud = billingPlugInFor({});
      process.env.EGMA_TEST_DEPLOYMENT_FLAVOUR = "self-host";
      const asSelfHost = billingPlugInFor({});
      expect(Object.keys(asCloud)).toEqual(Object.keys(asSelfHost));
      expect(() => billingPlugInFor({ stripeSecretKey: "sk_test_x" })).toThrow();
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
