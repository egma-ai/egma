import { newId } from "@egma/ids";
import {
  authorize,
  fencedDatabase,
  schema,
  type AllowancePeriod,
  type AuthContext,
  type StoredUsageRecord,
} from "@egma/db";
import { and, asc, eq, gt, gte, isNull, lt, sql, sum } from "drizzle-orm";

import { inferenceChargeKey } from "../idempotency.ts";
import { within } from "./within.ts";
import { openBillingAccount } from "./accounts.ts";

const { cloudBillingAccount, cloudLedgerEntry, usageRecord } = schema;

/**
 * The ledger: one row per movement of an inference balance, and the charges a
 * period made.
 *
 * **The balance is the sum of these rows.** The account's `balance_micros` is
 * a cache of that sum, written in the same transaction as every row so the two
 * can never be seen disagreeing. Nothing here decides a direction at read
 * time: the sign is on the row and a check holds it there, so a sum is the
 * balance with no case analysis anywhere.
 *
 * **A charge is written once because of one unique index.** The key is derived
 * from the usage record's own id, which is already the stable name of that
 * piece of spend, so a redelivered measurement or a replayed sink cannot
 * charge twice — and the sink is handed only what the store actually wrote,
 * which is the first of the two guards.
 *
 * **And a charge nobody managed to write is found again.** A sink may fail
 * without failing the write that stored the record, so the sweep below reads
 * the records that carry no charge and puts them through the same path. The
 * key derived from the record is what lets it run beside a live delivery.
 */

/** What one delivery to the sink actually charged. */
export type ChargedUsage = {
  /** How many records became a ledger row. A replay charges none. */
  readonly charged: number;
  /** What those rows came to, in millionths of a US dollar, as a positive sum. */
  readonly amountMicros: number;
};

/**
 * Charge the balance for every record Egma's own key paid for.
 *
 * **Only `platform` records, and that is the whole rule.** A record the
 * customer's own provider key paid for costs Egma nothing and is not a charge;
 * a sink that assumed otherwise would bill a customer for their own provider
 * account.
 *
 * **A record that cost nothing writes no row.** A quantity with no price
 * effective at its instant is stored at zero, and a movement of nothing is not
 * a movement — the ledger's own check says so. It is real usage and it is on
 * the usage page; it is simply not money.
 *
 * **The ledger row and the balance move in one transaction, per organization.**
 * A batch can hold records from more than one customer, so it is grouped first
 * and each customer's charge is one transaction: a failure charges one
 * customer's balance or none of it, never half of it.
 *
 * **It may take the balance below zero, and that is the design.** Work already
 * claimed finishes and is charged; the entitlement source is what stops new
 * work at zero, so the overrun is bounded by what was in flight.
 */
export async function chargeForStoredUsage(
  records: readonly StoredUsageRecord[],
): Promise<ChargedUsage> {
  const payable = records.filter(
    (record) => record.paymentSource === "platform" && record.amountMicros > 0,
  );
  if (payable.length === 0) return { charged: 0, amountMicros: 0 };

  const byOrganization = new Map<string, StoredUsageRecord[]>();
  for (const record of payable) {
    const held = byOrganization.get(record.organizationId);
    if (held === undefined) byOrganization.set(record.organizationId, [record]);
    else held.push(record);
  }

  let charged = 0;
  let amountMicros = 0;
  for (const [organizationId, theirs] of byOrganization) {
    // A record can arrive for a customer nobody has asked a money question
    // about yet, so the account is opened here on the same terms it is opened
    // anywhere else — with its welcome credit, once.
    await openBillingAccount(organizationId);

    const written = await fencedDatabase().transaction(async (tx) => {
      const rows = await tx
        .insert(cloudLedgerEntry)
        .values(
          theirs.map((record) => ({
            id: newId("cle"),
            organizationId,
            kind: "inference_charge" as const,
            // Signed: a charge takes away.
            amountMicros: -record.amountMicros,
            referenceKind: "usage_record" as const,
            referenceId: record.id,
            usageRecordId: record.id,
            idempotencyKey: inferenceChargeKey(record.id),
            occurredAt: record.occurredAt,
          })),
        )
        .onConflictDoNothing({ target: cloudLedgerEntry.idempotencyKey })
        .returning({ amountMicros: cloudLedgerEntry.amountMicros });
      if (rows.length === 0) return { rows: 0, micros: 0 };

      const movement = rows.reduce((all, row) => all + row.amountMicros, 0);
      await tx
        .update(cloudBillingAccount)
        .set({
          balanceMicros: sql`${cloudBillingAccount.balanceMicros} + ${movement}`,
          updatedAt: new Date(),
        })
        .where(eq(cloudBillingAccount.organizationId, organizationId));
      return { rows: rows.length, micros: -movement };
    });

    charged += written.rows;
    amountMicros += written.micros;
  }

  return { charged, amountMicros };
}

/**
 * How many uncharged records one pass of the sweep reads, and how many passes
 * one sweep makes.
 *
 * A bound rather than a limit on what is owed, exactly as the meter job's
 * catch-up is bounded: what a sweep does not reach is still uncharged when the
 * next one runs an hour later, and the oldest debt is always collected first.
 * Ten thousand records a sweep is more than an outage of a whole day leaves
 * behind on a deployment of this size, and a pass that reads a short page
 * stops the sweep there.
 */
export const MOST_RECORDS_SWEPT_AT_ONCE = 500;
const MOST_PASSES_IN_ONE_SWEEP = 20;

/** What one sweep found and what it charged. */
export type SweptUsage = {
  /** Stored records Egma's key paid for that carried no charge. */
  readonly found: number;
  /** How many of them became a ledger row. A race charges the rest. */
  readonly charged: number;
  /** What those rows came to, in millionths of a US dollar, as a positive sum. */
  readonly amountMicros: number;
};

/**
 * Charge the balance for every stored record that never reached the sink.
 *
 * **The sink is allowed to fail, so somebody has to come back for the money.**
 * A usage record is a durable row before any adapter sees it, and a sink that
 * throws must never fail that write — so a billing fault loses a delivery, and
 * a resend cannot replace it: the store collapses a redelivered measurement on
 * its deterministic identity and hands the sink nothing. Without this the
 * organization keeps a balance it has already spent, quietly, for ever. This
 * is the half that makes "it can be rebuilt from `usage_record`" true rather
 * than intended.
 *
 * **What it looks for is a record with no charge**, found by the left join
 * onto the ledger row that names it. Only Egma's own key is anybody's bill —
 * a record the customer's provider key paid for costs this balance nothing —
 * and a record that cost nothing is not a movement, so both are passed over
 * here for the same reasons `chargeForStoredUsage` passes over them.
 *
 * **It charges through that one path and nowhere else**, so there is no second
 * opinion about what a charge is. Charging twice is impossible whatever else
 * is happening: the row's idempotency key is derived from the usage record, so
 * a delivery still in flight and this sweep write the same key and the unique
 * index keeps one of them. That is also why no record has to be old enough to
 * be safe to sweep.
 *
 * **It takes no `AuthContext` and can be given no customer.** It walks the
 * deployment's own unpaid records, which is what a catch-up is; the lint rule
 * names it beside the two ports for the same reason.
 */
export async function sweepUnchargedUsage(): Promise<SweptUsage> {
  let found = 0;
  let charged = 0;
  let amountMicros = 0;

  for (let pass = 0; pass < MOST_PASSES_IN_ONE_SWEEP; pass += 1) {
    const rows = await fencedDatabase()
      .select({
        id: usageRecord.id,
        organizationId: usageRecord.organizationId,
        projectId: usageRecord.projectId,
        occurredAt: usageRecord.occurredAt,
        provider: usageRecord.provider,
        model: usageRecord.model,
        amountMicros: usageRecord.amountMicros,
      })
      .from(usageRecord)
      .leftJoin(
        cloudLedgerEntry,
        and(
          eq(cloudLedgerEntry.usageRecordId, usageRecord.id),
          eq(cloudLedgerEntry.kind, "inference_charge"),
        ),
      )
      .where(
        and(
          eq(usageRecord.paymentSource, "platform"),
          gt(usageRecord.amountMicros, 0),
          isNull(cloudLedgerEntry.id),
        ),
      )
      // Oldest first, so a sweep that does not reach the end of the backlog
      // has collected the oldest debt rather than an arbitrary slice of it.
      .orderBy(asc(usageRecord.occurredAt))
      .limit(MOST_RECORDS_SWEPT_AT_ONCE);
    if (rows.length === 0) break;

    found += rows.length;
    const written = await chargeForStoredUsage(
      // The payment source is not read back off the row: the query above is
      // what pinned it, and every record here is one Egma's own key paid for.
      rows.map((row) => ({ ...row, paymentSource: "platform" as const })),
    );
    charged += written.charged;
    amountMicros += written.amountMicros;
    if (rows.length < MOST_RECORDS_SWEPT_AT_ONCE) break;
  }

  return { found, charged, amountMicros };
}

/**
 * The balance as the ledger states it, summed from the rows.
 *
 * The account's own `balance_micros` is what every decision reads, because a
 * decision on the request path may not sum a customer's whole history. This is
 * what proves that cache: one read, taken by the test that asserts the two
 * agree and by the nightly job that will.
 */
export async function readLedgerBalance(
  auth: AuthContext,
): Promise<number> {
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

/** One model's charge against the balance this period. */
export type PeriodCharge = {
  readonly provider: string;
  readonly model: string;
  readonly requests: number;
  readonly amountMicros: number;
};

/**
 * What this period charged the balance, by provider and model.
 *
 * **Only what Egma's key paid for**, because that is what a charge is: a
 * request the customer's own key paid for cost this balance nothing and
 * appears on the usage page rather than here.
 *
 * Internal to this package: the permission that gates it is asked once, by
 * `readBillingOverview`, which is where the person is.
 */
export async function periodChargesOf(
  organizationId: string,
  period: AllowancePeriod,
): Promise<readonly PeriodCharge[]> {
  const rows = await fencedDatabase()
    .select({
      provider: usageRecord.provider,
      model: usageRecord.model,
      requests: sql<string>`count(*)`,
      amountMicros: sum(usageRecord.amountMicros),
    })
    .from(usageRecord)
    .where(
      and(
        eq(usageRecord.organizationId, organizationId),
        eq(usageRecord.paymentSource, "platform"),
        gte(usageRecord.occurredAt, period.startedAt),
        lt(usageRecord.occurredAt, period.resetsAt),
      ),
    )
    .groupBy(usageRecord.provider, usageRecord.model);

  return rows
    .map((row) => ({
      provider: row.provider,
      model: row.model,
      requests: Number(row.requests),
      amountMicros: Number(row.amountMicros ?? 0),
    }))
    .sort(
      (left, right) =>
        right.amountMicros - left.amountMicros ||
        `${left.provider}/${left.model}`.localeCompare(
          `${right.provider}/${right.model}`,
        ),
    );
}
