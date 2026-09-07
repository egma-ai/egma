import { newId } from "@egma/ids";
import {
  authorize,
  fencedDatabase,
  minutesFromSeconds,
  periodAt,
  schema,
  voiceSecondsSelection,
  type AuthContext,
  type Queryable,
} from "@egma/db";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { purchasedCreditKey } from "../idempotency.ts";
import {
  PRO_STATUSES,
  isPaying,
  type AppliedDelivery,
  type MeteredHour,
  type StripeDelivery,
  type StripeFact,
} from "../stripe/facts.ts";
import { openBillingAccount, type BillingAccount } from "./accounts.ts";
import { readPlan, type CloudPlan } from "./plans.ts";
import { within } from "./within.ts";

const {
  cloudBillingAccount,
  cloudLedgerEntry,
  cloudPlan,
  cloudStripeEvent,
  organization,
  simulation,
} = schema;

/**
 * The rows Stripe moves: the customer it knows an organization by, the facts
 * its webhooks prove, the objects a plan is sold through, and the hour a meter
 * is owed.
 *
 * **Nothing here reaches Stripe.** The client lives one directory over, in
 * `ee/src/stripe/`, and everything in this file is handed a fact that has
 * already been proved — a delivery whose signature held, a customer Stripe
 * has already created, a price it has already made. That split is what lets
 * every rule below be tested by seeding rows, which is the founders' rule:
 * Stripe is never faked, so the tests that would have had to fake it are the
 * tests that never call it.
 *
 * **Three exports here take no `AuthContext`, and the lint rule names them.**
 * A webhook carries no person — Stripe's signature is the whole credential and
 * the organization is read off Egma's own account row rather than off anything
 * the payload claimed. The meter sweep carries no person either: it walks
 * every Pro organization on the deployment and can be handed none. See the
 * rule's note on the second fenced home.
 */

/* ─────────────────────────── what an admin acts on ─────────────────────── */

/**
 * The billing account this person may act on, and the plan it is on.
 *
 * **One call, and it is where the permission is asked.** Every Stripe action —
 * buy credit, upgrade, downgrade, open the portal — needs the same two things
 * first: that the caller may manage this organization's money, and the account
 * row that says what Stripe already holds for it. A route that asked those
 * separately would be a route that could forget the first.
 */
export type BillingActor = {
  readonly account: BillingAccount;
  readonly plan: CloudPlan;
  /** The Pro plan's row, whatever plan the account is on: what an upgrade buys. */
  readonly pro: CloudPlan;
};

export async function accountForBillingAction(
  auth: AuthContext,
  at: Date = new Date(),
): Promise<BillingActor> {
  authorize(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const account = await openBillingAccount(auth.organizationId, at);
  const [plan, pro] = await Promise.all([
    readPlan(account.planCode),
    readPlan("pro"),
  ]);
  return { account, plan, pro };
}

/**
 * Remember the Stripe customer this organization's money moves through.
 *
 * **Written once and never overwritten.** The update names the null it is
 * filling, so two admins pressing Buy credit together cannot leave the account
 * pointing at one customer while an invoice is raised against another: the
 * first write wins and the second reads the winner back. Stripe's own
 * idempotency key on the create is the other half — inside Stripe's window
 * both requests resolve to one customer, so the loser usually has nothing to
 * throw away.
 */
export async function recordStripeCustomer(
  auth: AuthContext,
  customerId: string,
): Promise<string> {
  authorize(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const [claimed] = await fencedDatabase()
    .update(cloudBillingAccount)
    .set({ stripeCustomerId: customerId, updatedAt: new Date() })
    .where(
      and(
        within(auth, cloudBillingAccount),
        sql`${cloudBillingAccount.stripeCustomerId} is null`,
      ),
    )
    .returning({ customerId: cloudBillingAccount.stripeCustomerId });
  if (claimed?.customerId != null) return claimed.customerId;

  const [held] = await fencedDatabase()
    .select({ customerId: cloudBillingAccount.stripeCustomerId })
    .from(cloudBillingAccount)
    .where(within(auth, cloudBillingAccount))
    .limit(1);
  if (held?.customerId == null) {
    throw new Error(
      `the billing account for ${auth.organizationId} took neither the ` +
        "Stripe customer offered to it nor held one already",
    );
  }
  return held.customerId;
}

/* ────────────────────────── what a webhook proves ──────────────────────── */

/**
 * Apply one Stripe delivery, at most once.
 *
 * **The event row is written first, in the same transaction as everything it
 * causes.** An id already there means Stripe has redelivered and nothing runs;
 * a failure anywhere below rolls the row back with it, so the delivery is
 * unapplied rather than half applied and Stripe's next attempt does the whole
 * of it. The two cannot come apart, which is the only arrangement in which
 * "applied exactly once" is true rather than intended.
 *
 * **An unknown customer is a fault and not a shrug.** A payment for a customer
 * Egma cannot resolve is somebody who paid and got nothing, so it throws: the
 * event stays unrecorded, the route answers a fault, and Stripe retries on its
 * own schedule while the log says which customer. Recording it would make the
 * money quietly disappear, which is the one outcome worth being loud about.
 */
export async function applyStripeEvent(
  delivery: StripeDelivery,
  at: Date = new Date(),
): Promise<AppliedDelivery> {
  return fencedDatabase().transaction(async (tx) => {
    const [recorded] = await tx
      .insert(cloudStripeEvent)
      .values({ id: delivery.id, type: delivery.type, receivedAt: at })
      .onConflictDoNothing({ target: cloudStripeEvent.id })
      .returning({ id: cloudStripeEvent.id });
    if (recorded === undefined) {
      return { applied: false, effect: "redelivered" } as const;
    }

    const fact = delivery.fact;
    // An event type nobody acts on is still worth a row: the table is the
    // record of what this deployment has seen, and a type that arrives and
    // does nothing is a fact about the webhook rather than a gap in it.
    if (fact === undefined) return { applied: true, effect: "ignored" } as const;

    const account = await accountOfStripeCustomer(tx, fact.customerId);
    if (account === undefined) {
      throw new Error(
        `Stripe event ${delivery.id} (${delivery.type}) names customer ` +
          `${fact.customerId}, which no billing account holds; nothing was ` +
          "applied and the event was not recorded, so Stripe will redeliver",
      );
    }

    return fact.kind === "purchased_credit"
      ? creditFrom(tx, account, fact)
      : subscriptionFrom(tx, account, fact);
  });
}

type LinkedAccount = {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationCreatedAt: Date;
};

async function accountOfStripeCustomer(
  on: Queryable,
  customerId: string,
): Promise<LinkedAccount | undefined> {
  const [row] = await on
    .select({
      id: cloudBillingAccount.id,
      organizationId: cloudBillingAccount.organizationId,
      organizationCreatedAt: organization.createdAt,
    })
    .from(cloudBillingAccount)
    .innerJoin(
      organization,
      eq(organization.id, cloudBillingAccount.organizationId),
    )
    .where(eq(cloudBillingAccount.stripeCustomerId, customerId))
    .limit(1);
  return row;
}

/**
 * The credit a completed Checkout Session bought.
 *
 * One ledger row keyed on the session, and the materialised balance raised in
 * the same breath, exactly as every other movement of a balance is written.
 */
async function creditFrom(
  tx: Queryable,
  account: LinkedAccount,
  fact: Extract<StripeFact, { kind: "purchased_credit" }>,
): Promise<AppliedDelivery> {
  if (
    fact.organizationId !== null &&
    fact.organizationId !== account.organizationId
  ) {
    throw new Error(
      `Checkout Session ${fact.sessionId} names organization ` +
        `${fact.organizationId} while its Stripe customer belongs to ` +
        `${account.organizationId}; nothing was applied`,
    );
  }
  if (fact.amountMicros <= 0) {
    // A session that collected nothing is not a movement, and the ledger's own
    // check would refuse the row. Recorded and passed over.
    return { applied: true, effect: "ignored" };
  }

  const [written] = await tx
    .insert(cloudLedgerEntry)
    .values({
      id: newId("cle"),
      organizationId: account.organizationId,
      kind: "purchased_credit",
      amountMicros: fact.amountMicros,
      referenceKind: "checkout_session",
      referenceId: fact.sessionId,
      usageRecordId: null,
      idempotencyKey: purchasedCreditKey(fact.sessionId),
      occurredAt: fact.occurredAt,
    })
    .onConflictDoNothing({ target: cloudLedgerEntry.idempotencyKey })
    .returning({ amountMicros: cloudLedgerEntry.amountMicros });
  // The same payment under a second event id. The row is what makes it once.
  if (written === undefined) {
    return { applied: true, effect: "credit_already_written" };
  }

  await tx
    .update(cloudBillingAccount)
    .set({
      balanceMicros: sql`${cloudBillingAccount.balanceMicros} + ${written.amountMicros}`,
      updatedAt: new Date(),
    })
    .where(eq(cloudBillingAccount.id, account.id));
  return { applied: true, effect: "credited" };
}

/**
 * The plan, the subscription and the month, as Stripe's subscription states
 * them.
 *
 * **Level-triggered, never edge-triggered.** The status decides the plan every
 * time, so a delivery that arrives late or out of order settles on the same
 * answer as the one that arrived on time — there is no "was active, became
 * past_due" transition to miss. A finished subscription puts the anchor back
 * to the organization's own creation instant, which is what a Hobby month has
 * always been counted from and needs no Stripe object to exist.
 */
async function subscriptionFrom(
  tx: Queryable,
  account: LinkedAccount,
  fact: Extract<StripeFact, { kind: "subscription" }>,
): Promise<AppliedDelivery> {
  const paying = !fact.finished && isPaying(fact.status);
  await tx
    .update(cloudBillingAccount)
    .set({
      planCode: paying ? "pro" : "hobby",
      stripeSubscriptionId: fact.subscriptionId,
      stripeSubscriptionStatus: fact.status,
      periodAnchor:
        paying && fact.periodStart !== null
          ? fact.periodStart
          : account.organizationCreatedAt,
      updatedAt: new Date(),
    })
    .where(eq(cloudBillingAccount.id, account.id));
  return { applied: true, effect: "plan_changed" };
}

/* ─────────────────── the objects a plan is sold through ────────────────── */

/** The Stripe objects one plan's charges go through, once they exist. */
export type StripePlanObjects = {
  readonly planCode: schema.PlanCode;
  readonly productId: string;
  readonly feePriceId: string;
  readonly webCallMeterId: string;
  readonly phoneMeterId: string;
  readonly webCallMeterPriceId: string;
  readonly phoneMeterPriceId: string;
};

/**
 * Write the Stripe objects a plan is sold through onto its row.
 *
 * **The deployment configuring itself**, like the plan seed beside it, and it
 * takes no customer for the same reason: a product, a price and a meter belong
 * to the Stripe account, not to anybody on it. The boot seed never touches
 * these columns — an upsert from the shipped file would blank them every
 * morning — so this is the one writer, and it is idempotent because the setup
 * that calls it finds the same objects rather than making new ones.
 */
export async function recordStripePlanObjects(
  objects: StripePlanObjects,
): Promise<void> {
  await fencedDatabase()
    .update(cloudPlan)
    .set({
      stripeProductId: objects.productId,
      stripeFeePriceId: objects.feePriceId,
      stripeWebCallMeterId: objects.webCallMeterId,
      stripePhoneMeterId: objects.phoneMeterId,
      stripeWebCallMeterPriceId: objects.webCallMeterPriceId,
      stripePhoneMeterPriceId: objects.phoneMeterPriceId,
      updatedAt: new Date(),
    })
    .where(eq(cloudPlan.code, objects.planCode));
}

/* ──────────────────────── the hour a meter is owed ─────────────────────── */

/** What one Pro organization owes for one hour, and who Stripe knows it as. */
export type OrganizationOverage = {
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  /** The hour these minutes belong to. What the meter event is identified by. */
  readonly hour: MeteredHour;
  /** Whole web-call minutes this hour adds to the period. Never negative. */
  readonly webCallMinutes: number;
  /** Whole phone minutes this hour adds to the period. Never negative. */
  readonly phoneMinutes: number;
  /**
   * Whether this hour is further back than Stripe's own meter window.
   *
   * Nobody can bill it: a meter event may not be timestamped more than 35 days
   * back. The job passes over such an hour and says so, rather than retrying
   * the same one for ever.
   */
  readonly tooOldForStripe: boolean;
};

/** How far back a meter event may be timestamped, as Stripe publishes it. */
export const METER_TIMESTAMP_WINDOW_DAYS = 35;

/**
 * The most hours one organization is caught up by in a single wake.
 *
 * A bound rather than a limit on what is owed: the mark advances as far as the
 * wake got, so the next one carries on. Two days of catch-up is four hundred
 * meter events a wake at the very worst, and an outage longer than that is
 * caught up over the following wakes rather than in one burst that a rate
 * limit would refuse anyway.
 */
export const MOST_HOURS_CAUGHT_UP_AT_ONCE = 48;

/** Milliseconds in one hour, so no arithmetic below writes the number by hand. */
const AN_HOUR = 3_600_000;

/**
 * Every hour every paying Pro organization still owes Stripe a meter event
 * for, oldest first.
 *
 * **The mark is what makes a missed hour recoverable.** The minutes an hour
 * owes are the difference between the whole minutes its period had at the end
 * of the hour and at the start of it, which is exactly why nothing is lost to
 * a part-minute — and exactly why an hour that is never posted has its minutes
 * swallowed by the next hour's "before". So each account remembers the last
 * hour Stripe took, and this answers every completed hour after it: a process
 * that was down for six hours comes back and reports six hours, in order.
 *
 * **An organization with no mark is not back-billed.** It gets the hour that
 * has just closed and nothing before it, because a mark appears the first time
 * the job sees an account and a Pro subscription bought nothing before it
 * existed.
 *
 * **Hours Stripe would refuse are still answered, and marked as such.** A
 * meter event may not be timestamped more than 35 days back, so an outage
 * longer than that leaves hours nobody can bill. They come back with
 * `tooOldForStripe` set, so the job can advance past them and say so rather
 * than retrying the same hour for ever.
 *
 * **Whole minutes, and nothing is lost.** Stripe's own documentation says a
 * meter event's value should be a whole number, so an hour cannot report the
 * fractional minute it really used; the difference of two running totals
 * carries it into the next hour instead.
 *
 * **By when a conversation ended.** Until a conversation ends nobody knows how
 * long it was, and an hour closed on start times could never come back for it.
 *
 * **No customer can be named to it**, which is what makes its exemption from
 * the `AuthContext` rule safe: it is handed the last closed hour and answers
 * about every paying organization on the deployment, because that is what an
 * hourly job is.
 */
export async function overageOwedThrough(
  latestClosedHour: MeteredHour,
  at: Date = new Date(),
): Promise<readonly OrganizationOverage[]> {
  const accounts = await fencedDatabase()
    .select({
      organizationId: cloudBillingAccount.organizationId,
      stripeCustomerId: cloudBillingAccount.stripeCustomerId,
      periodAnchor: cloudBillingAccount.periodAnchor,
      reportedThrough: cloudBillingAccount.overageReportedThrough,
    })
    .from(cloudBillingAccount)
    .where(
      and(
        eq(cloudBillingAccount.planCode, "pro"),
        isNotNull(cloudBillingAccount.stripeCustomerId),
        inArray(cloudBillingAccount.stripeSubscriptionStatus, [...PRO_STATUSES]),
      ),
    );

  const oldestStripeWillTake =
    at.getTime() - METER_TIMESTAMP_WINDOW_DAYS * 24 * AN_HOUR;
  const owed: OrganizationOverage[] = [];
  for (const account of accounts) {
    const customerId = account.stripeCustomerId;
    if (customerId === null) continue;
    for (const hour of hoursOwedBy(account.reportedThrough, latestClosedHour)) {
      // One indexed query per organization per unreported hour. A single
      // statement would have to carry each customer's own period start into
      // the aggregate, and the month arithmetic that produces it lives in one
      // place and is not SQL. An hourly job reports one hour per customer;
      // only a catch-up costs more, and it is bounded above.
      owed.push({
        organizationId: account.organizationId,
        stripeCustomerId: customerId,
        hour,
        tooOldForStripe: hour.startedAt.getTime() < oldestStripeWillTake,
        ...(await minutesAddedInTheHour(
          account.organizationId,
          account.periodAnchor,
          hour,
        )),
      });
    }
  }
  return owed;
}

/**
 * The completed hours after the mark, oldest first.
 *
 * With no mark, only the hour that has just closed: an account the job has
 * never seen is one that has never been Pro while the job ran, and the hours
 * before that were not sold.
 */
function hoursOwedBy(
  reportedThrough: Date | null,
  latestClosedHour: MeteredHour,
): readonly MeteredHour[] {
  if (reportedThrough === null) return [latestClosedHour];

  const hours: MeteredHour[] = [];
  let startedAt = new Date(reportedThrough.getTime() + AN_HOUR);
  while (
    startedAt.getTime() <= latestClosedHour.startedAt.getTime() &&
    hours.length < MOST_HOURS_CAUGHT_UP_AT_ONCE
  ) {
    hours.push({ startedAt, endedAt: new Date(startedAt.getTime() + AN_HOUR) });
    startedAt = new Date(startedAt.getTime() + AN_HOUR);
  }
  return hours;
}

/** How far one organization's overage has been reported. */
export type OverageMark = {
  readonly organizationId: string;
  /** The start of the last hour Stripe took, or refused as one it already had. */
  readonly reportedThrough: Date;
};

/**
 * Move each account's mark forward to the last hour Stripe took.
 *
 * **It only ever moves forward.** A wake that caught up four hours and failed
 * on the fifth marks the fourth, and the fifth is the first thing the next
 * wake asks about. The `greatest` is what makes two instances reporting the
 * same hour harmless: neither can walk the other's mark backwards.
 *
 * It takes marks Egma itself has just produced from its own rows, which is why
 * it carries no `AuthContext` — the same ground the usage sink stands on.
 */
export async function markOverageReported(
  marks: readonly OverageMark[],
): Promise<void> {
  for (const mark of marks) {
    await fencedDatabase()
      .update(cloudBillingAccount)
      .set({
        overageReportedThrough: sql`greatest(
          coalesce(${cloudBillingAccount.overageReportedThrough}, to_timestamp(0)),
          ${mark.reportedThrough}
        )`,
        updatedAt: new Date(),
      })
      .where(eq(cloudBillingAccount.organizationId, mark.organizationId));
  }
}

/** The whole minutes this hour added to the period, per voice kind. */
async function minutesAddedInTheHour(
  organizationId: string,
  periodAnchor: Date,
  hour: MeteredHour,
): Promise<{ readonly webCallMinutes: number; readonly phoneMinutes: number }> {
  const from = countedFrom(periodAnchor, hour);
  const through = voiceSecondsSelection(lt(simulation.endedAt, hour.endedAt));
  const before = voiceSecondsSelection(lt(simulation.endedAt, hour.startedAt));
  const [totals] = await fencedDatabase()
    .select({
      phoneThrough: through.phoneSeconds,
      webCallThrough: through.webCallSeconds,
      phoneBefore: before.phoneSeconds,
      webCallBefore: before.webCallSeconds,
    })
    .from(simulation)
    .where(
      and(
        eq(simulation.organizationId, organizationId),
        gte(simulation.endedAt, from),
        lt(simulation.endedAt, hour.endedAt),
      ),
    );

  return {
    webCallMinutes: minutesAdded(totals?.webCallBefore, totals?.webCallThrough),
    phoneMinutes: minutesAdded(totals?.phoneBefore, totals?.phoneThrough),
  };
}

/**
 * Where an hour's running total is counted from.
 *
 * The start of the period the hour falls in — so the count restarts when the
 * month does, which is what the invoice does too — or the hour's own start
 * where that is earlier. The second case is the hour a period turns over in:
 * the anchor Stripe wrote is inside it, and counting from the anchor would
 * drop the minutes before it. Counting the hour whole cannot double-count
 * either, because every later hour counts from the new period's start and so
 * excludes them.
 *
 * It is a pure function of the anchor and the hour, which is what makes the
 * difference between two hours telescope even when they are reported by two
 * different wakes.
 */
function countedFrom(periodAnchor: Date, hour: MeteredHour): Date {
  const period = periodAt(periodAnchor, hour.startedAt);
  return period.startedAt.getTime() < hour.startedAt.getTime()
    ? period.startedAt
    : hour.startedAt;
}

/**
 * The whole minutes between two running totals of seconds.
 *
 * The floor of each, subtracted — which is what makes the part-minute survive
 * into the next hour instead of being thrown away by it.
 */
function minutesAdded(before: string | undefined, through: string | undefined): number {
  const wholeBefore = Math.floor(minutesFromSeconds(Number(before ?? 0)));
  const wholeThrough = Math.floor(minutesFromSeconds(Number(through ?? 0)));
  return Math.max(0, wholeThrough - wholeBefore);
}
