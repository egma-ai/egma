import { randomUUID } from "node:crypto";

import { listProjects, type AuthContext } from "@egma/db";
import type Stripe from "stripe";

import {
  accountForBillingAction,
  resolveStripeCustomer,
  recordStripeOperationFailure,
  type BillingActor,
} from "../access/index.ts";
import { stripeAttemptKey, stripeCustomerKey } from "../idempotency.ts";
import { centsFromMicros, isPaying } from "./facts.ts";
import { isEgmaStripeFailure, type StripeGateway } from "./gateway.ts";
import { stripeCustomerIds } from "./periods.ts";

/**
 * The four things an organization admin does with Stripe: buy credit, move to
 * Pro, stop at the end of the period, and manage the card and the invoices.
 *
 * **Every one of them opens a Stripe-hosted page and nothing else.** Egma
 * never sees a card number, never holds one, and never asks for one — Checkout
 * and the Customer Portal are where the money is entered, which is what keeps
 * this deployment out of the part of the problem that has a compliance regime
 * attached to it.
 *
 * **Nothing here changes a plan.** Pressing Upgrade opens a Checkout page; the
 * plan moves when Stripe says the subscription exists, through the webhook. A
 * button that set the plan itself would be a plan that could be on while the
 * payment failed, and a customer's plan and their invoice would disagree with
 * nobody to arbitrate. The one write these make to Egma's own rows is the
 * Stripe customer id, which is a name and not a state.
 *
 * **Every write to Stripe carries an idempotency key.** A customer's key is
 * the organization, forever, because two admins pressing a button together
 * must not end up with two customers. A session's key is per attempt, because
 * an admin who abandoned a Checkout page must get a new one when they press
 * the button again.
 */

/** The amounts of inference credit the Buy credit picker offers, in micros. */
export const CREDIT_AMOUNTS_MICROS: readonly number[] = [
  10_000_000, 25_000_000, 50_000_000, 100_000_000,
];

/**
 * The bounds a custom amount has to fall inside.
 *
 * **The spec left the bounds open and these are the answer.** The floor is
 * the welcome credit, because an amount smaller than what Egma gives away is
 * a payment whose Stripe fee is most of it. The ceiling is a thousand dollars,
 * which is far past a self-serve customer's month and near enough that a
 * mistyped amount is refused rather than charged. Both are one edit away and
 * neither is a promise to anybody.
 */
export const SMALLEST_CREDIT_MICROS = 5_000_000;
export const LARGEST_CREDIT_MICROS = 1_000_000_000;

/** Why an amount cannot be bought, in a sentence a person can act on. */
export function creditAmountRefusal(amountMicros: number): string | undefined {
  if (!Number.isInteger(amountMicros)) {
    return "An amount of inference credit is a whole number of micro-dollars.";
  }
  if (amountMicros % 10_000 !== 0)
    return "Choose an amount of inference credit in whole cents.";
  if (amountMicros < SMALLEST_CREDIT_MICROS) {
    return `The smallest amount of inference credit is ${dollars(
      SMALLEST_CREDIT_MICROS,
    )}. Choose that or more and try again.`;
  }
  if (amountMicros > LARGEST_CREDIT_MICROS) {
    return `The largest amount of inference credit is ${dollars(
      LARGEST_CREDIT_MICROS,
    )}. Buy that or less, more than once if you need to.`;
  }
  return undefined;
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US")}`;
}

/** Return to the authorized project on the configured application origin. */
async function returnUrl(
  gateway: StripeGateway,
  auth: AuthContext,
): Promise<string> {
  const base = gateway.baseUrl;
  if (base === undefined) {
    throw new Error(
      "this deployment named no base URL, so Stripe has nowhere to send a " +
        "person back to after Checkout",
    );
  }
  const origin = new URL(base);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "the billing return URL must be an HTTP application URL without credentials, query, or fragment",
    );
  }
  const projectId = auth.projectId ?? (await listProjects(auth))[0]?.id;
  if (projectId === undefined) {
    throw new BillingStateError(
      "This organization has no project yet, so there is no settings page to " +
        "come back to. Create a project and try again.",
    );
  }
  return `${base.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/settings/billing`;
}

/** Resolve an existing customer under the organization lock before creating one. */
async function customerFor(
  gateway: StripeGateway,
  auth: AuthContext,
  actor: BillingActor,
): Promise<string> {
  const held = actor.account.stripeCustomerId;
  if (held !== null) return held;

  return resolveStripeCustomer(
    auth,
    () => stripeCustomerIds(gateway, auth.organizationId),
    async () => {
      const customer = await gateway.api.customers.create(
        {
          // Egma's own name for this customer, so a Stripe dashboard row can be
          // traced back to an organization without a second lookup. The person's
          // own name and address are collected by Checkout, which is where Stripe
          // Tax needs them.
          metadata: { egma_organization_id: auth.organizationId },
        },
        { idempotencyKey: stripeCustomerKey(auth.organizationId) },
      );
      return customer.id;
    },
  );
}

/** A Stripe-hosted page for the browser to follow. */
export type HostedPage = { readonly url: string };

function pageOf(url: string | null, what: string): HostedPage {
  if (url === null) {
    throw new Error(`Stripe returned no URL for the ${what} page`);
  }
  return { url };
}

/**
 * Open Checkout to buy inference credit.
 *
 * `payment` mode with Stripe Tax on. The amount is priced inline rather than
 * from a price object, because inference credit is a number a person chose and
 * a price per amount would be four price objects that mean nothing on their
 * own. The organization travels as the session's `client_reference_id`, which
 * the webhook checks against the account the Stripe customer belongs to.
 */
export async function openCreditCheckout(
  gateway: StripeGateway,
  auth: AuthContext,
  amountMicros: number,
): Promise<HostedPage> {
  return protectingStripeAction(auth, async () => {
    const refusal = creditAmountRefusal(amountMicros);
    if (refusal !== undefined) throw new CreditAmountError(refusal);

    const actor = await accountForBillingAction(auth);
    requireWebhook(gateway, actor.account.stripePaymentsReady);
    const returnTo = await returnUrl(gateway, auth);
    const customerId = await customerFor(gateway, auth, actor);

    const session = await gateway.api.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        client_reference_id: auth.organizationId,
        automatic_tax: { enabled: true },
        // Stripe Tax needs an address to work out a rate, and a returning
        // customer should not retype one they have already given.
        customer_update: { address: "auto", name: "auto" },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: centsFromMicros(amountMicros),
              // Exclusive: the amount a person chose is the credit they get, and
              // tax is added on top rather than taken out of it.
              tax_behavior: "exclusive",
              product_data: {
                name: "Egma inference credit",
                description:
                  "Prepaid balance for model usage made with Egma's provider " +
                  "keys. It never expires.",
              },
            },
          },
        ],
        metadata: {
          egma_organization_id: auth.organizationId,
          egma_credit_micros: String(amountMicros),
        },
        success_url: `${returnTo}?credit=bought`,
        cancel_url: `${returnTo}?credit=cancelled`,
      },
      { idempotencyKey: stripeAttemptKey("credit", randomUUID()) },
    );
    return pageOf(session.url, "Buy credit");
  });
}

/** An amount of credit that cannot be bought. Its sentence is shown as it is. */
export class CreditAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditAmountError";
  }
}

/** An action the account is in no state for. Its sentence is shown as it is. */
export class BillingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingStateError";
  }
}

/**
 * Open Checkout to move to Pro.
 *
 * `subscription` mode with three items: the monthly fee, and the two metered
 * prices whose first tier is the included allowance at nothing and whose
 * second prices every minute past it. A new subscription starts a full paid
 * month immediately.
 */
export async function openUpgradeCheckout(
  gateway: StripeGateway,
  auth: AuthContext,
): Promise<HostedPage> {
  return protectingStripeAction(auth, async () => {
    const actor = await accountForBillingAction(auth);
    requireWebhook(gateway, actor.account.stripePaymentsReady);
    if (actor.account.planCode === "pro") {
      throw new BillingStateError(
        "This organization is already on Pro. Use Manage payment and invoices " +
          "to change the card or read an invoice.",
      );
    }
    const prices = proPricesOf(actor);
    const returnTo = await returnUrl(gateway, auth);
    const customerId = await customerFor(gateway, auth, actor);

    const session = await gateway.api.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        client_reference_id: auth.organizationId,
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        line_items: [
          { price: prices.fee, quantity: 1 },
          // A metered item carries no quantity: the meter is what says how much.
          { price: prices.webCall },
          { price: prices.phone },
        ],
        subscription_data: {
          // What the invoice and the dashboard say this subscription is for.
          metadata: {
            egma_organization_id: auth.organizationId,
            egma_plan: "pro",
          },
        },
        metadata: { egma_organization_id: auth.organizationId },
        success_url: `${returnTo}?plan=pro`,
        cancel_url: `${returnTo}?plan=cancelled`,
      },
      { idempotencyKey: stripeAttemptKey("upgrade", randomUUID()) },
    );
    return pageOf(session.url, "Upgrade to Pro");
  });
}

/** The three Stripe prices Pro is sold at, or a refusal that names the setup. */
function proPricesOf(actor: BillingActor): {
  readonly fee: string;
  readonly webCall: string;
  readonly phone: string;
} {
  const {
    stripeFeePriceId,
    stripeWebCallMeterPriceId,
    stripePhoneMeterPriceId,
  } = actor.pro;
  if (
    stripeFeePriceId === null ||
    stripeWebCallMeterPriceId === null ||
    stripePhoneMeterPriceId === null
  ) {
    throw new BillingStateError(
      "This deployment's Stripe account has no Pro product yet, so there is " +
        "nothing to subscribe to. Run the Stripe setup for this deployment " +
        "and try again.",
    );
  }
  return {
    fee: stripeFeePriceId,
    webCall: stripeWebCallMeterPriceId,
    phone: stripePhoneMeterPriceId,
  };
}

/** What a downgrade settled on. */
export type ScheduledDowngrade = {
  /** When Pro ends. The organization keeps it until then. */
  readonly endsAt: Date | null;
};

/**
 * Stop Pro at the end of the period.
 *
 * **Nothing is cancelled now, and that is the rule.** The customer paid for
 * the month they are in, so `cancel_at_period_end` is set and Stripe ends the
 * subscription when the period does — at which point the deleted webhook puts
 * the organization back on Hobby with its own creation date as the anchor
 * again.
 */
export async function scheduleDowngrade(
  gateway: StripeGateway,
  auth: AuthContext,
): Promise<ScheduledDowngrade> {
  return protectingStripeAction(auth, async () => {
    const actor = await accountForBillingAction(auth);
    requireWebhook(gateway, actor.account.stripePaymentsReady);
    const subscriptionId = actor.account.stripeSubscriptionId;
    const status = actor.account.stripeSubscriptionStatus;
    if (subscriptionId === null || status === null || !isPaying(status)) {
      throw new BillingStateError(
        "This organization has no Pro subscription to stop. It is on the " +
          "Hobby plan already.",
      );
    }

    const subscription = await gateway.api.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: stripeAttemptKey("downgrade", randomUUID()) },
    );
    return { endsAt: endOfPeriodOf(subscription) };
  });
}

/** When the subscription's current period runs out, as its items state it. */
function endOfPeriodOf(subscription: Stripe.Subscription): Date | null {
  for (const item of subscription.items.data) {
    if (item.current_period_end != null) {
      return new Date(item.current_period_end * 1_000);
    }
  }
  return subscription.cancel_at === null
    ? null
    : new Date(subscription.cancel_at * 1_000);
}

/**
 * Open the Customer Portal, where the card and the invoices are.
 *
 * Stripe's own page, because a card form and an invoice list built here would
 * be a second copy of something Stripe keeps current and a place for a card
 * number to pass through Egma.
 */
export async function openBillingPortal(
  gateway: StripeGateway,
  auth: AuthContext,
): Promise<HostedPage> {
  return protectingStripeAction(auth, async () => {
    const actor = await accountForBillingAction(auth);
    requireWebhook(gateway, actor.account.stripePaymentsReady);
    const customerId = actor.account.stripeCustomerId;
    if (customerId === null) {
      throw new BillingStateError(
        "This organization has never paid Egma anything, so it has no card and " +
          "no invoices yet. Buy inference credit or move to Pro first.",
      );
    }
    const session = await gateway.api.billingPortal.sessions.create(
      { customer: customerId, return_url: await returnUrl(gateway, auth) },
      // Per attempt like the three above: a portal session expires, so an admin
      // who left one open has to be able to open another, and what this key is
      // for is a retried HTTP attempt rather than a repeated press.
      { idempotencyKey: stripeAttemptKey("portal", randomUUID()) },
    );
    return pageOf(session.url, "Manage payment and invoices");
  });
}

/** Do not accept payments before their signed results can reach the account. */
function requireWebhook(gateway: StripeGateway, paymentsReady: boolean): void {
  if (!gateway.hasWebhookSecret || !paymentsReady) {
    throw new BillingStateError(
      "Billing payments are unavailable while the webhook connection is being configured. Try again later, or ask your administrator to check the Stripe connection.",
    );
  }
}

async function protectingStripeAction<T>(
  auth: AuthContext,
  act: () => Promise<T>,
): Promise<T> {
  try {
    return await act();
  } catch (fault) {
    if (isEgmaStripeFailure(fault)) {
      await recordStripeOperationFailure(auth).catch((healthFault: unknown) => {
        console.error(
          "Stripe failure health could not be persisted",
          healthFault,
        );
      });
    }
    throw fault;
  }
}
