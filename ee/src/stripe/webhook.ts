import { schema } from "@egma/db";
import Stripe from "stripe";

import { applyStripeEvent } from "../access/index.ts";
import {
  microsFromCents,
  type AppliedDelivery,
  type StripeDelivery,
  type StripeFact,
} from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";

const { SUBSCRIPTION_STATUSES } = schema;

/**
 * Stripe's answers, read into Egma's own facts and applied once each.
 *
 * **The signature is the whole credential.** This door carries no session
 * cookie and no API key: anybody can reach it, and only Stripe can produce a
 * body whose signature holds against the deployment's signing secret. So the
 * verification happens on the raw bytes Stripe sent, before anything is read
 * out of them, and a body that failed it never becomes a fact.
 *
 * **Reading is here; writing is one directory over.** This file turns a
 * `Stripe.Event` into the small set of things Egma keeps, and hands them to
 * the access module, which writes the event row and everything it causes in
 * one transaction. That is what lets every rule about plans, anchors and
 * balances be tested by seeding rows rather than by pretending to be Stripe.
 *
 * **An event type Egma does not act on is recorded and ignored.** Stripe sends
 * whatever the endpoint is subscribed to and adds new types over time; a
 * deployment that threw at one would be a deployment whose webhook goes red
 * because Stripe shipped a feature.
 */

/** The event types this deployment acts on. Everything else is recorded. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

/** Stripe's id for an expandable field, whichever shape it came back in. */
function idOf(value: string | { readonly id: string } | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.id;
}

/** Stripe counts time in whole seconds. */
function instantFrom(seconds: number | null | undefined): Date | null {
  return seconds == null ? null : new Date(seconds * 1_000);
}

function isSubscriptionStatus(
  value: string,
): value is schema.SubscriptionStatus {
  return SUBSCRIPTION_STATUSES.some((status) => status === value);
}

/**
 * What one Checkout Session proves, or nothing.
 *
 * **Only a `payment` session buys credit.** A `subscription` session's own
 * completion says a subscription now exists, which the subscription events say
 * better and with the status and the period on them — so this reads past it
 * and lets those do the work. A session whose payment has not settled proves
 * nothing yet; Stripe sends `async_payment_succeeded` when it does.
 */
function creditFrom(
  session: Stripe.Checkout.Session,
  occurredAt: Date,
): StripeFact | undefined {
  if (session.mode !== "payment") return undefined;
  if (session.payment_status !== "paid") return undefined;
  const customerId = idOf(session.customer);
  if (customerId === null) return undefined;
  return {
    kind: "purchased_credit",
    customerId,
    sessionId: session.id,
    // Net of tax. Tax is money that goes to a tax authority, and buying $25 of
    // credit has to put $25 on the balance wherever the customer is.
    amountMicros: microsFromCents(session.amount_subtotal ?? 0),
    organizationId: session.client_reference_id,
    occurredAt,
  };
}

/** What one subscription event proves about a plan, a month and a status. */
function subscriptionFactFrom(
  subscription: Stripe.Subscription,
  finished: boolean,
): StripeFact {
  const customerId = idOf(subscription.customer);
  if (customerId === null) {
    throw new Error(
      `Stripe subscription ${subscription.id} names no customer, so there is ` +
        "no account it could belong to",
    );
  }
  if (!isSubscriptionStatus(subscription.status)) {
    // Loud rather than guessed. Guessing "not paying" would downgrade a
    // customer who is paying, and guessing "paying" would keep one who is not;
    // Stripe redelivers while somebody adds the word.
    throw new Error(
      `Stripe subscription ${subscription.id} is in status ` +
        `"${subscription.status}", which Egma has no rule for; nothing was ` +
        "applied",
    );
  }
  return {
    kind: "subscription",
    customerId,
    subscriptionId: subscription.id,
    status: subscription.status,
    periodStart: periodStartOf(subscription),
    finished,
  };
}

/**
 * When Stripe's current billing period began.
 *
 * **Read off the subscription's items.** Stripe moved `current_period_start`
 * from the subscription onto each item, so the subscription object this SDK's
 * pinned API version returns does not carry one; the fee item's is the
 * subscription's period, because every item on an Egma subscription shares one
 * cycle. The billing cycle anchor is the fallback, and it names the same day
 * of the month — it is the fixed point every period is counted from.
 */
function periodStartOf(subscription: Stripe.Subscription): Date | null {
  for (const item of subscription.items.data) {
    const started = instantFrom(item.current_period_start);
    if (started !== null) return started;
  }
  return instantFrom(subscription.billing_cycle_anchor);
}

/**
 * Whether this is Stripe's own verdict that a signature did not hold.
 *
 * **Its own class, never its message.** A signature that does not verify will
 * not verify on the next attempt either, so it has to be told apart from every
 * other way the door can fail — and the wording of a vendor's exception is not
 * something to branch on. Stripe raises one class for exactly this, and it is
 * declared here rather than at the route, because this directory is where the
 * SDK is known.
 */
export function isSignatureFailure(fault: unknown): boolean {
  return fault instanceof Stripe.errors.StripeSignatureVerificationError;
}

/** One verified event, read into the fact Egma keeps from it. */
export function deliveryFrom(event: Stripe.Event): StripeDelivery {
  const occurredAt = new Date(event.created * 1_000);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const fact = creditFrom(event.data.object, occurredAt);
      return { id: event.id, type: event.type, fact };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return {
        id: event.id,
        type: event.type,
        fact: subscriptionFactFrom(
          event.data.object,
          event.type === "customer.subscription.deleted",
        ),
      };
    default:
      // Recorded, and ignored. See the note at the top of this file.
      return { id: event.id, type: event.type };
  }
}

/**
 * Prove one delivery and apply it, at most once.
 *
 * The raw bytes go in, exactly as Stripe sent them: Stripe signs the body it
 * sent, so a body that has been parsed and re-serialised is a different body
 * and will not verify.
 */
export async function applyStripeDelivery(
  gateway: StripeGateway,
  payload: Buffer | string,
  signature: string,
  at: Date = new Date(),
): Promise<AppliedDelivery> {
  const event = gateway.verify(payload, signature);
  return applyStripeEvent(deliveryFrom(event), at);
}
