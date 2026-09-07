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
import { and, eq, isNull, or, sql, sum } from "drizzle-orm";

import { welcomeCreditKey } from "../idempotency.ts";
import { readPlanCatalog, type PlanCatalog } from "../plans.ts";
import {
  markInferenceSettlementFailed,
  readBillingLedger,
  type BillingLedgerPage,
} from "./ledger.ts";
import { readPlan, type CloudPlan } from "./plans.ts";

const {
  cloudBillingAccount,
  cloudLedgerEntry,
  cloudPlan,
  organization,
  simulation,
} = schema;

export type BillingAccount = {
  readonly id: string;
  readonly organizationId: string;
  readonly planCode: "hobby" | "pro";
  readonly periodAnchor: Date;
  readonly activatedAt: Date;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeSubscriptionStatus: string | null;
  readonly stripeFailedAt: Date | null;
  readonly stripeFailureVersion: number;
  readonly stripePaymentsReady: boolean;
  readonly balanceMicros: number;
  readonly settlementFailedAt: Date | null;
};

const ACCOUNT_COLUMNS = {
  id: cloudBillingAccount.id,
  organizationId: cloudBillingAccount.organizationId,
  planCode: cloudBillingAccount.planCode,
  periodAnchor: cloudBillingAccount.periodAnchor,
  activatedAt: cloudBillingAccount.activatedAt,
  stripeCustomerId: cloudBillingAccount.stripeCustomerId,
  stripeSubscriptionId: cloudBillingAccount.stripeSubscriptionId,
  stripeSubscriptionStatus: cloudBillingAccount.stripeSubscriptionStatus,
  stripeFailedAt: cloudBillingAccount.stripeFailedAt,
  stripeFailureVersion: cloudBillingAccount.stripeFailureVersion,
  balanceMicros: cloudBillingAccount.balanceMicros,
  settlementFailedAt: cloudBillingAccount.settlementFailedAt,
} as const;

async function accountRow(
  on: Queryable,
  organizationId: string,
): Promise<
  { account: BillingAccount; welcomeCreditGranted: boolean } | undefined
> {
  const [row] = await on
    .select({
      ...ACCOUNT_COLUMNS,
      stripePaymentsReady: cloudPlan.stripePaymentsReady,
      welcomeCreditGranted: sql<boolean>`exists(select 1 from ${cloudLedgerEntry} where ${cloudLedgerEntry.organizationId} = ${cloudBillingAccount.organizationId} and ${cloudLedgerEntry.kind} = 'welcome_credit')`,
    })
    .from(cloudBillingAccount)
    .innerJoin(cloudPlan, eq(cloudPlan.code, "hobby"))
    .where(eq(cloudBillingAccount.organizationId, organizationId))
    .limit(1);
  if (row === undefined) return undefined;
  if (row.planCode !== "hobby" && row.planCode !== "pro")
    throw new Error("Unknown billing plan");
  const { welcomeCreditGranted, ...account } = row;
  return {
    account: { ...account, planCode: row.planCode },
    welcomeCreditGranted,
  };
}

/** Record the deployment cutoff once. Plan seeding never changes this field. */
export async function activateBilling(at = new Date()): Promise<Date> {
  const [row] = await fencedDatabase()
    .update(cloudPlan)
    .set({
      billingActivatedAt: sql`coalesce(${cloudPlan.billingActivatedAt}, ${at})`,
    })
    .where(eq(cloudPlan.code, "hobby"))
    .returning({ at: cloudPlan.billingActivatedAt });
  if (row?.at === null || row?.at === undefined)
    throw new Error("Billing activation needs the Hobby plan");
  const organizations = await fencedDatabase()
    .select({ id: organization.id })
    .from(organization)
    .leftJoin(
      cloudBillingAccount,
      eq(cloudBillingAccount.organizationId, organization.id),
    )
    .leftJoin(
      cloudLedgerEntry,
      and(
        eq(cloudLedgerEntry.organizationId, organization.id),
        eq(cloudLedgerEntry.kind, "welcome_credit"),
      ),
    )
    .where(or(isNull(cloudBillingAccount.id), isNull(cloudLedgerEntry.id)));
  const catalog = await readPlanCatalog();
  for (const customer of organizations) {
    try {
      await fencedDatabase().transaction((tx) =>
        createBillingAccount(tx, customer.id, catalog),
      );
    } catch (fault) {
      await markInferenceSettlementFailed(customer.id);
      console.error(
        "Billing account repair failed; other organizations continue",
        { organizationId: customer.id, fault },
      );
    }
  }
  return row.at;
}

/** Create or repair the account and missing welcome grant on the caller's transaction. */
export async function createBillingAccount(
  on: Queryable,
  organizationId: string,
  catalog: PlanCatalog,
): Promise<BillingAccount> {
  const [cutoff] = await on
    .select({ at: cloudPlan.billingActivatedAt })
    .from(cloudPlan)
    .where(eq(cloudPlan.code, "hobby"));
  if (cutoff?.at === undefined || cutoff.at === null)
    throw new Error("Billing has no recorded activation cutoff");
  const [customer] = await on
    .select({ createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.id, organizationId));
  if (customer === undefined)
    throw new Error("Billing organization does not exist");
  const activatedAt = new Date(
    Math.max(customer.createdAt.getTime(), cutoff.at.getTime()),
  );
  // Existing ledger money survives account repair; only inference charges define collection progress.
  const [balance] = await on
    .select({ total: sum(cloudLedgerEntry.amountMicros) })
    .from(cloudLedgerEntry)
    .where(eq(cloudLedgerEntry.organizationId, organizationId));
  await on
    .insert(cloudBillingAccount)
    .values({
      id: newId("cba"),
      organizationId,
      planCode: "hobby",
      periodAnchor: customer.createdAt,
      activatedAt,
      balanceMicros: Number(balance?.total ?? 0),
    })
    .onConflictDoNothing({ target: cloudBillingAccount.organizationId });
  await on
    .select({ id: cloudBillingAccount.id })
    .from(cloudBillingAccount)
    .where(eq(cloudBillingAccount.organizationId, organizationId))
    .for("update");
  const [welcome] = await on
    .select({ id: cloudLedgerEntry.id })
    .from(cloudLedgerEntry)
    .where(
      and(
        eq(cloudLedgerEntry.organizationId, organizationId),
        eq(cloudLedgerEntry.kind, "welcome_credit"),
      ),
    )
    .limit(1);
  const [granted] =
    welcome !== undefined
      ? []
      : await on
          .insert(cloudLedgerEntry)
          .values({
            id: newId("cle"),
            organizationId,
            kind: "welcome_credit",
            amountMicros: catalog.welcomeCreditMicros,
            referenceKind: "organization",
            referenceId: organizationId,
            idempotencyKey: welcomeCreditKey(organizationId),
            occurredAt: activatedAt,
          })
          .onConflictDoNothing({ target: cloudLedgerEntry.idempotencyKey })
          .returning({ amountMicros: cloudLedgerEntry.amountMicros });
  if (granted !== undefined)
    await on
      .update(cloudBillingAccount)
      .set({
        balanceMicros: sql`${cloudBillingAccount.balanceMicros} + ${granted.amountMicros}`,
        updatedAt: new Date(),
      })
      .where(eq(cloudBillingAccount.organizationId, organizationId));
  const account = await accountRow(on, organizationId);
  if (account === undefined)
    throw new Error("Billing account creation returned no account");
  return account.account;
}

export async function openBillingAccount(
  organizationId: string,
): Promise<BillingAccount> {
  const held = await accountRow(fencedDatabase(), organizationId);
  if (held?.welcomeCreditGranted) return held.account;
  const read = await readPlanCatalog();
  return fencedDatabase().transaction((tx) =>
    createBillingAccount(tx, organizationId, read),
  );
}

export type EntitlementFacts = {
  readonly account: BillingAccount;
  readonly plan: CloudPlan;
  readonly period: AllowancePeriod;
  readonly usage: PeriodUsage;
};

export async function readEntitlementFacts(
  organizationId: string,
  at = new Date(),
): Promise<EntitlementFacts> {
  const account = await openBillingAccount(organizationId);
  const plan = await readPlan(account.planCode);
  const period = periodAt(account.periodAnchor, at);
  const [totals] = await fencedDatabase()
    .select(allowanceTotalsSelection())
    .from(simulation)
    .where(
      organizationInThePeriod(organizationId, period, account.activatedAt),
    );
  return { account, plan, period, usage: periodUsageFrom(period, totals) };
}

export type BillingOverview = EntitlementFacts & {
  readonly ledger: BillingLedgerPage;
  readonly mayManageBilling: boolean;
};

export async function readBillingOverview(
  auth: AuthContext,
  at = new Date(),
): Promise<BillingOverview> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const facts = await readEntitlementFacts(auth.organizationId, at);
  const mayManageBilling = permits(auth, "manage_organization", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  return { ...facts, ledger: await readBillingLedger(auth), mayManageBilling };
}
