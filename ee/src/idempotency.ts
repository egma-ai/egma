/** Permanent ledger keys identify the organization, interval or Checkout payment. */

/** The key a welcome credit is written under. One per organization, forever. */
export function welcomeCreditKey(organizationId: string): string {
  return `welcome_credit:${organizationId}`;
}

/** The key an inference charge is written under. One per organization and settlement interval. */
export function inferenceChargeKey(organizationId: string, start: Date, end: Date): string {
  return `inference_charge:${organizationId}:${start.toISOString()}:${end.toISOString()}`;
}

/**
 * The key a purchased credit is written under. One per Stripe Checkout Session.
 *
 * The session is what caused the movement, so a webhook Stripe redelivers —
 * and Stripe redelivers on its own schedule until Egma answers — writes
 * nothing the second time, regardless of which event id carries it.
 */
export function purchasedCreditKey(sessionId: string): string {
  return `purchased_credit:${sessionId}`;
}

/**
 * Keys for the writes made **into Stripe**, which are a different guarantee.
 *
 * The three above are Egma's own permanent unique index: a key is a name for a
 * movement, and a row under it can never be written twice for as long as Egma
 * keeps its rows. The two below are Stripe's `Idempotency-Key` header, whose
 * window Stripe sets and which is at least 24 hours — long enough to make a
 * retried request one write, and no basis at all for "this can never happen
 * again". So each one is used for exactly what its window can carry.
 */

/**
 * The key a Stripe customer is created under. One per organization, forever.
 *
 * **Two admins pressing Buy credit at the same moment must not create two
 * Stripe customers**, because a customer is where a card, an invoice history
 * and a subscription live, and a second one splits a company's billing in
 * half. The key is the organization, so both requests inside Stripe's window
 * resolve to one customer and the loser stores the id the winner made.
 */
export function stripeCustomerKey(organizationId: string): string {
  return `egma_customer:${organizationId}`;
}

/**
 * The four writes an admin's button makes into Stripe.
 *
 * Named as a union rather than taken as a free string, because a key's prefix
 * is what a person reading Stripe's request log sees, and a typo in it would
 * be a silent second namespace nobody notices.
 */
export type StripeAttempt = "credit" | "upgrade" | "downgrade" | "portal";

/**
 * The key one attempt at a Stripe write is made under.
 *
 * **Per attempt, deliberately, and never per organization.** A Checkout
 * Session an admin abandoned must be replaceable by pressing the button again;
 * a key derived from the organization would hand them Stripe's memory of the
 * session they walked away from. What this key is for is the narrower thing a
 * retry needs: one HTTP attempt that timed out and was sent again is one
 * write, not two.
 */
export function stripeAttemptKey(
  what: StripeAttempt,
  attemptId: string,
): string {
  return `egma_${what}:${attemptId}`;
}

