import { newId } from "@egma/ids";
import {
  authorize,
  fencedDatabase,
  readPlatformUsageTotal,
  upsertRateCard,
  schema,
  type AuthContext,
} from "@egma/db";
import { and, desc, eq, lt, or, sql, sum } from "drizzle-orm";
import { inferenceChargeKey } from "../idempotency.ts";
import { readPlanCatalog } from "../plans.ts";
import { openBillingAccount } from "./accounts.ts";
import { within } from "./within.ts";

const { cloudBillingAccount, cloudLedgerEntry } = schema;

export type SettledUsage = {
  readonly charged: number;
  readonly amountMicros: number;
};

/** Collect the newly observable cumulative spend once in this closed interval. */
export async function settleInferenceForOrganization(
  organizationId: string,
  at = new Date(),
): Promise<SettledUsage> {
  await prepareInferenceCollection();
  return collectInferenceForOrganization(organizationId, at);
}

async function prepareInferenceCollection(): Promise<void> {
  try {
    await upsertRateCard();
  } catch (fault) {
    await markInferenceSettlementFailed();
    throw fault;
  }
}

async function collectInferenceForOrganization(
  organizationId: string,
  at: Date,
): Promise<SettledUsage> {
  try {
    await openBillingAccount(organizationId);
    const intervalMs = (await readPlanCatalog()).chargingIntervalSeconds * 1000;
    const intervalEndedAt = new Date(
      Math.floor(at.getTime() / intervalMs) * intervalMs,
    );
    const intervalStartedAt = new Date(intervalEndedAt.getTime() - intervalMs);
    return await fencedDatabase().transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(cloudBillingAccount)
        .where(eq(cloudBillingAccount.organizationId, organizationId))
        .for("update");
      if (account === undefined)
        throw new Error("The billing account is missing");
      if (
        account.activatedAt >= intervalEndedAt ||
        (account.inferenceSettledThrough !== null &&
          account.inferenceSettledThrough >= intervalEndedAt)
      ) {
        return { charged: 0, amountMicros: 0 };
      }
      const snapshot = await readPlatformUsageTotal({
        organizationId,
        occurredAtOrAfter: account.activatedAt,
      });
      const [prior] = await tx
        .select({ amount: sum(cloudLedgerEntry.amountMicros) })
        .from(cloudLedgerEntry)
        .where(
          and(
            eq(cloudLedgerEntry.organizationId, organizationId),
            eq(cloudLedgerEntry.kind, "inference_charge"),
          ),
        );
      const alreadyCharged = -BigInt(prior?.amount ?? "0");
      const delta = snapshot.amountMicros - alreadyCharged;
      if (delta < 0n)
        throw new Error(
          "Cumulative usage is below settled charges; billing evidence needs repair",
        );
      const amountMicros = Number(delta);
      if (
        !Number.isSafeInteger(amountMicros) ||
        !Number.isSafeInteger(account.balanceMicros - amountMicros)
      ) {
        throw new Error("Inference settlement exceeds exact money range");
      }
      if (delta > 0n)
        await tx.insert(cloudLedgerEntry).values({
          id: newId("cle"),
          organizationId,
          kind: "inference_charge",
          amountMicros: -amountMicros,
          referenceKind: "settlement_interval",
          referenceId: intervalEndedAt.toISOString(),
          intervalStartedAt,
          intervalEndedAt,
          occurredAt: intervalEndedAt,
          idempotencyKey: inferenceChargeKey(
            organizationId,
            intervalStartedAt,
            intervalEndedAt,
          ),
        });
      await tx
        .update(cloudBillingAccount)
        .set({
          balanceMicros: sql`${cloudBillingAccount.balanceMicros} - ${amountMicros}`,
          inferenceSettledThrough: intervalEndedAt,
          settlementFailedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(cloudBillingAccount.organizationId, organizationId));
      return { charged: delta === 0n ? 0 : 1, amountMicros };
    });
  } catch (fault) {
    await markInferenceSettlementFailed(organizationId);
    throw fault;
  }
}

/** A billing fault makes cached balances unreliable until successful collection. */
export async function markInferenceSettlementFailed(
  organizationId?: string,
): Promise<void> {
  try {
    await fencedDatabase()
      .update(cloudBillingAccount)
      .set({ settlementFailedAt: new Date() })
      .where(
        organizationId === undefined
          ? undefined
          : eq(cloudBillingAccount.organizationId, organizationId),
      );
  } catch (fault) {
    console.error("Billing reliability could not be recorded", fault);
  }
}

/** Each organization is independent: one billing fault does not skip the others. */
export async function settleInference(at = new Date()): Promise<SettledUsage> {
  await prepareInferenceCollection();
  const accounts = await fencedDatabase()
    .select({ organizationId: cloudBillingAccount.organizationId })
    .from(cloudBillingAccount)
    .catch(async (fault: unknown) => {
      await markInferenceSettlementFailed();
      throw fault;
    });
  let charged = 0;
  let amountMicros = 0;
  for (const account of accounts) {
    try {
      const settled = await collectInferenceForOrganization(
        account.organizationId,
        at,
      );
      charged += settled.charged;
      amountMicros += settled.amountMicros;
    } catch (fault) {
      console.error(
        "Inference settlement failed; customer work remains allowed",
        { organizationId: account.organizationId, fault },
      );
    }
  }
  return { charged, amountMicros };
}

export async function readLedgerBalance(auth: AuthContext): Promise<number> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  const [row] = await fencedDatabase()
    .select({ total: sum(cloudLedgerEntry.amountMicros) })
    .from(cloudLedgerEntry)
    .where(within(auth, cloudLedgerEntry));
  return Number(row?.total ?? 0);
}

export type BillingLedgerEntry = {
  readonly id: string;
  readonly kind: string;
  readonly amountMicros: number;
  readonly occurredAt: Date;
  readonly intervalStartedAt: Date | null;
  readonly intervalEndedAt: Date | null;
};
export class InvalidLedgerCursorError extends Error {}

export type BillingLedgerPage = {
  readonly entries: readonly BillingLedgerEntry[];
  readonly nextCursor: string | null;
};

/** Stable keyset pagination keeps every historical movement accessible to members. */
export async function readBillingLedger(
  auth: AuthContext,
  cursor?: string,
): Promise<BillingLedgerPage> {
  authorize(auth, "read", {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  let before;
  if (cursor !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      throw new InvalidLedgerCursorError("Invalid ledger cursor");
    }
    if (
      cursor.length > 1024 ||
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !Number.isFinite(new Date(parsed[0]).getTime())
    )
      throw new InvalidLedgerCursorError("Invalid ledger cursor");
    const at = new Date(parsed[0]);
    before = or(
      lt(cloudLedgerEntry.occurredAt, at),
      and(
        eq(cloudLedgerEntry.occurredAt, at),
        lt(cloudLedgerEntry.id, parsed[1]),
      ),
    );
  }
  const rows = await fencedDatabase()
    .select({
      id: cloudLedgerEntry.id,
      kind: cloudLedgerEntry.kind,
      amountMicros: cloudLedgerEntry.amountMicros,
      occurredAt: cloudLedgerEntry.occurredAt,
      intervalStartedAt: cloudLedgerEntry.intervalStartedAt,
      intervalEndedAt: cloudLedgerEntry.intervalEndedAt,
    })
    .from(cloudLedgerEntry)
    .where(and(within(auth, cloudLedgerEntry), before))
    .orderBy(desc(cloudLedgerEntry.occurredAt), desc(cloudLedgerEntry.id))
    .limit(101);
  const entries = rows.slice(0, 100);
  const last = entries.at(-1);
  return {
    entries,
    nextCursor:
      rows.length > 100 && last !== undefined
        ? Buffer.from(
            JSON.stringify([last.occurredAt.toISOString(), last.id]),
          ).toString("base64url")
        : null,
  };
}
