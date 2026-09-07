import Stripe from "stripe";

import { applyStripeEvent } from "../access/index.ts";
import { type AppliedDelivery, type StripeDelivery } from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";
import { creditFactFrom } from "./credit.ts";
import { currentSubscription } from "./periods.ts";

/** Events relevant to credit purchases or current subscription refresh. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
] as const;

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
      const fact = creditFactFrom(event.data.object, occurredAt);
      return { id: event.id, type: event.type, fact };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return {
        id: event.id,
        type: event.type,
        fact:
          event.data.object.metadata.egma_plan === "pro"
            ? {
                kind: "subscription",
                customerId:
                  typeof event.data.object.customer === "string"
                    ? event.data.object.customer
                    : event.data.object.customer.id,
              }
            : undefined,
      };
    default:
      return { id: event.id, type: event.type };
  }
}

/**
 * Verify the raw delivery before crediting or refreshing subscription state.
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
  return applyStripeEvent(
    deliveryFrom(event),
    at,
    (customerId, needsHobbyTransition) =>
      currentSubscription(gateway, customerId, needsHobbyTransition),
  );
}
