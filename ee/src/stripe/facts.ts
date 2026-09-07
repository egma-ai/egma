import type { schema } from "@egma/db";

/**
 * What Egma keeps from Stripe, said in Egma's own words.
 *
 * **No client and no store.** Everything here is vocabulary and arithmetic: the
 * unit Stripe counts money in, which subscription statuses are Pro, what an
 * hour is, and the shape of a fact a signed delivery carries. It sits between
 * the adapter that talks to Stripe and the module that writes rows, because
 * both have to mean the same thing by each of them, and a second definition of
 * "past_due keeps Pro" would be found by a customer whose plan disagreed with
 * their invoice.
 */

/** Millionths of a US dollar in one cent, which is the unit Stripe counts in. */
const MICROS_IN_A_CENT = 10_000;

/** Stripe's amount, in the unit every amount in this product is counted in. */
export function microsFromCents(cents: number): number {
  return cents * MICROS_IN_A_CENT;
}

/** The same the other way, for the amounts Egma asks Stripe to charge. */
export function centsFromMicros(micros: number): number {
  return Math.round(micros / MICROS_IN_A_CENT);
}

/**
 * The subscription statuses that are Pro.
 *
 * **`past_due` is Pro, and that is the decision.** A renewal that failed is in
 * Stripe's own retry schedule, and a customer whose card expired on the third
 * of the month has paid for the month they are in. Egma follows Stripe's
 * retries and returns the organization to Hobby only when Stripe gives up —
 * `unpaid` or `canceled` — which is the founders' rule that a lapsed card is a
 * downgrade and not a debt. Everything else, including the two `incomplete`
 * states and `paused`, has collected no payment and is Hobby.
 */
export const PRO_STATUSES: readonly schema.SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
];

/**
 * Whether a subscription in this status keeps its organization on Pro.
 *
 * It takes a plain string because a status arrives two ways — off a Stripe
 * object, where it is Stripe's own word, and off Egma's account row, where it
 * is text with a database check behind it — and a caller having to cast one of
 * them to ask the question would be a caller who could cast the wrong thing.
 */
export function isPaying(status: string): boolean {
  return PRO_STATUSES.some((paying) => paying === status);
}

/**
 * One fact a signed Stripe delivery carries.
 *
 * **The customer and never the organization.** Every fact here names a Stripe
 * customer, and the organization is found from Egma's own account row through
 * the unique index on that column — so a delivery can only ever reach an
 * account Egma itself linked, and nothing a payload claims about whose money
 * this is is believed. A Checkout Session's `client_reference_id` does carry
 * the organization, and it is checked against the row rather than trusted in
 * its place.
 */
export type StripeFact =
  | {
      readonly kind: "purchased_credit";
      readonly customerId: string;
      /** Stripe's `cs_...`: what the movement is keyed on, forever. */
      readonly sessionId: string;
      /**
       * What the customer paid for credit, net of tax, in micro-dollars.
       *
       * The session's `amount_subtotal` rather than its total, because tax is
       * money that goes to a tax authority: buying $25 of credit has to put
       * $25 on the balance in every jurisdiction Stripe Tax charges in.
       */
      readonly amountMicros: number;
      /** Egma's own organization, as Egma wrote it onto the session. */
      readonly organizationId: string | null;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: "subscription";
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly status: schema.SubscriptionStatus;
      /** Stripe's current period start: the anchor while the subscription pays. */
      readonly periodStart: Date | null;
      /** True for `customer.subscription.deleted`: this one is over. */
      readonly finished: boolean;
    };

/** One signed delivery, read into what Egma acts on. */
export type StripeDelivery = {
  /** Stripe's `evt_...`, verbatim: the primary key that stops a redelivery. */
  readonly id: string;
  readonly type: string;
  /** Absent for an event type Egma does not act on. Recorded, and ignored. */
  readonly fact?: StripeFact | undefined;
};

/** What applying one delivery did. */
export type AppliedDelivery = {
  /** False when this event id was already recorded. A redelivery changes nothing. */
  readonly applied: boolean;
  /** What it did, for the deployment log. */
  readonly effect:
    | "redelivered"
    | "ignored"
    | "credited"
    | "plan_changed"
    | "credit_already_written";
};

/** One hour of the clock, half-open at both ends. */
export type MeteredHour = {
  readonly startedAt: Date;
  readonly endedAt: Date;
};

/** Milliseconds in one hour, so no arithmetic below writes the number by hand. */
const AN_HOUR = 3_600_000;

/** The hour one instant falls in, from its top to the top of the next. */
export function hourAround(at: Date): MeteredHour {
  const startedAt = new Date(at);
  startedAt.setUTCMinutes(0, 0, 0);
  return { startedAt, endedAt: new Date(startedAt.getTime() + AN_HOUR) };
}

/**
 * The hour before the one this instant falls in.
 *
 * What an hourly job reports: the hour that has closed. Reporting the hour in
 * progress would post a number that is still moving, and the meter refuses the
 * same identifier a second time — so the rest of that hour could never be
 * sent.
 */
export function previousHour(at: Date): MeteredHour {
  const current = hourAround(at);
  return {
    startedAt: new Date(current.startedAt.getTime() - AN_HOUR),
    endedAt: current.startedAt,
  };
}
