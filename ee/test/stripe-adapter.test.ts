import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyStripeEvent } from "../src/access/stripe.ts";
import { seedCloudPlans } from "../src/access/plans.ts";
import type {
  CanonicalSubscription,
  StripeDelivery,
} from "../src/stripe/facts.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import { seedOrganization } from "../../packages/db/test/support/tenancy.ts";

let database: MigratedDatabase;
const CREATED = new Date("2026-01-15T08:00:00Z");
const PERIOD = new Date("2026-09-20T13:30:00Z");
const RESET = new Date("2026-10-20T13:30:00Z");
const acme = {
  organizationId: newId("org"),
  customerId: "cus_stripe_adapter_acme",
};
const globex = {
  organizationId: newId("org"),
  customerId: "cus_stripe_adapter_globex",
};

beforeAll(async () => {
  database = await createConnectedDatabase("ee-stripe-adapter");
  await seedCloudPlans();
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, []);
    await database.sql(
      "update organization set created_at = $2 where id = $1",
      [who.organizationId, CREATED],
    );
    await database.sql(
      `insert into cloud_billing_account
      (id, organization_id, plan_code, period_anchor, activated_at, stripe_customer_id, balance_micros)
      values ($1, $2, 'hobby', $3, $3, $4, 5000000)`,
      [newId("cba"), who.organizationId, CREATED, who.customerId],
    );
  }
});
afterAll(async () => {
  await database?.drop();
});

async function account(who = acme) {
  const { rows } = await database.sql<{
    plan_code: string;
    balance_micros: string;
    period_anchor: Date;
    stripe_subscription_status: string | null;
    stripe_subscription_refreshed_at: Date | null;
    stripe_period_started_at: Date | null;
    stripe_period_ends_at: Date | null;
    stripe_cancel_at: Date | null;
  }>("select * from cloud_billing_account where organization_id = $1", [
    who.organizationId,
  ]);
  if (rows[0] === undefined) throw new Error("missing account");
  return rows[0];
}
function credit(sessionId: string, eventId = newId("cle")): StripeDelivery {
  return {
    id: eventId,
    type: "checkout.session.completed",
    fact: {
      kind: "purchased_credit",
      customerId: acme.customerId,
      sessionId,
      organizationId: acme.organizationId,
      amountMicros: 25000000,
      occurredAt: PERIOD,
    },
  };
}
const trigger: StripeDelivery = {
  id: "evt_subscription",
  type: "customer.subscription.updated",
  fact: { kind: "subscription", customerId: acme.customerId },
};
const active: CanonicalSubscription = {
  subscriptionId: "sub_current",
  status: "active",
  periodAnchor: PERIOD,
  periodStartedAt: PERIOD,
  periodEndsAt: RESET,
  hobbyStartedAt: null,
  cancelAt: null,
};
const canceled: CanonicalSubscription = {
  ...active,
  status: "canceled",
  hobbyStartedAt: RESET,
};

describe("verified Stripe domain facts", () => {
  it("persists scheduled Pro cancellation and clears it when Stripe confirms undo", async () => {
    const before = await account();
    await applyStripeEvent(trigger, PERIOD, async () => ({ ...active, cancelAt: RESET }));
    expect(await account()).toMatchObject({
      plan_code: "pro",
      stripe_cancel_at: RESET,
      period_anchor: PERIOD,
      balance_micros: before.balance_micros,
    });
    await applyStripeEvent(trigger, RESET, async () => active);
    expect(await account()).toMatchObject({
      plan_code: "pro",
      stripe_cancel_at: null,
      period_anchor: PERIOD,
      balance_micros: before.balance_micros,
    });
  });
  it("credits one paid Checkout Session once across concurrent distinct event IDs", async () => {
    const results = await Promise.all([
      applyStripeEvent(credit("cs_one")),
      applyStripeEvent(credit("cs_one")),
    ]);
    expect(results.filter((one) => one.effect === "credited")).toHaveLength(1);
    expect(
      results.filter((one) => one.effect === "credit_already_written"),
    ).toHaveLength(1);
    expect(Number((await account()).balance_micros)).toBe(30000000);
    expect(Number((await account(globex)).balance_micros)).toBe(5000000);
    const { rows } = await database.sql(
      "select reference_id from cloud_ledger_entry where kind = 'purchased_credit'",
    );
    expect(rows).toEqual([{ reference_id: "cs_one" }]);
  });
  it("rejects credit for another organization without a balance movement", async () => {
    const delivery = credit("cs_mismatch");
    if (delivery.fact?.kind !== "purchased_credit")
      throw new Error("expected credit fact");
    await expect(
      applyStripeEvent({
        ...delivery,
        fact: { ...delivery.fact, organizationId: globex.organizationId },
      }),
    ).rejects.toThrow("another organization");
    await expect(
      applyStripeEvent({
        ...delivery,
        fact: { ...delivery.fact, amountMicros: 0 },
      }),
    ).rejects.toThrow("positive safe integer");
    await expect(
      applyStripeEvent({
        ...delivery,
        fact: { ...delivery.fact, customerId: "cus_unlinked" },
      }),
    ).rejects.toThrow("no billing account");
    expect(Number((await account()).balance_micros)).toBe(30000000);
  });
  it("ignores unrelated event types without retaining an event table", async () => {
    expect(
      await applyStripeEvent({ id: "evt_ignored", type: "invoice.paid" }),
    ).toEqual({ applied: true, effect: "ignored" });
    const { rows } = await database.sql(
      "select to_regclass('cloud_stripe_event') as events",
    );
    expect(rows[0]?.events).toBeNull();
  });
  it("uses current Stripe state for repeated and out-of-order triggers", async () => {
    await applyStripeEvent(trigger, PERIOD, async () => active);
    expect(await account()).toMatchObject({
      plan_code: "pro",
      stripe_period_started_at: PERIOD,
      stripe_period_ends_at: RESET,
      period_anchor: PERIOD,
    });
    await applyStripeEvent(trigger, PERIOD, async () => canceled);
    expect(await account()).toMatchObject({
      plan_code: "hobby",
      stripe_subscription_status: "canceled",
      period_anchor: RESET,
    });
    await applyStripeEvent(
      {
        ...trigger,
        id: "evt_old_create",
        type: "customer.subscription.created",
      },
      RESET,
      async () => canceled,
    );
    expect(await account()).toMatchObject({
      plan_code: "hobby",
      stripe_subscription_status: "canceled",
      stripe_subscription_refreshed_at: RESET,
    });
  });
  it("keeps network reads and writes in the same customer serialization order", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reads: string[] = [];
    const first = applyStripeEvent(trigger, PERIOD, async () => {
      reads.push("first");
      entered?.();
      await held;
      return active;
    });
    await firstRead;
    const second = applyStripeEvent(trigger, RESET, async () => {
      reads.push("second");
      return canceled;
    });
    await database.sql("select 1");
    expect(reads).toEqual(["first"]);
    release?.();
    await Promise.all([first, second]);
    expect(reads).toEqual(["first", "second"]);
    expect((await account()).plan_code).toBe("hobby");
  });
  it("starts the fresh Hobby cycle at the proven downgrade time and never at delivery time", async () => {
    const downgradeAt = new Date("2026-10-02T10:35:00Z");
    await applyStripeEvent(trigger, PERIOD, async () => active);
    await applyStripeEvent(
      trigger,
      RESET,
      async (_, needsTransition, previousSubscriptionId) => {
        expect(needsTransition).toBe(true);
        expect(previousSubscriptionId).toBe(active.subscriptionId);
        return {
          ...canceled,
          subscriptionId: "sub_new_incomplete",
          status: "incomplete",
          hobbyStartedAt: downgradeAt,
        };
      },
    );
    expect((await account()).period_anchor).toEqual(downgradeAt);
    await applyStripeEvent(
      trigger,
      new Date("2026-11-01T00:00:00Z"),
      async () => ({ ...canceled, hobbyStartedAt: null }),
    );
    expect((await account()).period_anchor).toEqual(downgradeAt);
  });

  it("does not apply incomplete or failed canonical reads", async () => {
    await expect(
      applyStripeEvent(trigger, RESET, async () => ({
        ...active,
        periodEndsAt: null,
      })),
    ).rejects.toThrow("complete period bounds");
    await expect(
      applyStripeEvent(trigger, RESET, async () => {
        throw new Error("Stripe is down");
      }),
    ).rejects.toThrow("Stripe is down");
    expect((await account()).plan_code).toBe("hobby");
    expect((await account(globex)).stripe_subscription_refreshed_at).toBeNull();
  });
});
