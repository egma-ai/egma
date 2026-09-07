import { newId } from "@egma/ids";
import {
  authorize,
  fencedDatabase,
  schema,
  type AuthContext,
  type Queryable,
} from "@egma/db";
import { and, eq, sql } from "drizzle-orm";

import { purchasedCreditKey } from "../idempotency.ts";
import {
  isPaying,
  type AppliedDelivery,
  type CanonicalSubscription,
  type StripeDelivery,
  type StripeFact,
  type StripeCustomerFacts,
} from "../stripe/facts.ts";
import { openBillingAccount, type BillingAccount } from "./accounts.ts";
import { readPlan, type CloudPlan } from "./plans.ts";
import { within } from "./within.ts";

const { cloudBillingAccount, cloudLedgerEntry, cloudPlan } = schema;

export type BillingActor = {
  readonly account: BillingAccount;
  readonly plan: CloudPlan;
  /** The Pro plan's row, whatever plan the account is on: what an upgrade buys. */
  readonly pro: CloudPlan;
};

export async function accountForBillingAction(
  auth: AuthContext,
): Promise<BillingActor> {
  authorize(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const account = await openBillingAccount(auth.organizationId);
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

/** Credit uses its session key; subscriptions refresh inside one customer lock. */
export async function applyStripeEvent(
  delivery: StripeDelivery,
  at: Date = new Date(),
  readCanonical?: (
    customerId: string,
    needsHobbyTransition: boolean,
    previousSubscriptionId: string | null,
  ) => Promise<CanonicalSubscription>,
): Promise<AppliedDelivery> {
  const fact = delivery.fact;
  if (fact === undefined) return { applied: true, effect: "ignored" };
  try {
    return await fencedDatabase().transaction(async (tx) => {
      // The network read is inside this lock, so snapshots cannot apply in reverse.
      if (fact.kind === "subscription") {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`egma:stripe-subscription:${fact.customerId}`}::text, 0))`,
        );
      }
      const [account] = await tx
        .select({
          id: cloudBillingAccount.id,
          organizationId: cloudBillingAccount.organizationId,
          planCode: cloudBillingAccount.planCode,
          periodAnchor: cloudBillingAccount.periodAnchor,
          stripeSubscriptionId: cloudBillingAccount.stripeSubscriptionId,
        })
        .from(cloudBillingAccount)
        .where(eq(cloudBillingAccount.stripeCustomerId, fact.customerId))
        .limit(1);
      if (account === undefined)
        throw new Error(
          `Stripe customer ${fact.customerId} has no billing account`,
        );
      if (fact.kind === "purchased_credit")
        return creditFrom(tx, account, fact);
      if (readCanonical === undefined)
        throw new Error(
          "subscription delivery requires a current Stripe customer read",
        );
      const current = await readCanonical(
        fact.customerId,
        account.planCode === "pro",
        account.stripeSubscriptionId,
      );
      await applyCanonical(tx, account, current, at);
      return { applied: true, effect: "plan_changed" };
    });
  } catch (fault) {
    await markStripeCustomerFailed(fact.customerId).catch(
      (healthFault: unknown) => {
        console.error(
          "Stripe failure health could not be persisted",
          healthFault,
        );
      },
    );
    throw fault;
  }
}

async function applyCanonical(
  tx: Queryable,
  account: {
    readonly id: string;
    readonly planCode: string;
    readonly periodAnchor: Date;
  },
  current: CanonicalSubscription,
  at: Date,
): Promise<void> {
  const pro = current.status !== null && isPaying(current.status);
  if (
    pro &&
    (current.subscriptionId === null ||
      current.periodAnchor === null ||
      current.periodStartedAt === null ||
      current.periodEndsAt === null)
  ) {
    throw new Error(
      "a payable Stripe subscription requires complete period bounds",
    );
  }
  if (!pro && account.planCode === "pro" && current.hobbyStartedAt === null) {
    throw new Error(
      "Stripe has not proved the effective Pro-to-Hobby transition time",
    );
  }
  const periodAnchor =
    pro && current.periodAnchor !== null
      ? current.periodAnchor
      : account.planCode === "pro" && current.hobbyStartedAt !== null
        ? current.hobbyStartedAt
        : account.periodAnchor;
  await tx
    .update(cloudBillingAccount)
    .set({
      planCode: pro ? "pro" : "hobby",
      stripeSubscriptionId: current.subscriptionId,
      stripeSubscriptionStatus: current.status,
      stripeSubscriptionRefreshedAt: at,
      stripePeriodStartedAt: current.periodStartedAt,
      stripePeriodEndsAt: current.periodEndsAt,
      periodAnchor,
      updatedAt: at,
    })
    .where(eq(cloudBillingAccount.id, account.id));
}

/** Internal to the fenced access module: identity was resolved from Stripe or an owned account. */
export async function markStripeCustomerFailed(
  customerId: string,
): Promise<void> {
  await fencedDatabase()
    .update(cloudBillingAccount)
    .set({
      stripeFailedAt: new Date(),
      stripeFailureVersion: sql`${cloudBillingAccount.stripeFailureVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(cloudBillingAccount.stripeCustomerId, customerId));
}

/** An authorized admin action failed before Egma could finish its Stripe operation. */
export async function recordStripeOperationFailure(
  auth: AuthContext,
): Promise<void> {
  authorize(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  await fencedDatabase()
    .update(cloudBillingAccount)
    .set({
      stripeFailedAt: new Date(),
      stripeFailureVersion: sql`${cloudBillingAccount.stripeFailureVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(within(auth, cloudBillingAccount));
}

/** The API owns deployment readiness; a missing signing connection is not healthy billing. */
export async function setStripePaymentsReady(ready: boolean): Promise<void> {
  await fencedDatabase()
    .update(cloudPlan)
    .set({ stripePaymentsReady: ready, updatedAt: new Date() })
    .where(eq(cloudPlan.code, "hobby"));
}

/** Internal to the fenced sweep; every paid credit and current plan are read under one customer lock. */
export async function reconcileStripeAccount(
  customerId: string,
  read: (
    customerId: string,
    needsHobbyTransition: boolean,
    previousSubscriptionId: string | null,
  ) => Promise<StripeCustomerFacts>,
  at: Date,
): Promise<void> {
  await fencedDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`egma:stripe-subscription:${customerId}`}::text, 0))`,
    );
    const [account] = await tx
      .select({
        id: cloudBillingAccount.id,
        organizationId: cloudBillingAccount.organizationId,
        planCode: cloudBillingAccount.planCode,
        periodAnchor: cloudBillingAccount.periodAnchor,
        stripeSubscriptionId: cloudBillingAccount.stripeSubscriptionId,
      })
      .from(cloudBillingAccount)
      .where(eq(cloudBillingAccount.stripeCustomerId, customerId));
    if (account === undefined)
      throw new Error("Stripe reconciliation has no linked billing account");
    const facts = await read(
      customerId,
      account.planCode === "pro",
      account.stripeSubscriptionId,
    );
    for (const credit of facts.credits) {
      if (credit.customerId !== customerId)
        throw new Error("Stripe credit reconciliation crossed customers");
      await creditFrom(tx, account, credit);
    }
    await applyCanonical(tx, account, facts.subscription, at);
  });
}

async function creditFrom(
  tx: Queryable,
  account: { readonly id: string; readonly organizationId: string },
  fact: Extract<StripeFact, { kind: "purchased_credit" }>,
): Promise<AppliedDelivery> {
  if (
    fact.organizationId !== null &&
    fact.organizationId !== account.organizationId
  ) {
    throw new Error(
      `Checkout Session ${fact.sessionId} names another organization`,
    );
  }
  if (!Number.isSafeInteger(fact.amountMicros) || fact.amountMicros <= 0) {
    throw new Error("purchased credit must be a positive safe integer amount");
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
      idempotencyKey: purchasedCreditKey(fact.sessionId),
      occurredAt: fact.occurredAt,
    })
    .onConflictDoNothing({ target: cloudLedgerEntry.idempotencyKey })
    .returning({ amountMicros: cloudLedgerEntry.amountMicros });
  if (written === undefined)
    return { applied: false, effect: "credit_already_written" };
  await tx
    .update(cloudBillingAccount)
    .set({
      balanceMicros: sql`${cloudBillingAccount.balanceMicros} + ${written.amountMicros}`,
      updatedAt: new Date(),
    })
    .where(eq(cloudBillingAccount.id, account.id));
  return { applied: true, effect: "credited" };
}

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
