import { newId } from "@egma/ids";
import {
  authorize,
  fencedDatabase,
  schema,
  type AuthContext,
  type Queryable,
} from "@egma/db";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";

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

/** Customer creation and unlinked-fault recovery share this organization lock. */
export async function resolveStripeCustomer(
  auth: AuthContext,
  create: () => Promise<string>,
): Promise<string> {
  authorize(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  return fencedDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`egma:stripe-customer:${auth.organizationId}`}::text, 0))`,
    );
    const [account] = await tx
      .select({
        id: cloudBillingAccount.id,
        customerId: cloudBillingAccount.stripeCustomerId,
      })
      .from(cloudBillingAccount)
      .where(within(auth, cloudBillingAccount));
    if (account === undefined)
      throw new Error("Stripe customer creation has no billing account");
    if (account.customerId !== null) return account.customerId;
    const customerId = await create();
    if (customerId.trim() === "")
      throw new Error("Stripe returned an empty customer identity");
    await tx
      .update(cloudBillingAccount)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(cloudBillingAccount.id, account.id));
    return customerId;
  });
}

/** The timer repairs a failed customer link from actual customer identities, never by creating paid state. */
type UnlinkedStripeAccount = { readonly organizationId: string };
export async function recoverUnlinkedStripeAccounts(
  read: (account: UnlinkedStripeAccount) => Promise<readonly string[]>,
  failed: (account: UnlinkedStripeAccount, fault: unknown) => void,
): Promise<void> {
  const accounts = await fencedDatabase()
    .select({ organizationId: cloudBillingAccount.organizationId })
    .from(cloudBillingAccount)
    .innerJoin(cloudPlan, eq(cloudPlan.code, "hobby"))
    .where(
      and(
        isNull(cloudBillingAccount.stripeCustomerId),
        isNotNull(cloudBillingAccount.stripeFailedAt),
        eq(cloudPlan.stripePaymentsReady, true),
      ),
    );
  for (const { organizationId } of accounts) {
    try {
      await fencedDatabase().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`egma:stripe-customer:${organizationId}`}::text, 0))`,
        );
        const [account] = await tx
          .select()
          .from(cloudBillingAccount)
          .where(eq(cloudBillingAccount.organizationId, organizationId));
        if (
          account === undefined ||
          account.stripeCustomerId !== null ||
          account.stripeFailedAt === null
        )
          return;
        const ids = await read({ organizationId });
        if (ids.length > 1 || ids.some((id) => id.trim() === ""))
          throw new Error(
            "Stripe customer identity needs reconciliation before linking",
          );
        const customerId = ids[0];
        if (customerId !== undefined) {
          await tx
            .update(cloudBillingAccount)
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(
              and(
                eq(cloudBillingAccount.id, account.id),
                isNull(cloudBillingAccount.stripeCustomerId),
              ),
            );
          return;
        }
        if (
          account.planCode !== "hobby" ||
          account.stripeSubscriptionId !== null
        )
          throw new Error("an unlinked account retains subscription evidence");
        await tx
          .update(cloudBillingAccount)
          .set({ stripeFailedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(cloudBillingAccount.id, account.id),
              isNull(cloudBillingAccount.stripeCustomerId),
              eq(
                cloudBillingAccount.stripeFailureVersion,
                account.stripeFailureVersion,
              ),
            ),
          );
      });
    } catch (fault) {
      failed({ organizationId }, fault);
    }
  }
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
