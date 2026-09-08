import { createHash } from "node:crypto";

import { fencedDatabase, schema, voiceSecondsSelection } from "@egma/db";
import { and, eq, gte, lt } from "drizzle-orm";

import type { MeteredHour } from "../stripe/facts.ts";
import {
  periodOverageCents,
  type FinalizedPeriodEvidence,
  type PendingLateInvoice,
} from "../stripe/late-facts.ts";
import type { MeterAccount, MeterPeriodFact } from "./meter.ts";

const { cloudMeterPeriod, simulation } = schema;
function key(account: MeterAccount, period: MeterPeriodFact) {
  return and(
    eq(cloudMeterPeriod.organizationId, account.organizationId),
    eq(cloudMeterPeriod.stripeSubscriptionId, period.stripeSubscriptionId),
    eq(cloudMeterPeriod.periodStartedAt, period.periodStartedAt),
    eq(cloudMeterPeriod.periodEndsAt, period.periodEndsAt),
    eq(cloudMeterPeriod.channel, period.channel),
  );
}
function pending(
  row: typeof cloudMeterPeriod.$inferSelect,
): PendingLateInvoice | null {
  if (row.latePendingIdentifier === null) return null;
  if (
    row.latePendingThroughSeconds === null ||
    row.latePendingAmountCents === null
  )
    throw new Error("incomplete later invoice obligation");
  return {
    identifier: row.latePendingIdentifier,
    throughSeconds: row.latePendingThroughSeconds,
    amountCents: row.latePendingAmountCents,
    invoiceCreateStartedAt: row.lateInvoiceCreateStartedAt,
    invoiceId: row.lateInvoiceId,
    itemCreateStartedAt: row.lateItemCreateStartedAt,
    invoiceItemId: row.lateInvoiceItemId,
  };
}
const CLEAR = {
  latePendingIdentifier: null,
  latePendingThroughSeconds: null,
  latePendingAmountCents: null,
  lateInvoiceCreateStartedAt: null,
  lateInvoiceId: null,
  lateItemCreateStartedAt: null,
  lateInvoiceItemId: null,
};

export function lateInvoiceProgress(account: MeterAccount) {
  return {
    async hasLateUsage(period: MeterPeriodFact): Promise<boolean> {
      const [row] = await fencedDatabase()
        .select()
        .from(cloudMeterPeriod)
        .where(key(account, period));
      return (
        row !== undefined &&
        (row.lastObservedSeconds > row.lateObservedSeconds ||
          row.latePendingIdentifier !== null ||
          row.pendingIdentifier !== null)
      );
    },
    async late(
      period: MeterPeriodFact,
      evidence: FinalizedPeriodEvidence,
      hour: MeteredHour,
      at: Date,
    ): Promise<PendingLateInvoice | null> {
      if (period.acceptingUsage || period.invoiceId !== evidence.invoiceId)
        throw new Error("later recovery needs the original finalized invoice");
      return fencedDatabase().transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(key(account, period))
          .for("update");
        if (row === undefined)
          throw new Error("later recovery lost its meter period");
        const held = pending(row);
        if (held !== null) return held;
        const [total] = await tx
          .select(voiceSecondsSelection())
          .from(simulation)
          .where(
            and(
              eq(simulation.organizationId, account.organizationId),
              gte(
                simulation.startedAt,
                new Date(
                  Math.max(
                    account.activatedAt.getTime(),
                    period.periodStartedAt.getTime(),
                  ),
                ),
              ),
              lt(simulation.startedAt, period.periodEndsAt),
              lt(simulation.startedAt, hour.endedAt),
            ),
          );
        const seconds = Number(
          period.channel === "phone_minutes"
            ? (total?.phoneSeconds ?? 0)
            : (total?.webCallSeconds ?? 0),
        );
        if (
          seconds <
          Math.max(
            row.lastObservedSeconds,
            row.lateObservedSeconds,
            evidence.invoicedSeconds,
          )
        )
          throw new Error(
            "original-period usage is below its recorded invoice evidence",
          );
        const totalCents = periodOverageCents(
          seconds,
          evidence.includedSeconds,
          evidence.centsPerMinute,
        );
        const amountCents =
          totalCents - evidence.invoicedCents - row.lateInvoicedCents;
        if (amountCents < 0)
          throw new Error(
            "original-period invoices exceed its known normal charge",
          );
        // The finalized invoice establishes whether a pending meter quantity was billed.
        const observed = {
          lastObservedSeconds: seconds,
          observedThroughHour: hour.startedAt,
          uncertainSeconds: row.uncertainSeconds + (row.pendingSeconds ?? 0),
          pendingIdentifier: null,
          pendingSeconds: null,
          pendingValue: null,
          pendingTimestamp: null,
          pendingHour: null,
          pendingFirstSentAt: null,
          updatedAt: at,
        };
        if (amountCents === 0) {
          await tx
            .update(cloudMeterPeriod)
            .set({
              ...observed,
              lateObservedSeconds: seconds,
              observedThroughHour: hour.startedAt,
              state: "closed",
            })
            .where(key(account, period));
          return null;
        }
        const identifier = createHash("sha256")
          .update(
            [
              account.organizationId,
              period.stripeSubscriptionId,
              period.periodStartedAt.toISOString(),
              period.periodEndsAt.toISOString(),
              period.channel,
              "late",
              row.lateInvoicedCents,
              totalCents,
            ].join(":"),
          )
          .digest("hex");
        const [written] = await tx
          .update(cloudMeterPeriod)
          .set({
            ...observed,
            latePendingIdentifier: identifier,
            latePendingThroughSeconds: seconds,
            latePendingAmountCents: amountCents,
            state: "needs_attention",
          })
          .where(key(account, period))
          .returning();
        if (written === undefined)
          throw new Error("later invoice obligation disappeared");
        return pending(written);
      });
    },
    async lateWriteStarted(
      period: MeterPeriodFact,
      identifier: string,
      kind: "invoice" | "item",
      at: Date,
    ): Promise<PendingLateInvoice> {
      return fencedDatabase().transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(key(account, period))
          .for("update");
        if (row?.latePendingIdentifier !== identifier)
          throw new Error("later invoice identity changed");
        const [written] = await tx
          .update(cloudMeterPeriod)
          .set(
            kind === "invoice"
              ? {
                  lateInvoiceCreateStartedAt:
                    row.lateInvoiceCreateStartedAt ?? at,
                  updatedAt: at,
                }
              : {
                  lateItemCreateStartedAt: row.lateItemCreateStartedAt ?? at,
                  updatedAt: at,
                },
          )
          .where(key(account, period))
          .returning();
        const result = written === undefined ? null : pending(written);
        if (result === null)
          throw new Error("later invoice pending state disappeared");
        return result;
      });
    },
    async lateResource(
      period: MeterPeriodFact,
      identifier: string,
      kind: "invoice" | "item",
      resourceId: string,
      at: Date,
    ): Promise<void> {
      if (resourceId.trim() === "")
        throw new Error("empty Stripe recovery resource");
      await fencedDatabase().transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(key(account, period))
          .for("update");
        if (row?.latePendingIdentifier !== identifier)
          throw new Error("later invoice identity changed");
        const previous =
          kind === "invoice" ? row.lateInvoiceId : row.lateInvoiceItemId;
        if (previous !== null && previous !== resourceId)
          throw new Error(
            "multiple Stripe resources for one later invoice obligation",
          );
        await tx
          .update(cloudMeterPeriod)
          .set(
            kind === "invoice"
              ? { lateInvoiceId: resourceId, updatedAt: at }
              : { lateInvoiceItemId: resourceId, updatedAt: at },
          )
          .where(key(account, period));
      });
    },
    async finishLate(
      period: MeterPeriodFact,
      identifier: string,
      at: Date,
    ): Promise<void> {
      await fencedDatabase().transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(key(account, period))
          .for("update");
        if (row?.latePendingIdentifier !== identifier) return;
        if (
          row.lateInvoiceId === null ||
          row.lateInvoiceItemId === null ||
          row.latePendingAmountCents === null ||
          row.latePendingThroughSeconds === null
        )
          throw new Error("later invoice is not durably identified");
        await tx
          .update(cloudMeterPeriod)
          .set({
            ...CLEAR,
            lateInvoicedCents:
              row.lateInvoicedCents + row.latePendingAmountCents,
            lateObservedSeconds: row.latePendingThroughSeconds,
            state: "closed",
            updatedAt: at,
          })
          .where(key(account, period));
      });
    },
  };
}
