import { newId } from "@egma/ids";
import {
  allowanceTotalsSelection,
  authorize,
  permits,
  fencedDatabase,
  organizationInThePeriod,
  periodAt,
  periodUsageFrom,
  schema,
  type AllowancePeriod,
  type AuthContext,
  type PeriodUsage,
  type Queryable,
} from "@egma/db";
import { eq } from "drizzle-orm";

import { welcomeCreditKey } from "../idempotency.ts";
import { readPlanCatalog, type PlanCatalog } from "../plans.ts";
import { periodChargesOf, type PeriodCharge } from "./ledger.ts";
import { readPlan, type CloudPlan } from "./plans.ts";

const { cloudBillingAccount, cloudLedgerEntry, organization, simulation } = schema;

/**
 * One organization's billing account, and the welcome credit it starts with.
 *
 * **The account is created lazily, on the first question anybody asks about
 * this customer's money.** There is no organization-created hook to hang it
 * on — the open product has no seam that fires when a customer appears, and
 * adding one would put a cloud concern in the signup path of every self-hosted
 * deployment. Lazily is also the stronger rule: an account that exists because
 * somebody asked cannot be missing for a customer who was created before
 * billing was switched on.
 *
 * **A second welcome credit is impossible, and two things make it so.** The
 * account has a unique index on the organization, so two creations racing each
 * other leave one row; and the ledger row is keyed on the organization, so
 * even a deleted-and-recreated account cannot write a second credit while the
 * old row survives. The code only has to notice which of the two it was.
 */

/** One billing account, as everything here reads it. */
export type BillingAccount = {
  readonly id: string;
  readonly organizationId: string;
  readonly planCode: "hobby" | "pro";
  /** When this customer's month turns over. */
  readonly periodAnchor: Date;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeSubscriptionStatus: string | null;
  /** The inference balance in millionths of a US dollar. Signed. */
  readonly balanceMicros: number;
};

const ACCOUNT_COLUMNS = {
  id: cloudBillingAccount.id,
  organizationId: cloudBillingAccount.organizationId,
  planCode: cloudBillingAccount.planCode,
  periodAnchor: cloudBillingAccount.periodAnchor,
  stripeCustomerId: cloudBillingAccount.stripeCustomerId,
  stripeSubscriptionId: cloudBillingAccount.stripeSubscriptionId,
  stripeSubscriptionStatus: cloudBillingAccount.stripeSubscriptionStatus,
  balanceMicros: cloudBillingAccount.balanceMicros,
} as const;

function accountFrom(row: {
  readonly id: string;
  readonly organizationId: string;
  readonly planCode: string;
  readonly periodAnchor: Date;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeSubscriptionStatus: string | null;
  readonly balanceMicros: number;
}): BillingAccount {
  return { ...row, planCode: row.planCode === "pro" ? "pro" : "hobby" };
}

async function accountRow(
  on: Queryable,
  organizationId: string,
): Promise<BillingAccount | undefined> {
  const [row] = await on
    .select(ACCOUNT_COLUMNS)
    .from(cloudBillingAccount)
    .where(eq(cloudBillingAccount.organizationId, organizationId))
    .limit(1);
  return row === undefined ? undefined : accountFrom(row);
}

/**
 * This organization's account, created with its welcome credit if it has none.
 *
 * **One transaction, and the balance is written with the ledger row.** The
 * materialised balance is a cache of the sum of the ledger, so the only safe
 * moment to set it is the moment the row it caches is written. Nothing here
 * reads the sum back: a cache proved by a nightly job is the design, and a
 * read-back would be a second answer.
 */
export async function openBillingAccount(
  organizationId: string,
  at: Date = new Date(),
  catalog?: PlanCatalog,
): Promise<BillingAccount> {
  const opened = await openAccountIfTheCustomerExists(organizationId, at, catalog);
  if (opened === undefined) {
    throw new Error(
      `organization ${organizationId} was not found while opening its ` +
        "billing account",
    );
  }
  return opened;
}

/**
 * The same, answering nothing at all where the organization does not exist.
 *
 * **There is one caller and it is the entitlement source**, which is asked
 * about an organization rather than handed a context and must answer rather
 * than throw: an organization with no rows has run nothing and holds nothing,
 * which is a true answer to both of the port's questions and the safe one —
 * the balance it does not have funds nothing.
 */
async function openAccountIfTheCustomerExists(
  organizationId: string,
  at: Date,
  catalog?: PlanCatalog,
): Promise<BillingAccount | undefined> {
  const held = await accountRow(fencedDatabase(), organizationId);
  if (held !== undefined) return held;

  const read = catalog ?? (await readPlanCatalog());
  return fencedDatabase().transaction(async (tx) => {
    // Hobby's period anchor is the organization's own creation date, so a
    // customer's reset day is theirs and needs no Stripe object to exist.
    const [customer] = await tx
      .select({ createdAt: organization.createdAt })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (customer === undefined) return undefined;

    const [created] = await tx
      .insert(cloudBillingAccount)
      .values({
        id: newId("cba"),
        organizationId,
        planCode: "hobby",
        periodAnchor: customer.createdAt,
        balanceMicros: read.welcomeCreditMicros,
      })
      .onConflictDoNothing({ target: cloudBillingAccount.organizationId })
      .returning(ACCOUNT_COLUMNS);

    if (created === undefined) {
      // Somebody else created it while this transaction was in flight. Their
      // row is the account, welcome credit and all.
      const already = await accountRow(tx, organizationId);
      if (already === undefined) {
        throw new Error(
          `the billing account for ${organizationId} was neither created nor ` +
            "found, which the unique index makes impossible",
        );
      }
      return already;
    }

    await tx
      .insert(cloudLedgerEntry)
      .values({
        id: newId("cle"),
        organizationId,
        kind: "welcome_credit",
        amountMicros: read.welcomeCreditMicros,
        referenceKind: "organization",
        referenceId: organizationId,
        usageRecordId: null,
        idempotencyKey: welcomeCreditKey(organizationId),
        occurredAt: at,
      })
      .onConflictDoNothing({ target: cloudLedgerEntry.idempotencyKey });

    return accountFrom(created);
  });
}

/**
 * Everything the entitlement source decides from: the account, its plan, the
 * period it is in and what that period has used.
 *
 * **One organization id and no `AuthContext`, because there is nobody.** The
 * two moments this answers — a run start and a claim batch — are Egma asking
 * itself whether a customer's work may go on, and the organization on each
 * comes from a caller's own resolved context or from a row Egma claimed. See
 * the lint rule's note on the second fenced home.
 */
/** What an organization with no rows looks like: nothing spent, nothing held. */
function unopened(organizationId: string, at: Date): BillingAccount {
  return {
    id: "",
    organizationId,
    planCode: "hobby",
    periodAnchor: at,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    balanceMicros: 0,
  };
}

export type EntitlementFacts = {
  readonly account: BillingAccount;
  readonly plan: CloudPlan;
  readonly period: AllowancePeriod;
  readonly usage: PeriodUsage;
};

export async function readEntitlementFacts(
  organizationId: string,
  at: Date = new Date(),
): Promise<EntitlementFacts> {
  const opened = await openAccountIfTheCustomerExists(organizationId, at);
  // An organization with no rows at all: it has run nothing, so it has spent
  // no allowance, and it holds no balance, so Egma's key funds nothing for it.
  // Both are true answers and neither is generous.
  const account = opened ?? unopened(organizationId, at);
  const plan = await readPlan(account.planCode);
  const period = periodAt(account.periodAnchor, at);

  // The same aggregate the organization settings page reads, from the same
  // expressions, so an allowance a page says is half spent is half spent here.
  const [totals] = await fencedDatabase()
    .select(allowanceTotalsSelection())
    .from(simulation)
    .where(organizationInThePeriod(organizationId, period));

  return { account, plan, period, usage: periodUsageFrom(period, totals) };
}

/**
 * Everything the Billing section shows, in one read.
 *
 * **One call rather than three**, because the plan, the balance, the month and
 * what the month's money went on are one answer to one question — what is this
 * organization's account — and a surface that made a page ask three times
 * would be a surface whose three answers could be about three moments.
 *
 * **`read` and not `manage_organization`.** A run that paused for money has to
 * explain itself to whoever started it, so every role reads the plan, the
 * allowances and the balance. What only an admin reads is the breakdown of
 * what the money went on, which is the account rather than the limit; it is
 * empty for everybody else and the flag beside it says which they are.
 */
export type BillingOverview = {
  readonly account: BillingAccount;
  readonly plan: CloudPlan;
  readonly period: AllowancePeriod;
  /** What the balance paid for this period, by provider and model. Admins. */
  readonly charges: readonly PeriodCharge[];
  /** Whether this person may change the plan, the card or the credit. */
  readonly mayManageBilling: boolean;
};

export async function readBillingOverview(
  auth: AuthContext,
  at: Date = new Date(),
): Promise<BillingOverview> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const account = await openBillingAccount(auth.organizationId, at);
  const plan = await readPlan(account.planCode);
  const period = periodAt(account.periodAnchor, at);
  const mayManageBilling = permits(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const charges = mayManageBilling
    ? await periodChargesOf(auth.organizationId, period)
    : [];
  return { account, plan, period, charges, mayManageBilling };
}
