import type { schema } from "@egma/db";

const MICROS_IN_A_CENT = 10_000;
export function microsFromCents(cents: number): number {
  return cents * MICROS_IN_A_CENT;
}
export function centsFromMicros(micros: number): number {
  return Math.round(micros / MICROS_IN_A_CENT);
}

/** Stripe retries a past-due renewal before the organization loses Pro. */
export const PRO_STATUSES: readonly schema.SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
];
export function isPaying(status: string): boolean {
  return PRO_STATUSES.some((paying) => paying === status);
}

export type CanonicalSubscription = {
  readonly subscriptionId: string | null;
  readonly status: schema.SubscriptionStatus | null;
  readonly periodAnchor: Date | null;
  readonly periodStartedAt: Date | null;
  readonly periodEndsAt: Date | null;
  readonly hobbyStartedAt: Date | null;
};

/** Subscription events request a current customer refresh, never apply stale state. */
export type StripeFact =
  | {
      readonly kind: "purchased_credit";
      readonly customerId: string;
      readonly sessionId: string;
      readonly amountMicros: number;
      readonly organizationId: string | null;
      readonly occurredAt: Date;
    }
  | { readonly kind: "subscription"; readonly customerId: string };

export type PurchasedCreditFact = Extract<
  StripeFact,
  { kind: "purchased_credit" }
>;
export type StripeCustomerFacts = {
  readonly credits: readonly PurchasedCreditFact[];
  readonly subscription: CanonicalSubscription;
};

export type StripeDelivery = {
  readonly id: string;
  readonly type: string;
  readonly fact?: StripeFact | undefined;
};

export type AppliedDelivery = {
  readonly applied: boolean;
  readonly effect:
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

/** Decimal-minute deltas retain per-second usage and carry rounding forward. */
export function minuteValueAdded(
  beforeSeconds: number,
  throughSeconds: number,
): string {
  if (
    !Number.isSafeInteger(beforeSeconds) ||
    !Number.isSafeInteger(throughSeconds) ||
    beforeSeconds < 0 ||
    throughSeconds < beforeSeconds
  ) {
    throw new Error("meter totals must be nondecreasing safe integer seconds");
  }
  const scale = 1_000_000_000_000n;
  const before = (BigInt(beforeSeconds) * scale + 30n) / 60n;
  const through = (BigInt(throughSeconds) * scale + 30n) / 60n;
  const delta = through - before;
  return `${delta / scale}.${String(delta % scale).padStart(12, "0")}`;
}
