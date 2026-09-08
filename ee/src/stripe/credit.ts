import type Stripe from "stripe";
import { microsFromCents, type PurchasedCreditFact } from "./facts.ts";

function idOf(value: string | { readonly id: string } | null): string | null {
  return value === null ? null : typeof value === "string" ? value : value.id;
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
export function creditFactFrom(
  session: Stripe.Checkout.Session,
  occurredAt: Date,
): PurchasedCreditFact | undefined {
  if (session.mode !== "payment") return undefined;
  if (session.payment_status !== "paid") return undefined;
  if (session.metadata?.egma_credit_micros === undefined) return undefined;
  const expected = Number(session.metadata.egma_credit_micros);
  if (
    session.currency !== "usd" ||
    !Number.isSafeInteger(expected) ||
    expected !== microsFromCents(session.amount_subtotal ?? 0) ||
    expected <= 0
  ) {
    throw new Error(
      `Checkout Session ${session.id} has inconsistent credit purchase facts`,
    );
  }
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
