import { newId } from "@egma/ids";
import {
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  startRun,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyStripeEvent,
  centsFromMicros,
  creditAmountRefusal,
  hourAround,
  isPaying,
  LARGEST_CREDIT_MICROS,
  markOverageReported,
  microsFromCents,
  MOST_HOURS_CAUGHT_UP_AT_ONCE,
  overageOwedThrough,
  previousHour,
  purchasedCreditKey,
  seedCloudPlans,
  SMALLEST_CREDIT_MICROS,
  type OrganizationOverage,
  type StripeDelivery,
} from "../src/index.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import {
  seedOrganization,
  seedUser,
} from "../../packages/db/test/support/tenancy.ts";

/**
 * What Stripe's answers do to Egma's rows — and no Stripe anywhere.
 *
 * **Every delivery below enters as the fact Egma keeps from it**, which is
 * exactly what the webhook hands the access module after a signature has held.
 * Nothing here calls Stripe and nothing pretends to be it: the founders' rule
 * of 2026-09-07 says the adapter is proved against the real sandbox in its own
 * lane, and that the rules about plans, anchors and balances are proved
 * against rows. This file is the second half.
 *
 * **Two organizations throughout**, because the first question any of this has
 * to answer correctly is whose money moved. Acme buys credit and moves to Pro;
 * Globex stays on Hobby and must be untouched by every one of Acme's answers.
 */

let database: MigratedDatabase;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
  customerId: "cus_acme_for_this_suite",
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
  customerId: "cus_globex_for_this_suite",
};

/** Both customers were created on the 15th, so a Hobby month turns over then. */
const CREATED_AT = new Date("2026-01-15T08:00:00.000Z");
/** $5.00, as the shipped file states the welcome credit. */
const WELCOME_CREDIT_MICROS = 5_000_000;

function sessionOf(who: typeof acme): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role: "admin",
    via: "session",
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("ee-stripe-adapter");
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p-${who.projectId.slice(-6)}`.toLowerCase() },
    ]);
    await seedUser(database, who.userId, `${who.userId.slice(-8)}@example.test`);
    await database.sql("update organization set created_at = $2 where id = $1", [
      who.organizationId,
      CREATED_AT,
    ]);
  }
  await seedCloudPlans();
  // The account rows exist and carry the Stripe customer Egma linked. That
  // link is the only way a delivery ever finds an organization, so it is the
  // one Stripe fact this file seeds by hand.
  for (const who of [acme, globex]) {
    await database.sql(
      `insert into cloud_billing_account
         (id, organization_id, plan_code, period_anchor, stripe_customer_id,
          balance_micros)
       values ($1, $2, 'hobby', $3, $4, $5)`,
      [
        newId("cba"),
        who.organizationId,
        CREATED_AT,
        who.customerId,
        WELCOME_CREDIT_MICROS,
      ],
    );
  }
});

afterAll(async () => {
  await database?.drop();
});

/** What the account row says, read raw. */
async function accountRow(who: typeof acme): Promise<{
  plan_code: string;
  balance_micros: string;
  period_anchor: Date;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
}> {
  const { rows } = await database.sql<{
    plan_code: string;
    balance_micros: string;
    period_anchor: Date;
    stripe_subscription_id: string | null;
    stripe_subscription_status: string | null;
  }>(
    `select plan_code, balance_micros, period_anchor, stripe_subscription_id,
            stripe_subscription_status
     from cloud_billing_account where organization_id = $1`,
    [who.organizationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("no billing account");
  return row;
}

async function ledgerRows(
  who: typeof acme,
): Promise<{ kind: string; amount_micros: string; reference_id: string }[]> {
  const { rows } = await database.sql<{
    kind: string;
    amount_micros: string;
    reference_id: string;
  }>(
    `select kind, amount_micros, reference_id from cloud_ledger_entry
     where organization_id = $1 order by id`,
    [who.organizationId],
  );
  return rows;
}

async function recordedEvents(): Promise<{ id: string; type: string }[]> {
  const { rows } = await database.sql<{ id: string; type: string }>(
    "select id, type from cloud_stripe_event order by id",
  );
  return rows;
}

/** One purchased credit, as the webhook reads a completed Checkout Session. */
function creditDelivery(
  eventId: string,
  session: string,
  who: typeof acme,
  amountMicros: number,
): StripeDelivery {
  return {
    id: eventId,
    type: "checkout.session.completed",
    fact: {
      kind: "purchased_credit",
      customerId: who.customerId,
      sessionId: session,
      amountMicros,
      organizationId: who.organizationId,
      occurredAt: new Date("2026-09-20T12:00:00.000Z"),
    },
  };
}

/**
 * One subscription, as the webhook reads a `customer.subscription.*` event.
 *
 * **Every one of them says when Stripe stamped it**, because that is what
 * decides which of two deliveries about one subscription is the later one.
 * There is no default: a suite that let two events share an instant by
 * accident would be a suite that proved the ordering rule by luck.
 */
function subscriptionDelivery(
  eventId: string,
  who: typeof acme,
  said: {
    readonly status:
      | "active"
      | "trialing"
      | "past_due"
      | "unpaid"
      | "canceled";
    /** The event's own `created`, never the subscription's. */
    readonly at: Date;
    readonly periodStart?: Date | undefined;
    readonly finished?: boolean | undefined;
    readonly type?: string | undefined;
  },
): StripeDelivery {
  return {
    id: eventId,
    type: said.type ?? "customer.subscription.updated",
    fact: {
      kind: "subscription",
      customerId: who.customerId,
      subscriptionId: `sub_${who.organizationId.slice(-8)}`,
      status: said.status,
      periodStart: said.periodStart ?? null,
      finished: said.finished ?? false,
      occurredAt: said.at,
    },
  };
}

describe("what a purchased credit does to a balance", () => {
  it("writes one row keyed on the session and raises the balance by it", async () => {
    const applied = await applyStripeEvent(
      creditDelivery("evt_credit_1", "cs_first", acme, 25_000_000),
    );

    expect(applied).toEqual({ applied: true, effect: "credited" });
    const account = await accountRow(acme);
    expect(Number(account.balance_micros)).toBe(
      WELCOME_CREDIT_MICROS + 25_000_000,
    );
    const rows = await ledgerRows(acme);
    expect(rows).toEqual([
      { kind: "purchased_credit", amount_micros: "25000000", reference_id: "cs_first" },
    ]);
  });

  it("changes nothing when Stripe delivers the same event again", async () => {
    const before = await accountRow(acme);
    const applied = await applyStripeEvent(
      creditDelivery("evt_credit_1", "cs_first", acme, 25_000_000),
    );

    expect(applied).toEqual({ applied: false, effect: "redelivered" });
    expect(await accountRow(acme)).toEqual(before);
    expect(await ledgerRows(acme)).toHaveLength(1);
  });

  it("changes nothing when the same payment arrives under a new event id", async () => {
    const before = await accountRow(acme);
    const applied = await applyStripeEvent(
      // Stripe sends `async_payment_succeeded` as well as `completed` for a
      // delayed payment method, and both name the same session.
      {
        ...creditDelivery("evt_credit_2", "cs_first", acme, 25_000_000),
        type: "checkout.session.async_payment_succeeded",
      },
    );

    expect(applied).toEqual({ applied: true, effect: "credit_already_written" });
    expect((await accountRow(acme)).balance_micros).toBe(before.balance_micros);
    expect(await ledgerRows(acme)).toHaveLength(1);
  });

  it("keys the row on the session, so the key is derivable from it", async () => {
    const { rows } = await database.sql<{ idempotency_key: string }>(
      "select idempotency_key from cloud_ledger_entry where reference_id = $1",
      ["cs_first"],
    );
    expect(rows[0]?.idempotency_key).toBe(purchasedCreditKey("cs_first"));
  });

  it("leaves the other customer's balance exactly where it was", async () => {
    expect(Number((await accountRow(globex)).balance_micros)).toBe(
      WELCOME_CREDIT_MICROS,
    );
    expect(await ledgerRows(globex)).toEqual([]);
  });

  it("refuses a session whose organization is not its customer's", async () => {
    await expect(
      applyStripeEvent({
        id: "evt_credit_crossed",
        type: "checkout.session.completed",
        fact: {
          kind: "purchased_credit",
          customerId: acme.customerId,
          sessionId: "cs_crossed",
          amountMicros: 10_000_000,
          // Somebody else's organization on Acme's customer.
          organizationId: globex.organizationId,
          occurredAt: new Date("2026-09-20T12:00:00.000Z"),
        },
      }),
    ).rejects.toThrow(/names organization/);

    expect(await ledgerRows(globex)).toEqual([]);
    expect((await recordedEvents()).map((row) => row.id)).not.toContain(
      "evt_credit_crossed",
    );
  });

  it("records nothing at all for a customer no account holds", async () => {
    await expect(
      applyStripeEvent(
        creditDelivery("evt_credit_stranger", "cs_stranger", {
          ...acme,
          customerId: "cus_nobody_egma_linked",
        }, 10_000_000),
      ),
    ).rejects.toThrow(/no billing account holds/);

    // Unrecorded on purpose: Stripe redelivers, and a payment that reached
    // nobody is the one outcome worth being loud about.
    expect((await recordedEvents()).map((row) => row.id)).not.toContain(
      "evt_credit_stranger",
    );
  });
});

describe("an event type Egma does not act on", () => {
  it("is recorded and ignored", async () => {
    const applied = await applyStripeEvent({
      id: "evt_unknown_1",
      type: "invoice.payment_succeeded",
    });

    expect(applied).toEqual({ applied: true, effect: "ignored" });
    expect(await recordedEvents()).toContainEqual({
      id: "evt_unknown_1",
      type: "invoice.payment_succeeded",
    });
  });

  it("is still recorded only once", async () => {
    expect(
      await applyStripeEvent({
        id: "evt_unknown_1",
        type: "invoice.payment_succeeded",
      }),
    ).toEqual({ applied: false, effect: "redelivered" });
  });
});

/** Stripe's period start for the subscription this suite moves Acme onto. */
const STRIPE_PERIOD_START = new Date("2026-09-03T17:30:00.000Z");

/**
 * What Stripe stamped each of Acme's subscription events with, in the order
 * the events happened — which is deliberately not the order a webhook has to
 * arrive in. The last two are stamped before the deletion and delivered after
 * it, which is the fault this block exists to refuse.
 */
const STAMPED = {
  created: new Date("2026-09-03T17:30:02.000Z"),
  pastDue: new Date("2026-10-03T17:31:00.000Z"),
  unpaid: new Date("2026-10-24T09:00:00.000Z"),
  backToPro: new Date("2026-10-25T09:00:00.000Z"),
  deleted: new Date("2026-11-01T09:00:00.000Z"),
  staleUpdate: new Date("2026-10-30T09:00:00.000Z"),
} as const;

describe("what a subscription does to a plan", () => {
  it("moves the organization to Pro with Stripe's period start as its anchor", async () => {
    const applied = await applyStripeEvent(
      subscriptionDelivery("evt_sub_created", acme, {
        at: STAMPED.created,
        status: "active",
        periodStart: STRIPE_PERIOD_START,
        type: "customer.subscription.created",
      }),
    );

    expect(applied).toEqual({ applied: true, effect: "plan_changed" });
    const account = await accountRow(acme);
    expect(account.plan_code).toBe("pro");
    expect(account.stripe_subscription_status).toBe("active");
    expect(account.period_anchor.toISOString()).toBe(
      STRIPE_PERIOD_START.toISOString(),
    );
  });

  it("keeps Pro while Stripe is still retrying a failed renewal", async () => {
    await applyStripeEvent(
      subscriptionDelivery("evt_sub_past_due", acme, {
        at: STAMPED.pastDue,
        status: "past_due",
        periodStart: STRIPE_PERIOD_START,
      }),
    );

    const account = await accountRow(acme);
    expect(account.plan_code).toBe("pro");
    expect(account.stripe_subscription_status).toBe("past_due");
    expect(isPaying("past_due")).toBe(true);
  });

  it("returns the organization to Hobby when Stripe gives up", async () => {
    await applyStripeEvent(
      subscriptionDelivery("evt_sub_unpaid", acme, { at: STAMPED.unpaid, status: "unpaid" }),
    );

    const account = await accountRow(acme);
    expect(account.plan_code).toBe("hobby");
    expect(account.stripe_subscription_status).toBe("unpaid");
    // The organization's own creation instant, which is what a Hobby month has
    // always been counted from and needs no Stripe object to exist.
    expect(account.period_anchor.toISOString()).toBe(CREATED_AT.toISOString());
  });

  it("returns it to Hobby when the subscription ends at period end", async () => {
    await applyStripeEvent(
      subscriptionDelivery("evt_sub_back_to_pro", acme, {
        at: STAMPED.backToPro,
        status: "active",
        periodStart: STRIPE_PERIOD_START,
      }),
    );
    expect((await accountRow(acme)).plan_code).toBe("pro");

    await applyStripeEvent(
      subscriptionDelivery("evt_sub_deleted", acme, {
        at: STAMPED.deleted,
        status: "canceled",
        finished: true,
        type: "customer.subscription.deleted",
      }),
    );

    const account = await accountRow(acme);
    expect(account.plan_code).toBe("hobby");
    expect(account.period_anchor.toISOString()).toBe(CREATED_AT.toISOString());
  });

  it("refuses an update stamped before the deletion it arrives after", async () => {
    // Stripe promises no order, so the `active` update this customer's
    // cancellation replaced can land after the deletion did. Applying it would
    // put somebody who cancelled back on Pro and invoice them for it, and
    // nothing would correct it until Stripe sent something else.
    const applied = await applyStripeEvent(
      subscriptionDelivery("evt_sub_stale_update", acme, {
        at: STAMPED.staleUpdate,
        status: "active",
        periodStart: STRIPE_PERIOD_START,
      }),
    );

    expect(applied).toEqual({ applied: true, effect: "subscription_stale" });
    const account = await accountRow(acme);
    expect(account.plan_code).toBe("hobby");
    expect(account.stripe_subscription_status).toBe("canceled");
    expect(account.period_anchor.toISOString()).toBe(CREATED_AT.toISOString());
    // Recorded all the same. A stale event is answered rather than left for
    // Stripe to redeliver until it gives up.
    expect(await recordedEvents()).toContainEqual({
      id: "evt_sub_stale_update",
      type: "customer.subscription.updated",
    });
  });

  it("refuses one Stripe stamped in the same second as the one applied", async () => {
    // Two events stamped in the same second cannot be put in order, so the
    // state already applied is the one that stands. The event id is different,
    // so this is not the redelivery the event table already refuses.
    const applied = await applyStripeEvent(
      subscriptionDelivery("evt_sub_same_second", acme, {
        at: STAMPED.deleted,
        status: "active",
        periodStart: STRIPE_PERIOD_START,
      }),
    );

    expect(applied).toEqual({ applied: true, effect: "subscription_stale" });
    expect((await accountRow(acme)).plan_code).toBe("hobby");
  });

  it("never touches the customer the delivery does not name", async () => {
    const account = await accountRow(globex);
    expect(account.plan_code).toBe("hobby");
    expect(account.stripe_subscription_id).toBeNull();
  });
});

/**
 * The hour under test, and the conversations that end inside it.
 *
 * The conversations are written with their spans directly, as ticket 02's own
 * usage tests write them: what is under test is the arithmetic that turns
 * seconds into the whole minutes an hour owes, and a simulator that really
 * spoke for ninety minutes is not a thing a suite can wait for.
 */
const HOUR = hourAround(new Date("2026-09-20T13:20:00.000Z"));
const NEXT_HOUR = hourAround(new Date("2026-09-20T14:20:00.000Z"));
/** The hour before the busy one: where a mark sits before any of it happened. */
const PREVIOUS_HOUR = hourAround(new Date("2026-09-20T12:20:00.000Z"));

type SeededRun = {
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
};

const runs = new Map<string, SeededRun>();

async function seedRun(who: typeof acme): Promise<SeededRun> {
  const held = runs.get(who.organizationId);
  if (held !== undefined) return held;

  const auth = sessionOf(who);
  const label = newId("run").slice(-8).toLowerCase();
  const agent = await createAgent(auth, {
    agentPlatform: "retell",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const chatConnectionId = agent.connection?.id ?? "";

  const voiceConnectionId = newId("con");
  await database.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, $5, 'livekit_room',
             'livekit_room.project_credentials', 'voice', 'hosted-broker',
             '{}'::jsonb)`,
    [voiceConnectionId, who.organizationId, who.projectId, agent.id, `lk-${label}`],
  );

  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      identityName: "Sam Poole",
      personality: "Speaks plainly and asks one question at a time.",
      language: "en-US",
    })
  ).id;
  const suite = await createTestSuite(auth, { name: `Metering ${label}` });
  await createTest(auth, {
    suiteId: suite.id,
    name: `Reschedules ${label}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
  const started = await startRun(auth, {
    suiteId: suite.id,
    agentId: agent.id,
    connectionId: chatConnectionId,
  });
  const { rows } = await database.sql<{
    persona_version_id: string;
    test_id: string;
    test_version_id: string;
  }>(
    `select persona_version_id, test_id, test_version_id from simulation
     where run_id = $1 limit 1`,
    [started.id],
  );
  const pins = rows[0];
  if (pins === undefined) throw new Error("the run has no simulation");

  const made: SeededRun = {
    runId: started.id,
    agentId: agent.id,
    connectionId: voiceConnectionId,
    personaId,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
  };
  runs.set(who.organizationId, made);
  return made;
}

let position = 500;

/** One voice conversation of exactly this many seconds, ending at this instant. */
async function conversation(
  who: typeof acme,
  lane: {
    readonly connectionType: "livekit_room" | "phone_number";
    readonly endedAt: Date;
    readonly seconds: number;
  },
): Promise<void> {
  const run = await seedRun(who);
  position += 1;
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at, persona_parameter_values)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'voice', $12,
             'completed', 'persona_concluded',
             $13::timestamptz - make_interval(secs => $14::double precision),
             $13::timestamptz,
             (select persona_parameter_values from simulation where run_id = $2 limit 1))`,
    [
      newId("sim"),
      run.runId,
      who.organizationId,
      who.projectId,
      run.agentId,
      run.connectionId,
      run.personaId,
      run.personaVersionId,
      run.testId,
      run.testVersionId,
      position,
      lane.connectionType,
      lane.endedAt,
      lane.seconds,
    ],
  );
}

/** Put an organization on Pro with a subscription Stripe is happy with. */
async function onPro(
  who: typeof acme,
  status: string,
  anchor: Date,
): Promise<void> {
  await database.sql(
    `update cloud_billing_account
        set plan_code = $2, stripe_subscription_id = $3,
            stripe_subscription_status = $4, period_anchor = $5
      where organization_id = $1`,
    [
      who.organizationId,
      status === "unpaid" || status === "canceled" ? "hobby" : "pro",
      `sub_${who.organizationId.slice(-8)}`,
      status,
      anchor,
    ],
  );
}

/** Nothing reported yet, or reported through this hour. */
async function markedThrough(
  who: typeof acme,
  through: Date | null,
): Promise<void> {
  await database.sql(
    "update cloud_billing_account set overage_reported_through = $2 where organization_id = $1",
    [who.organizationId, through],
  );
}

/** Every hour owed, for the one organization this suite meters. */
async function owed(
  latestClosedHour = HOUR,
): Promise<readonly OrganizationOverage[]> {
  return overageOwedThrough(latestClosedHour, new Date("2026-09-20T15:00:00.000Z"));
}

describe("the hours a Pro month still owes Stripe", () => {
  it("reports every paying Pro organization and nobody else", async () => {
    await onPro(acme, "active", new Date("2026-09-03T17:30:00.000Z"));
    await markedThrough(acme, PREVIOUS_HOUR.startedAt);
    // Globex stays on Hobby: it has a Stripe customer because it once bought
    // credit, and a Hobby organization is never metered.
    const hours = await owed();

    expect(hours.map((one) => one.organizationId)).toEqual([acme.organizationId]);
    expect(hours[0]?.stripeCustomerId).toBe(acme.customerId);
    expect(hours[0]?.hour.startedAt.toISOString()).toBe(
      HOUR.startedAt.toISOString(),
    );
  });

  it("reports a nought for an hour a customer ran nothing in", async () => {
    expect((await owed())[0]).toMatchObject({
      webCallMinutes: 0,
      phoneMinutes: 0,
    });
  });

  it("counts the whole minutes a period gained, by kind", async () => {
    // 150 seconds of web call and 90 of phone in this hour: two whole minutes
    // and one whole minute, with 30 seconds of each left over.
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:05:00.000Z"),
      seconds: 150,
    });
    await conversation(acme, {
      connectionType: "phone_number",
      endedAt: new Date("2026-09-20T13:40:00.000Z"),
      seconds: 90,
    });

    expect((await owed())[0]).toMatchObject({
      webCallMinutes: 2,
      phoneMinutes: 1,
    });
  });

  it("carries the part-minute into the next hour rather than losing it", async () => {
    // 30 more seconds of web call next hour. With the 30 left over from the
    // hour before, that is one whole minute the next hour owes — a job that
    // truncated each hour on its own would have reported nothing for either.
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T14:10:00.000Z"),
      seconds: 30,
    });

    await markedThrough(acme, HOUR.startedAt);
    const hours = await owed(NEXT_HOUR);
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ webCallMinutes: 1, phoneMinutes: 0 });
  });

  it("bills an hour a wake missed rather than swallowing it", async () => {
    // The mark is back where it was before the busy hour, as it would be if
    // the job had been down or its post had failed. Both hours come back, in
    // order, and between them they carry every whole minute: the two the busy
    // hour gained and the one its leftovers made in the hour after.
    await markedThrough(acme, PREVIOUS_HOUR.startedAt);

    const hours = await owed(NEXT_HOUR);

    expect(hours.map((one) => one.hour.startedAt.toISOString())).toEqual([
      HOUR.startedAt.toISOString(),
      NEXT_HOUR.startedAt.toISOString(),
    ]);
    expect(hours[0]).toMatchObject({ webCallMinutes: 2, phoneMinutes: 1 });
    expect(hours[1]).toMatchObject({ webCallMinutes: 1, phoneMinutes: 0 });
    const webCall = hours.reduce((all, one) => all + one.webCallMinutes, 0);
    // 150 + 30 seconds of web call is three whole minutes, and all three are
    // billed across the two hours.
    expect(webCall).toBe(3);
  });

  it("asks for only the hour that has just closed when it has never reported", async () => {
    await markedThrough(acme, null);

    const hours = await owed(NEXT_HOUR);

    expect(hours).toHaveLength(1);
    expect(hours[0]?.hour.startedAt.toISOString()).toBe(
      NEXT_HOUR.startedAt.toISOString(),
    );
  });

  it("moves the mark forward and never back", async () => {
    await markedThrough(acme, HOUR.startedAt);
    await markOverageReported([
      { organizationId: acme.organizationId, reportedThrough: NEXT_HOUR.startedAt },
    ]);
    expect(await owed(NEXT_HOUR)).toEqual([]);

    // A late wake reporting an older hour cannot walk the mark backwards.
    await markOverageReported([
      { organizationId: acme.organizationId, reportedThrough: HOUR.startedAt },
    ]);
    expect(await owed(NEXT_HOUR)).toEqual([]);
  });

  it("says which hours Stripe will no longer take", async () => {
    // A mark from before Stripe's 35-day meter window: those hours cannot be
    // billed by anybody, and they are answered as such rather than retried for
    // ever.
    await markedThrough(acme, new Date("2026-07-01T00:00:00.000Z"));

    const hours = await owed(NEXT_HOUR);

    expect(hours.length).toBeGreaterThan(1);
    expect(hours[0]?.tooOldForStripe).toBe(true);
    // And it is bounded, so one wake is never a burst nobody could send.
    expect(hours.length).toBeLessThanOrEqual(MOST_HOURS_CAUGHT_UP_AT_ONCE);
  });

  it("counts a conversation in the hour it ended, not the one it began in", async () => {
    // Begun at 14:59:30 and ended at 15:00:30, so it belongs to the 15:00
    // hour: until it ends nobody knows how long it was.
    await conversation(acme, {
      connectionType: "phone_number",
      endedAt: new Date("2026-09-20T15:00:30.000Z"),
      seconds: 60,
    });

    await markedThrough(acme, HOUR.startedAt);
    expect((await owed(NEXT_HOUR))[0]).toMatchObject({ phoneMinutes: 0 });

    await markedThrough(acme, NEXT_HOUR.startedAt);
    const after = await overageOwedThrough(
      hourAround(new Date("2026-09-20T15:30:00.000Z")),
      new Date("2026-09-20T16:00:00.000Z"),
    );
    expect(after[0]).toMatchObject({ phoneMinutes: 1 });
  });

  it("stops reporting an organization whose subscription Stripe gave up on", async () => {
    await onPro(acme, "unpaid", CREATED_AT);
    expect(await owed(NEXT_HOUR)).toEqual([]);
    await onPro(acme, "active", new Date("2026-09-03T17:30:00.000Z"));
  });
});

describe("the amounts an admin may buy", () => {
  it("takes the four the picker offers", () => {
    for (const amount of [10, 25, 50, 100]) {
      expect(creditAmountRefusal(amount * 1_000_000)).toBeUndefined();
    }
  });

  it("refuses less than the smallest, naming it", () => {
    const refusal = creditAmountRefusal(SMALLEST_CREDIT_MICROS - 1);
    expect(refusal).toContain("$5");
  });

  it("refuses more than the largest, naming it", () => {
    const refusal = creditAmountRefusal(LARGEST_CREDIT_MICROS + 1);
    expect(refusal).toContain("$1,000");
  });

  it("refuses an amount that is not a whole micro-dollar", () => {
    expect(creditAmountRefusal(10_000_000.5)).toContain("whole number");
  });
});

describe("the units the two systems count in", () => {
  it("turns Stripe's cents into this product's micro-dollars, and back", () => {
    expect(microsFromCents(2_500)).toBe(25_000_000);
    expect(centsFromMicros(25_000_000)).toBe(2_500);
    expect(centsFromMicros(microsFromCents(4_237))).toBe(4_237);
  });

  it("takes an hour from its own top to the top of the next", () => {
    const hour = hourAround(new Date("2026-09-20T13:47:19.412Z"));
    expect(hour.startedAt.toISOString()).toBe("2026-09-20T13:00:00.000Z");
    expect(hour.endedAt.toISOString()).toBe("2026-09-20T14:00:00.000Z");
  });

  it("reports the hour that has closed, never the one still running", () => {
    const hour = previousHour(new Date("2026-09-20T13:00:04.000Z"));
    expect(hour.startedAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(hour.endedAt.toISOString()).toBe("2026-09-20T13:00:00.000Z");
  });
});
