import { randomUUID } from "node:crypto";

import Stripe from "stripe";
import { newId } from "@egma/ids";
import {
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  startRun,
} from "@egma/db";
import {
  visitMeterAccounts,
  type MeterAccount,
} from "../../src/access/meter.ts";
import { recoverLateUsage } from "../../src/stripe/late-invoice.ts";
import {
  currentSubscription,
  stripeMeterPeriods,
} from "../../src/stripe/periods.ts";
import { hourAround } from "../../src/stripe/facts.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BILLING_WEBHOOK_PATH,
  METER_EVENT_NAMES,
  PRICE_LOOKUP_KEYS,
  billingRoutes,
  billingWebhookRoutes,
  cloudBillingPlugIn,
  isSandboxKey,
  openCreditCheckout,
  openUpgradeCheckout,
  scheduleDowngrade,
  setUpStripe,
  stripeGateway,
  type StripeGateway,
  openBillingAccount,
  seedCloudPlans,
  activateBilling,
} from "../../src/index.ts";
import { refreshStripePaymentsReady } from "../../src/stripe/gateway.ts";
import { createApi, type TestApi } from "../../../apps/api/test/support/api.ts";
import {
  contextFor,
  signUp,
  type Customer,
} from "../../../apps/api/test/support/traces.ts";

/** Real sandbox objects and unmodified Stripe events; no replacement client. */
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
async function whenReady(
  clockId: string,
): Promise<Stripe.TestHelpers.TestClock> {
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
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
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

/** The initial signup instant, used to distinguish a later downgrade boundary. */
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
    address: {
      line1: "1 Test Way",
      city: "Denver",
      state: "CO",
      postal_code: "80202",
      country: "US",
    },
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
let creditSessionId: string;
let creditCheckoutUrl: string;

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

async function seedRun(who: Customer): Promise<SeededRun> {
  const held = runs.get(who.organizationId);
  if (held !== undefined) return held;

  const auth = contextFor(who, "admin");
  const label = newId("run").slice(-8).toLowerCase();
  const agent = await createAgent(auth, {
    agentPlatform: "livekit",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: { url: "wss://test.livekit.cloud", agentName: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}`, apiSecret: "livekit-secret-A1B2C3D4WXYZ" },
    },
  });
  const chatConnectionId = agent.connection?.id ?? "";

  const voiceConnectionId = newId("con");
  await api.database.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, $5, 'livekit_room',
             'livekit_room.project_credentials', 'voice', 'hosted-broker',
             '{}'::jsonb)`,
    [
      voiceConnectionId,
      who.organizationId,
      who.projectId,
      agent.id,
      `lk-${label}`,
    ],
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
  const { rows } = await api.database.sql<{
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
  who: Customer,
  lane: {
    readonly connectionType: "livekit_room" | "phone_number";
    readonly endedAt: Date;
    readonly seconds: number;
  },
): Promise<void> {
  const run = await seedRun(who);
  position += 1;
  await api.database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at, execution_ended_at, persona_parameter_values)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'voice', $12,
             'completed', 'persona_concluded',
             $13::timestamptz - make_interval(secs => $14::double precision),
             $13::timestamptz, $13::timestamptz,
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

/** Drop a real successful HTTP response; Stripe still performs the write. */
function loseResponse(pathMatches: (path: string) => boolean): StripeGateway {
  const transport = Stripe.createNodeHttpClient();
  let dropped = false;
  const httpClient = {
    getClientName: () => "egma-real-response-loss",
    async makeRequest(...args: Parameters<typeof transport.makeRequest>) {
      const response = await transport.makeRequest(...args);
      if (
        !dropped &&
        args[3] === "POST" &&
        pathMatches(args[2]) &&
        response.getStatusCode() < 300
      ) {
        dropped = true;
        await response.toJSON();
        throw new Error("deliberately lost a real Stripe response");
      }
      return response;
    },
  };
  return {
    ...gateway,
    api: new Stripe(SECRET_KEY, {
      httpClient,
      maxNetworkRetries: 0,
      timeout: 10000,
    }),
  };
}

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
    const expectedAccount = process.env["EGMA_STRIPE_TEST_ACCOUNT"]?.trim();
    if (!expectedAccount)
      throw new Error(
        "Name EGMA_STRIPE_TEST_ACCOUNT before running sandbox writes",
      );
    expect((await stripe.accounts.retrieveCurrent()).id).toBe(expectedAccount);

    api = await createApi("ee-stripe-lane", {
      billing: cloudBillingPlugIn(),
      installBilling: true,
      billingRoutes: (app, options) =>
        billingRoutes(app, { ...options, stripe: gateway }),
      billingWebhookRoutes: (app) =>
        billingWebhookRoutes(app, { stripe: gateway }),
    });

    await seedCloudPlans();
    await activateBilling(new Date(LANE_START * 1000));
    await refreshStripePaymentsReady(gateway);

    paying = await signUp(api.app, `pro-${randomUUID()}@example.test`, "Acme");
    lapsing = await signUp(
      api.app,
      `laps-${randomUUID()}@example.test`,
      "Globex",
    );
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
    const made = await aCustomerOn(
      "pm_card_visa",
      paying.organizationId,
      LANE_START,
    );
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
    if (session === undefined) throw new Error("Checkout Session is missing");
    creditSessionId = session.id;
    creditCheckoutUrl = page.url;
  }, 120_000);

  it("credits only a completed real Checkout Session and deduplicates its actual event", async () => {
    process.stdout.write(
      `\nComplete this sandbox Checkout in the browser: ${creditCheckoutUrl}\n`,
    );
    const deadline = Date.now() + 600000;
    for (;;) {
      const session = await stripe.checkout.sessions.retrieve(creditSessionId);
      if (session.status === "complete" && session.payment_status === "paid")
        break;
      if (Date.now() >= deadline)
        throw new Error(
          "Real Checkout was not completed in the browser; no payment event was fabricated",
        );
      await rest(2000);
    }
    const real = await eventAbout(
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ],
      creditSessionId,
    );
    const delivered = await deliver(real);
    expect(delivered.statusCode).toBe(200);
    expect(delivered.body).toMatchObject({ applied: true, effect: "credited" });
    expect(
      Number((await accountRow(paying.organizationId)).balance_micros),
    ).toBe(30000000);
    const again = await deliver(real);
    expect(again.body).toMatchObject({
      applied: false,
      effect: "credit_already_written",
    });
    expect(
      Number((await accountRow(paying.organizationId)).balance_micros),
    ).toBe(30000000);
  }, 660000);

  it("opens the real product Upgrade Checkout with all three prices", async () => {
    const page = await openUpgradeCheckout(
      gateway,
      contextFor(paying, "admin"),
    );
    expect(page.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const sessions = await stripe.checkout.sessions.list({
      customer: payingCustomerId,
      status: "open",
      limit: 100,
    });
    const session = sessions.data.find((one) => one.mode === "subscription");
    if (session === undefined)
      throw new Error("Upgrade did not create a real subscription Checkout");
    const lines = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 100,
    });
    const prices = await proPrices();
    expect(lines.data.map((line) => line.price?.id).sort()).toEqual(
      [prices.fee, prices.webCall, prices.phone].sort(),
    );
    await stripe.checkout.sessions.expire(session.id);
  }, 120_000);

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
      metadata: {
        ...TEST_METADATA,
        egma_plan: "pro",
        egma_organization_id: paying.organizationId,
      },
    });
    subscriptionId = subscription.id;
    expect(subscription.status).toBe("active");

    const real = await eventAbout(
      ["customer.subscription.created"],
      subscription.id,
    );
    const delivered = await deliver(real);

    expect(delivered.statusCode).toBe(200);
    expect(delivered.body).toMatchObject({
      applied: true,
      effect: "plan_changed",
    });
    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("pro");
    expect(account.stripe_subscription_status).toBe("active");
    // Stripe's own period start, to the second.
    const item = subscription.items.data[0];
    expect(Math.floor(account.period_anchor.getTime() / 1_000)).toBe(
      item?.current_period_start,
    );
  }, 180_000);

  it("prices overage past the allowance at the plan row's own price", async () => {
    const plan = await proPlanRow();
    // 400 minutes past Pro's included web-call minutes. Posted directly
    // because this is about what Stripe does with a number, not about how Egma
    // counts one — and timestamped at the clock's own frozen time, because
    // that is the instant this customer's subscription is living at.
    const overageMinutes = 400.5;
    await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAMES.web_call_minutes,
      identifier: randomUUID(),
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
    let lines: Stripe.InvoiceLineItem[] = [];
    for (;;) {
      const preview = await stripe.invoices.createPreview({
        customer: payingCustomerId,
        subscription: subscriptionId,
      });
      lines = preview.lines.data.filter(
        (one) => priceIdOf(one) === plan.stripeWebCallMeterPriceId,
      );
      if (lines.some((one) => one.subtotal > 0) || Date.now() > until) break;
      await rest(5000);
    }
    expect(lines.reduce((total, line) => total + line.subtotal, 0)).toBe(
      expectedCents,
    );
    expect(
      lines.reduce((total, line) => total + Number(line.quantity_decimal), 0),
    ).toBe(plan.webCallMinutesAllowance + overageMinutes);

    const fractionalId = randomUUID();
    await stripe.billing.meterEvents.create(
      {
        event_name: METER_EVENT_NAMES.phone_minutes,
        identifier: fractionalId,
        timestamp: LANE_START,
        payload: {
          stripe_customer_id: payingCustomerId,
          value: "0.166666666667",
        },
      },
      { idempotencyKey: fractionalId },
    );
    const untilPhone = Date.now() + METER_TIMEOUT_MS;
    let phoneQuantity = 0;
    while (Date.now() < untilPhone) {
      const preview = await stripe.invoices.createPreview({
        customer: payingCustomerId,
        subscription: subscriptionId,
      });
      const phone = preview.lines.data.find(
        (one) => priceIdOf(one) === plan.stripePhoneMeterPriceId,
      );
      phoneQuantity = Number(String(phone?.quantity_decimal ?? "0"));
      if (phoneQuantity === 0.166666666667) break;
      await rest(2000);
    }
    expect(phoneQuantity).toBe(0.166666666667);
  }, 240_000);

  it("rolls a period on the test clock and stays Pro", async () => {
    await stripe.testHelpers.testClocks.advance(payingClockId, {
      frozen_time: daysOn(32),
    });
    await whenReady(payingClockId);

    const rolled = await stripe.subscriptions.retrieve(subscriptionId);
    const real = await eventAbout(
      ["customer.subscription.updated"],
      subscriptionId,
    );
    await deliver(real);

    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("pro");
    expect(["active", "past_due"]).toContain(rolled.status);
  }, 300_000);

  it("recovers late invoices after real create, item and finalize responses are lost", async () => {
    const at = new Date(daysOn(32) * 1000);
    const hour = hourAround(new Date(at.getTime() - 3600000));
    let account: MeterAccount | undefined;
    await visitMeterAccounts(
      async (current) => {
        if (current.organizationId === paying.organizationId) account = current;
      },
      (_, fault) => {
        throw fault;
      },
    );
    if (account === undefined) throw new Error("missing paying meter account");
    const periods = await stripeMeterPeriods(gateway, account, at);
    const period = periods.find(
      (one) =>
        one.channel === "web_call_minutes" &&
        one.invoiceId !== null &&
        !one.acceptingUsage,
    );
    if (period === undefined)
      throw new Error("missing finalized original web period");
    const original = await stripe.invoices.retrieve(period.invoiceId!);
    expect(original.status).not.toBe("draft");
    const originalLines = await stripe.invoices.listLineItems(original.id, {
      limit: 100,
    });
    const originalWeb = originalLines.data.filter(
      (line) => priceIdOf(line) === period.priceId,
    );
    expect(
      originalWeb.reduce(
        (total, line) => total + Number(line.quantity_decimal),
        0,
      ),
    ).toBe(5400.5);
    expect(originalWeb.reduce((total, line) => total + line.subtotal, 0)).toBe(
      401,
    );
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: payingPaymentMethodId,
    });
    await stripe.customers.update(payingCustomerId, {
      invoice_settings: { default_payment_method: "" },
    });
    const customerWithNoDefault =
      await stripe.customers.retrieve(payingCustomerId);
    if (customerWithNoDefault.deleted)
      throw new Error("paying customer disappeared");
    expect(
      customerWithNoDefault.invoice_settings.default_payment_method,
    ).toBeNull();
    const start = new Date(period.periodStartedAt.getTime() + 3 * 3600000);
    await conversation(paying, {
      connectionType: "livekit_room",
      seconds: 5500.5 * 60,
      endedAt: new Date(start.getTime() + 5500.5 * 60000),
    });
    const runRecovery = async (using: StripeGateway, when: Date) => {
      let posted = false;
      await visitMeterAccounts(
        async (current, progress) => {
          if (current.organizationId !== paying.organizationId) return;
          await progress.next(period, hour, when);
          posted = await recoverLateUsage(
            using,
            current,
            progress,
            period,
            hour,
            when,
          );
        },
        (_, fault) => {
          throw fault;
        },
      );
      return posted;
    };
    await expect(
      runRecovery(
        loseResponse((path) => path === "/v1/invoices"),
        at,
      ),
    ).rejects.toThrow();
    await expect(
      runRecovery(
        loseResponse((path) => path === "/v1/invoiceitems"),
        new Date(at.getTime() + 2 * 86400000),
      ),
    ).rejects.toThrow();
    await expect(
      runRecovery(
        loseResponse((path) => path.endsWith("/finalize")),
        new Date(at.getTime() + 4 * 86400000),
      ),
    ).rejects.toThrow();
    expect(
      await runRecovery(gateway, new Date(at.getTime() + 6 * 86400000)),
    ).toBe(true);
    expect(
      await runRecovery(gateway, new Date(at.getTime() + 7 * 86400000)),
    ).toBe(false);
    const later: Stripe.Invoice[] = [];
    for await (const invoice of stripe.invoices.list({
      customer: payingCustomerId,
      limit: 100,
    })) {
      if (invoice.metadata?.egma_original_invoice === original.id)
        later.push(invoice);
    }
    expect(later).toHaveLength(1);
    expect(later[0]?.subtotal).toBe(100);
    expect(later[0]?.default_payment_method).toBe(payingPaymentMethodId);
    expect(later[0]?.automatic_tax.enabled).toBe(true);
    const lines = await stripe.invoices.listLineItems(later[0]!.id);
    expect(lines.data).toHaveLength(1);
    expect(lines.data[0]?.period).toEqual({
      start: period.periodStartedAt.getTime() / 1000,
      end: period.periodEndsAt.getTime() / 1000,
    });
    await stripe.testHelpers.testClocks.advance(payingClockId, {
      frozen_time: daysOn(32) + 7200,
    });
    await whenReady(payingClockId);
    const collected = await stripe.invoices.retrieve(later[0]!.id);
    expect(collected.status).toBe("paid");
    expect(collected.amount_paid).toBeGreaterThanOrEqual(100);
    console.info("Late invoice proof", {
      id: collected.id,
      status: collected.status,
      subtotal: collected.subtotal,
      amountPaid: collected.amount_paid,
    });
  }, 240_000);

  it("stops at period end rather than now, and lands on Hobby when it does", async () => {
    const stopping = await scheduleDowngrade(
      gateway,
      contextFor(paying, "admin"),
    );
    expect(stopping.endsAt).not.toBeNull();

    // Still Pro: the customer paid for the month they are in.
    expect((await accountRow(paying.organizationId)).plan_code).toBe("pro");

    await stripe.testHelpers.testClocks.advance(payingClockId, {
      frozen_time: daysOn(66),
    });
    await whenReady(payingClockId);

    const real = await eventAbout(
      ["customer.subscription.deleted"],
      subscriptionId,
    );
    const delivered = await deliver(real);
    expect(delivered.body).toMatchObject({
      applied: true,
      effect: "plan_changed",
    });

    const account = await accountRow(paying.organizationId);
    expect(account.plan_code).toBe("hobby");
    const canceled = await stripe.subscriptions.retrieve(subscriptionId);
    expect(account.period_anchor.getTime()).toBe(
      (canceled.ended_at ?? 0) * 1000,
    );
    const declining = await stripe.paymentMethods.attach(
      "pm_card_chargeCustomerFail",
      { customer: payingCustomerId },
    );
    const retrySignup = await stripe.subscriptions.create({
      customer: payingCustomerId,
      default_payment_method: declining.id,
      payment_behavior: "default_incomplete",
      items: [{ price: (await proPrices()).fee }],
      metadata: { ...TEST_METADATA, egma_plan: "pro" },
    });
    expect(retrySignup.status).toBe("incomplete");
    const refreshed = await currentSubscription(
      gateway,
      payingCustomerId,
      true,
      subscriptionId,
    );
    expect(refreshed.subscriptionId).toBe(retrySignup.id);
    expect(refreshed.hobbyStartedAt?.getTime()).toBe(
      (canceled.ended_at ?? 0) * 1000,
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
      metadata: {
        ...TEST_METADATA,
        egma_plan: "pro",
        egma_organization_id: lapsing.organizationId,
      },
    });
    await deliver(
      await eventAbout(["customer.subscription.created"], subscription.id),
    );
    expect((await accountRow(lapsing.organizationId)).plan_code).toBe("pro");

    await stripe.testHelpers.testClocks.advance(made.clockId, {
      frozen_time: daysOn(32),
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

    await stripe.testHelpers.testClocks.advance(made.clockId, {
      frozen_time: daysOn(70),
    });
    await whenReady(made.clockId);
    const terminal = await stripe.subscriptions.retrieve(subscription.id);
    expect(["unpaid", "canceled"]).toContain(terminal.status);
    const gone = await eventAbout(
      ["customer.subscription.updated", "customer.subscription.deleted"],
      subscription.id,
    );
    const delivered = await deliver(gone);
    expect(delivered.body).toMatchObject({
      applied: true,
      effect: "plan_changed",
    });

    const after = await accountRow(lapsing.organizationId);
    expect(after.plan_code).toBe("hobby");
    expect(after.stripe_subscription_status).toBe(terminal.status);
    expect(after.period_anchor.getTime()).toBeGreaterThan(
      (await organizationCreatedAt(lapsing.organizationId)).getTime(),
    );
    if (terminal.ended_at !== null)
      expect(after.period_anchor.getTime()).toBe(terminal.ended_at * 1000);
  }, 300_000);
});
