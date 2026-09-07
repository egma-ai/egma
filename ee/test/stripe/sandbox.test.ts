import { randomUUID } from "node:crypto";

import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BILLING_WEBHOOK_PATH,
  METER_EVENT_NAMES,
  PRICE_LOOKUP_KEYS,
  billingRoutes,
  billingWebhookRoutes,
  cloudBillingPlugIn,
  isSandboxKey,
  meterEventIdentifier,
  openCreditCheckout,
  previousHour,
  reportOverageOwed,
  scheduleDowngrade,
  setUpStripe,
  stripeGateway,
  type StripeGateway,
  openBillingAccount,
} from "../../src/index.ts";
import { createApi, type TestApi } from "../../../apps/api/test/support/api.ts";
import {
  contextFor,
  signUp,
  type Customer,
} from "../../../apps/api/test/support/traces.ts";

/**
 * The Stripe lane: the real sandbox, real objects, and real events.
 *
 * **It is skipped whole when no key is present, and it is never replaced by a
 * fake.** That is the founders' rule of 2026-09-07: no in-memory Stripe exists
 * anywhere in this repository, so the alternative to running against Stripe is
 * running nothing. Everything Egma decides from Stripe's answers is proved
 * without Stripe, by seeding rows, in `ee/test/stripe-adapter.test.ts`; what is
 * proved here is the half that only Stripe can answer — that the objects Egma
 * asks for are objects Stripe makes, that the events Stripe sends are events
 * this handler reads, and that a month rolls, a plan lapses and a downgrade
 * lands where they are supposed to.
 *
 * **Nothing is ever created on a live account.** The lane refuses any key that
 * is not one Stripe issues for a sandbox, before it makes a single call.
 *
 * **Every object it makes carries `egma_test=1` and is taken away at the end.**
 * A test clock takes its customers and their subscriptions with it, which is
 * the whole reason the customers are made on one. Meters are never deleted:
 * Stripe's test-data deletion does not remove them either, which is exactly why
 * the setup finds them by event name instead of assuming.
 *
 * **One deliberate approximation, and it is the only one.** A Checkout Session
 * cannot be completed without a browser, so the purchased-credit handler is
 * driven from a real Stripe event — a real payment, a real event id, a real
 * amount and a real timestamp read back from `events.list` — shaped into the
 * `checkout.session.completed` envelope the handler reads. Every subscription
 * event below is Stripe's own, posted byte for byte.
 */

const SECRET_KEY = process.env["EGMA_STRIPE_SECRET_KEY"]?.trim() ?? "";
const RUNNING = SECRET_KEY !== "";

/**
 * The signing secret this lane signs its own posts with.
 *
 * The deployment's own where one is set, so a run against a configured
 * environment proves that secret too; otherwise a fixed one, because what is
 * under test is that a payload signed the way Stripe signs it is accepted, and
 * a signature is over the body rather than over which secret it came from.
 */
const WEBHOOK_SECRET =
  process.env["EGMA_STRIPE_WEBHOOK_SECRET"]?.trim() || "whsec_egma_stripe_lane";

/** What every object this lane creates is marked with, so it can be found. */
const TEST_METADATA = { egma_test: "1" } as const;

/** How long a test clock is given to finish advancing. */
const CLOCK_READY_TIMEOUT_MS = 120_000;
/** How long Stripe's meter aggregation is given to reach an invoice preview. */
const METER_TIMEOUT_MS = 120_000;

let api: TestApi;
let gateway: StripeGateway;
let stripe: Stripe;
/** Everything to take away at the end, newest first. */
const clocks: string[] = [];

async function rest(milliseconds: number): Promise<void> {
  await new Promise((wake) => setTimeout(wake, milliseconds));
}

/** Wait for a test clock to finish advancing, or say it did not. */
async function whenReady(clockId: string): Promise<Stripe.TestHelpers.TestClock> {
  const until = Date.now() + CLOCK_READY_TIMEOUT_MS;
  for (;;) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") {
      throw new Error(`test clock ${clockId} failed while advancing`);
    }
    if (Date.now() > until) {
      throw new Error(`test clock ${clockId} was still ${clock.status}`);
    }
    await rest(2_000);
  }
}

/**
 * Post one of Stripe's own events to Egma's webhook route, signed the way
 * Stripe signs it.
 *
 * The body is the event as Stripe serialises it and the header is made by
 * Stripe's own helper, so what the route verifies is the same computation a
 * real delivery goes through.
 */
async function deliver(event: unknown): Promise<{
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}> {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  const answer = await api.app.inject({
    method: "POST",
    url: BILLING_WEBHOOK_PATH,
    headers: { "content-type": "application/json", "stripe-signature": signature },
    payload,
  });
  return {
    statusCode: answer.statusCode,
    body: answer.json() as Record<string, unknown>,
  };
}

/** The newest event of these types about this object, waited for. */
async function eventAbout(
  types: readonly string[],
  objectId: string,
  timeoutMs = 60_000,
): Promise<Stripe.Event> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const listed = await stripe.events.list({ types: [...types], limit: 100 });
    for (const event of listed.data) {
      const object = event.data.object as { id?: string };
      if (object.id === objectId) return event;
    }
    if (Date.now() > until) {
      throw new Error(
        `Stripe produced no ${types.join(" or ")} for ${objectId} in time`,
      );
    }
    await rest(2_000);
  }
}

/** What the account row says, read raw. */
async function accountRow(organizationId: string): Promise<{
  plan_code: string;
  balance_micros: string;
  period_anchor: Date;
  stripe_subscription_status: string | null;
}> {
  const { rows } = await api.database.sql<{
    plan_code: string;
    balance_micros: string;
    period_anchor: Date;
    stripe_subscription_status: string | null;
  }>(
    `select plan_code, balance_micros, period_anchor, stripe_subscription_status
     from cloud_billing_account where organization_id = $1`,
    [organizationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("no billing account");
  return row;
}

/** When Egma created this organization: what a Hobby month is anchored on. */
async function organizationCreatedAt(organizationId: string): Promise<Date> {
  const { rows } = await api.database.sql<{ created_at: Date }>(
    "select created_at from organization where id = $1",
    [organizationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("no organization");
  return row.created_at;
}

/** A customer on its own test clock, holding a card that behaves as named. */
async function aCustomerOn(
  card: "pm_card_visa" | "pm_card_chargeCustomerFail",
  organizationId: string,
  frozenTime: number,
): Promise<{
  readonly customerId: string;
  readonly clockId: string;
  readonly paymentMethodId: string;
}> {
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: frozenTime,
    name: `egma lane ${organizationId.slice(-8)}`,
  });
  clocks.push(clock.id);

  const customer = await stripe.customers.create({
    test_clock: clock.id,
    // Stripe Tax needs somewhere to work a rate out from.
    address: { line1: "1 Test Way", city: "Denver", state: "CO", postal_code: "80202", country: "US" },
    metadata: { ...TEST_METADATA, egma_organization_id: organizationId },
  });
  // A shared test card such as `pm_card_visa` is a template, not a card: every
  // use of the name mints a fresh PaymentMethod, and attaching it returns the
  // one that now belongs to this customer. Everything after this must name
  // that one, never the template, or Stripe answers "no such PaymentMethod".
  const attached = await stripe.paymentMethods.attach(card, {
    customer: customer.id,
  });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attached.id },
  });
  // The account has to exist before a customer can be written on it: the
  // product opens it lazily, at the first billing read, and an update that
  // finds no row is a silent no-op. Opening it here is the same path the
  // product takes, welcome credit included.
  await openBillingAccount(organizationId);
  await api.database.sql(
    "update cloud_billing_account set stripe_customer_id = $2 where organization_id = $1",
    [organizationId, customer.id],
  );
  return {
    customerId: customer.id,
    clockId: clock.id,
    paymentMethodId: attached.id,
  };
}

/** The Pro plan as its own row states it: what it includes, and at what price. */
async function proPlanRow(): Promise<{
  readonly stripeFeePriceId: string;
  readonly stripeWebCallMeterPriceId: string;
  readonly stripePhoneMeterPriceId: string;
  readonly webCallMinutesAllowance: number;
  readonly webCallOverageMicrosPerMinute: number;
}> {
  const { rows } = await api.database.sql<{
    stripe_fee_price_id: string;
    stripe_web_call_meter_price_id: string;
    stripe_phone_meter_price_id: string;
    web_call_minutes_allowance: string;
    web_call_overage_micros_per_minute: string;
  }>(
    `select stripe_fee_price_id, stripe_web_call_meter_price_id,
            stripe_phone_meter_price_id, web_call_minutes_allowance,
            web_call_overage_micros_per_minute
     from cloud_plan where code = 'pro'`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("no Pro plan row");
  return {
    stripeFeePriceId: row.stripe_fee_price_id,
    stripeWebCallMeterPriceId: row.stripe_web_call_meter_price_id,
    stripePhoneMeterPriceId: row.stripe_phone_meter_price_id,
    webCallMinutesAllowance: Number(row.web_call_minutes_allowance),
    webCallOverageMicrosPerMinute: Number(
      row.web_call_overage_micros_per_minute,
    ),
  };
}

/** The three Stripe prices Pro is sold at. */
async function proPrices(): Promise<{
  fee: string;
  webCall: string;
  phone: string;
}> {
  const plan = await proPlanRow();
  return {
    fee: plan.stripeFeePriceId,
    webCall: plan.stripeWebCallMeterPriceId,
    phone: plan.stripePhoneMeterPriceId,
  };
}

/** Which price an invoice line is for, whichever shape it came back in. */
function priceIdOf(line: Stripe.InvoiceLineItem): string | undefined {
  const price = line.pricing?.price_details?.price;
  if (price === undefined) return undefined;
  return typeof price === "string" ? price : price.id;
}

/** Seconds and days, as Stripe counts them. */
const A_DAY = 24 * 60 * 60;

/**
 * Where every clock in this lane starts: two hours ago.
 *
 * **Relative to now rather than a fixed date, deliberately.** A meter event may
 * not be timestamped more than 35 days back, and the preview below posts one at
 * the clock's own frozen time — so a lane anchored to a date in the file would
 * quietly stop being able to bill anything about a month after it was written.
 */
const LANE_START = Math.floor((Date.now() - 2 * 3_600_000) / 1_000);

/** The lane's clock, this many days on. */
function daysOn(days: number): number {
  return LANE_START + days * A_DAY;
}

let paying: Customer;
let lapsing: Customer;
let payingCustomerId: string;
let payingClockId: string;
let payingPaymentMethodId: string;
let subscriptionId: string;

describe.skipIf(!RUNNING).sequential("the Stripe sandbox, for real", () => {
  beforeAll(async () => {
    if (!isSandboxKey(SECRET_KEY)) {
      throw new Error(
        "EGMA_STRIPE_SECRET_KEY is not a Stripe test key. This lane creates " +
          "customers, subscriptions and payments, and it will not do that on " +
          "a live account.",
      );
    }
    gateway = stripeGateway({
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: "https://egma.test",
    });
    stripe = gateway.api;

    api = await createApi("ee-stripe-lane", {
      billing: cloudBillingPlugIn(),
      installBilling: true,
      billingRoutes: (app, options) =>
        billingRoutes(app, { ...options, stripe: gateway }),
      billingWebhookRoutes: (app) =>
        billingWebhookRoutes(app, { stripe: gateway }),
    });

    paying = await signUp(api.app, `pro-${randomUUID()}@example.test`, "Acme");
    lapsing = await signUp(api.app, `laps-${randomUUID()}@example.test`, "Globex");
  }, 180_000);

  afterAll(async () => {
    // A test clock takes its customers and their subscriptions with it, which
    // is why every customer here is made on one. Meters, the product and the
    // prices stay: they are the account's setup and are found again next run.
    for (const clockId of clocks) {
      await stripe.testHelpers.testClocks.del(clockId).catch(() => undefined);
    }
    await api?.close();
  }, 120_000);

  it("sets the account up, and the second run creates nothing", async () => {
    const first = await setUpStripe(gateway, { say: () => {} });
    expect(first.productId).toMatch(/^prod_/);
    expect(first.webCallMeterId).toMatch(/^mtr_/);
    expect(first.phoneMeterId).toMatch(/^mtr_/);

    const again = await setUpStripe(gateway, { say: () => {} });
    expect(again.created).toEqual([]);
    expect(again.productId).toBe(first.productId);
    expect(again.feePriceId).toBe(first.feePriceId);
    expect(again.webCallMeterPriceId).toBe(first.webCallMeterPriceId);
  }, 120_000);

  it("prices the allowance at nothing and everything past it at the overage", async () => {
    const found = await stripe.prices.list({
      lookup_keys: [PRICE_LOOKUP_KEYS.web_call_minutes],
      active: true,
      expand: ["data.tiers"],
      limit: 1,
    });
    const price = found.data[0];
    expect(price?.billing_scheme).toBe("tiered");
    expect(price?.tiers_mode).toBe("graduated");
    expect(price?.recurring?.usage_type).toBe("metered");
    const tiers = price?.tiers ?? [];
    expect(tiers).toHaveLength(2);
    // The included allowance, at nothing.
    expect(tiers[0]?.up_to).toBe(5_000);
    expect(Number(String(tiers[0]?.unit_amount_decimal ?? 0))).toBe(0);
    // Everything past it, at the plan row's own price.
    expect(tiers[1]?.up_to).toBeNull();
    expect(Number(String(tiers[1]?.unit_amount_decimal))).toBeGreaterThan(0);
  }, 60_000);

  it("opens a real Checkout Session to buy credit, with tax on", async () => {
    const made = await aCustomerOn("pm_card_visa", paying.organizationId, LANE_START);
    payingCustomerId = made.customerId;
    payingClockId = made.clockId;
    payingPaymentMethodId = made.paymentMethodId;

    const page = await openCreditCheckout(
      gateway,
      contextFor(paying, "admin"),
      25_000_000,
    );
    expect(page.url).toContain("https://");

    // Read the session back from Stripe rather than trusting what was sent.
    const sessions = await stripe.checkout.sessions.list({
      customer: payingCustomerId,
      limit: 1,
    });
    const session = sessions.data[0];
    expect(session?.mode).toBe("payment");
    expect(session?.automatic_tax.enabled).toBe(true);
    expect(session?.client_reference_id).toBe(paying.organizationId);
    expect(session?.amount_subtotal).toBe(2_500);
  }, 120_000);

  it("credits the balance from a real payment's own event", async () => {
    // A Checkout Session cannot be completed without a browser, so the payment
    // is a real PaymentIntent on the same customer and the same card. What the
    // handler is driven with below is that payment's own Stripe event — its
    // id, its customer, its amount and its instant — in the envelope the
    // handler reads. It is the one shaped payload in this lane and it is
    // shaped from a real one.
    const intent = await stripe.paymentIntents.create({
      customer: payingCustomerId,
      amount: 2_500,
      currency: "usd",
      payment_method: payingPaymentMethodId,
      off_session: true,
      confirm: true,
      metadata: { ...TEST_METADATA, egma_organization_id: paying.organizationId },
    });
    expect(intent.status).toBe("succeeded");

    const real = await eventAbout(["payment_intent.succeeded"], intent.id);
    const delivered = await deliver({
      ...real,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_from_${intent.id}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: payingCustomerId,
          client_reference_id: paying.organizationId,
          amount_subtotal: intent.amount,
          amount_total: intent.amount,
        },
      },
    });

    expect(delivered.statusCode).toBe(200);
    expect(delivered.body).toMatchObject({ applied: true, effect: "credited" });
    const account = await accountRow(paying.organizationId);
    // The $5 welcome credit, and $25 more.
    expect(Number(account.balance_micros)).toBe(30_000_000);

    // The same delivery again changes nothing, which is the whole point of the
    // processed-event table.
    const again = await deliver(real);
    expect(again.body).toMatchObject({ applied: false, effect: "redelivered" });
    expect(Number((await accountRow(paying.organizationId)).balance_micros)).toBe(
      30_000_000,
    );
  }, 180_000);

  it("moves to Pro, and Stripe's own event sets the plan and the month", async () => {
    const prices = await proPrices();
    const subscription = await stripe.subscriptions.create({
      customer: payingCustomerId,
      items: [
        { price: prices.fee, quantity: 1 },
        { price: prices.webCall },
        { price: prices.phone },
      ],
      automatic_tax: { enabled: true },
      default_payment_method: payingPaymentMethodId,
      metadata: { ...TEST_METADATA, egma_organization_id: paying.organizationId },
    });
    subscriptionId = subscription.id;
    expect(subscription.status).toBe("active");

    const real = await eventAbout(["customer.subscription.created"], subscription.id);
    const delivered = await deliver(real);

    expect(delivered.statusCode).toBe(200);
    expect(delivered.body).toMatchObject({ applied: true, effect: "plan_changed" });
    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("pro");
    expect(account.stripe_subscription_status).toBe("active");
    // Stripe's own period start, to the second.
    const item = subscription.items.data[0];
    expect(Math.floor(account.period_anchor.getTime() / 1_000)).toBe(
      item?.current_period_start,
    );
  }, 180_000);

  it("reports an hour of minutes Stripe accepts, and refuses the same hour twice", async () => {
    // The sweep itself, against a real account: this organization ran nothing,
    // so it reports a nought for each meter — which is exactly what proves the
    // customer mapping and the event names are the ones Stripe knows.
    //
    // The hour is the one that closed before the lane's clock, not before the
    // wall clock. A customer on a test clock lives at the clock's frozen time,
    // and Stripe refuses a meter event timestamped after it: "The event
    // timestamp cannot be in future". The lane's clock started two hours ago,
    // so the wall clock's previous hour is that customer's future. A real
    // customer has no clock, so the job's own previousHour(now) is right there.
    const hour = previousHour(new Date(LANE_START * 1_000));
    const report = await reportOverageOwed(gateway, hour);
    expect(report).toMatchObject({
      organizations: 1,
      hours: 1,
      posted: 2,
      alreadyReported: 0,
      failed: 0,
      tooOld: 0,
    });

    // The mark moved, so the same wake again has nothing left to report.
    const settled = await reportOverageOwed(gateway, hour);
    expect(settled.hours).toBe(0);

    // And with the mark put back, the same hour is offered again and Stripe
    // refuses each identifier — which the job counts rather than fails on.
    await api.database.sql(
      "update cloud_billing_account set overage_reported_through = $2 where organization_id = $1",
      [paying.organizationId, new Date(hour.startedAt.getTime() - 3_600_000)],
    );
    const replay = await reportOverageOwed(gateway, hour);
    expect(replay).toMatchObject({ alreadyReported: 2, posted: 0, failed: 0 });
  }, 180_000);

  it("prices overage past the allowance at the plan row's own price", async () => {
    const plan = await proPlanRow();
    // 400 minutes past Pro's included web-call minutes. Posted directly
    // because this is about what Stripe does with a number, not about how Egma
    // counts one — and timestamped at the clock's own frozen time, because
    // that is the instant this customer's subscription is living at.
    const overageMinutes = 400;
    await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAMES.web_call_minutes,
      identifier: meterEventIdentifier(
        METER_EVENT_NAMES.web_call_minutes,
        `${paying.organizationId}-overage`,
        new Date(LANE_START * 1_000),
      ),
      timestamp: LANE_START,
      payload: {
        stripe_customer_id: payingCustomerId,
        value: String(plan.webCallMinutesAllowance + overageMinutes),
      },
    });

    // What the plan row says those minutes cost, in the cents Stripe counts in.
    const expectedCents = Math.round(
      (overageMinutes * plan.webCallOverageMicrosPerMinute) / 10_000,
    );

    // Meter aggregation is eventually consistent by Stripe's own
    // documentation, so the preview is polled — and a poll that runs out is a
    // failure, not a pass.
    const until = Date.now() + METER_TIMEOUT_MS;
    let line: Stripe.InvoiceLineItem | undefined;
    for (;;) {
      const preview = await stripe.invoices.createPreview({
        customer: payingCustomerId,
        subscription: subscriptionId,
      });
      line = preview.lines.data.find(
        (one) =>
          priceIdOf(one) === plan.stripeWebCallMeterPriceId && one.amount > 0,
      );
      if (line !== undefined) break;
      if (Date.now() > until) break;
      await rest(5_000);
    }

    expect(
      line,
      `Stripe's preview carried no priced ${METER_EVENT_NAMES.web_call_minutes} ` +
        `line within ${METER_TIMEOUT_MS / 1_000}s`,
    ).toBeDefined();
    // The allowance is the first tier at nothing and the rest is the second
    // tier at the plan row's price, so the line is exactly the overage.
    expect(line?.amount).toBe(expectedCents);
  }, 240_000);

  it("rolls a period on the test clock and stays Pro", async () => {
    await stripe.testHelpers.testClocks.advance(payingClockId, {
      frozen_time: daysOn(32),
    });
    await whenReady(payingClockId);

    const rolled = await stripe.subscriptions.retrieve(subscriptionId);
    const real = await eventAbout(["customer.subscription.updated"], subscriptionId);
    await deliver(real);

    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("pro");
    expect(["active", "past_due"]).toContain(rolled.status);
  }, 300_000);

  it("stops at period end rather than now, and lands on Hobby when it does", async () => {
    const stopping = await scheduleDowngrade(gateway, contextFor(paying, "admin"));
    expect(stopping.endsAt).not.toBeNull();

    // Still Pro: the customer paid for the month they are in.
    expect((await accountRow(paying.organizationId)).plan_code).toBe("pro");

    await stripe.testHelpers.testClocks.advance(payingClockId, {
      frozen_time: daysOn(66),
    });
    await whenReady(payingClockId);

    const real = await eventAbout(["customer.subscription.deleted"], subscriptionId);
    const delivered = await deliver(real);
    expect(delivered.body).toMatchObject({ applied: true, effect: "plan_changed" });

    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("hobby");
    expect(account.period_anchor.toISOString()).toBe(
      (await organizationCreatedAt(paying.organizationId)).toISOString(),
    );
  }, 300_000);

  it("keeps Pro through Stripe's retries, then returns to Hobby", async () => {
    const made = await aCustomerOn(
      "pm_card_chargeCustomerFail",
      lapsing.organizationId,
      LANE_START,
    );
    const prices = await proPrices();
    // The first invoice is paid by a trial that ends at the first renewal, so
    // the subscription starts active and the failure lands on the renewal —
    // which is the lapse this is about.
    const subscription = await stripe.subscriptions.create({
      customer: made.customerId,
      items: [
        { price: prices.fee, quantity: 1 },
        { price: prices.webCall },
        { price: prices.phone },
      ],
      trial_end: daysOn(30),
      automatic_tax: { enabled: true },
      metadata: { ...TEST_METADATA, egma_organization_id: lapsing.organizationId },
    });
    await deliver(
      await eventAbout(["customer.subscription.created"], subscription.id),
    );
    expect((await accountRow(lapsing.organizationId)).plan_code).toBe("pro");

    await stripe.testHelpers.testClocks.advance(made.clockId, {
      frozen_time: daysOn(30) + 3_600,
    });
    await whenReady(made.clockId);

    // Stripe's own retries are on: the renewal failed, the subscription is
    // past_due, and Egma keeps the organization on Pro while they run.
    const lapsed = await eventAbout(
      ["customer.subscription.updated"],
      subscription.id,
    );
    await deliver(lapsed);
    const during = await accountRow(lapsing.organizationId);
    expect(during.plan_code).toBe("pro");
    expect(during.stripe_subscription_status).toBe("past_due");

    // **And then the end of the retries, driven rather than waited for.** How
    // long Stripe duns and whether it finishes by cancelling or by marking the
    // subscription unpaid are settings on the Stripe account, not something a
    // clock advance settles the same way twice. So the outcome those settings
    // arrive at is applied directly, and what is under test stays what it
    // always was: that Egma puts the organization back on Hobby, with its own
    // creation date as the month's anchor again.
    const ended = await stripe.subscriptions.cancel(subscription.id);
    expect(ended.status).toBe("canceled");
    const gone = await eventAbout(
      ["customer.subscription.deleted"],
      subscription.id,
    );
    const delivered = await deliver(gone);
    expect(delivered.body).toMatchObject({ applied: true, effect: "plan_changed" });

    const after = await accountRow(lapsing.organizationId);
    expect(after.plan_code).toBe("hobby");
    expect(after.stripe_subscription_status).toBe("canceled");
    expect(after.period_anchor.toISOString()).toBe(
      (await organizationCreatedAt(lapsing.organizationId)).toISOString(),
    );
  }, 300_000);
});
