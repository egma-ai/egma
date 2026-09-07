import { createHash } from "node:crypto";

import { fencedDatabase, schema, voiceSecondsSelection } from "@egma/db";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import {
  hourAround,
  minuteValueAdded,
  type MeteredHour,
  type StripeCustomerFacts,
} from "../stripe/facts.ts";

import { markStripeCustomerFailed, reconcileStripeAccount } from "./stripe.ts";

const { cloudBillingAccount, cloudMeterPeriod, cloudPlan, simulation } = schema;
const HOUR = 3_600_000;
export const METER_TIMESTAMP_WINDOW_DAYS = 35;
export const MOST_HOURS_CAUGHT_UP_AT_ONCE = 48;

export type MeterAccount = {
  readonly organizationId: string;
  readonly activatedAt: Date;
  readonly stripeCustomerId: string;
  readonly webCallMeterId: string | null;
  readonly phoneMeterId: string | null;
};
export type MeterPeriodFact = {
  readonly stripeSubscriptionId: string;
  readonly periodStartedAt: Date;
  readonly periodEndsAt: Date;
  readonly channel: schema.MeterChannel;
  readonly meterId: string;
  readonly eventName: string;
  readonly priceId: string;
  readonly invoiceId: string | null;
  readonly acceptingUsage: boolean;
};
export type PendingMeterReport = {
  readonly period: MeterPeriodFact;
  readonly identifier: string;
  readonly seconds: number;
  readonly value: string;
  readonly timestamp: Date;
  readonly hour: Date;
  readonly firstSentAt: Date;
};
export type NextMeterReport =
  | { readonly kind: "idle" }
  | { readonly kind: "advanced" }
  | {
      readonly kind: "attention";
      readonly reason: "invoice_closed" | "timestamp_expired";
      readonly seconds: number;
    }
  | { readonly kind: "send"; readonly report: PendingMeterReport };
export type MeterProgress = {
  failureVersion(): Promise<number>;
  reconcile(
    read: (
      customerId: string,
      needsHobbyTransition: boolean,
    ) => Promise<StripeCustomerFacts>,
    at: Date,
  ): Promise<void>;
  failed(): Promise<void>;
  recovered(version: number, latestClosedHour: MeteredHour, at: Date): Promise<boolean>;
  periods(): Promise<MeterPeriodFact[]>;
  next(
    period: MeterPeriodFact,
    latestClosedHour: MeteredHour,
    at: Date,
  ): Promise<NextMeterReport>;
  finish(
    report: PendingMeterReport,
    outcome: "accepted" | "duplicate" | "uncertain",
    at: Date,
  ): Promise<void>;
};

/** The timer owns this sweep; callers cannot choose an organization. */
export async function visitMeterAccounts(
  visit: (account: MeterAccount, progress: MeterProgress) => Promise<void>,
  failed: (account: MeterAccount, fault: unknown) => void,
): Promise<void> {
  const accounts = await fencedDatabase()
    .select({
      organizationId: cloudBillingAccount.organizationId,
      activatedAt: cloudBillingAccount.activatedAt,
      stripeCustomerId: cloudBillingAccount.stripeCustomerId,
      webCallMeterId: cloudPlan.stripeWebCallMeterId,
      phoneMeterId: cloudPlan.stripePhoneMeterId,
    })
    .from(cloudBillingAccount)
    .innerJoin(cloudPlan, eq(cloudPlan.code, "pro"))
    .where(isNotNull(cloudBillingAccount.stripeCustomerId));
  for (const row of accounts) {
    if (row.stripeCustomerId === null) continue;
    const account: MeterAccount = {
      ...row,
      stripeCustomerId: row.stripeCustomerId,
    };
    try {
      await fencedDatabase().transaction(async (lock) => {
        await lock.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`egma:stripe-meter:${account.stripeCustomerId}`}::text, 0))`,
        );
        // Progress writes use separate transactions, committed before network sends.
        await visit(account, progressFor(account));
      });
    } catch (fault) {
      await markStripeCustomerFailed(account.stripeCustomerId).catch(
        (healthFault: unknown) => {
          console.error(
            "Stripe failure health could not be persisted",
            healthFault,
          );
        },
      );
      failed(account, fault);
    }
  }
}

function keyOf(account: MeterAccount, period: MeterPeriodFact) {
  return and(
    eq(cloudMeterPeriod.organizationId, account.organizationId),
    eq(cloudMeterPeriod.stripeSubscriptionId, period.stripeSubscriptionId),
    eq(cloudMeterPeriod.periodStartedAt, period.periodStartedAt),
    eq(cloudMeterPeriod.periodEndsAt, period.periodEndsAt),
    eq(cloudMeterPeriod.channel, period.channel),
  );
}

function progressFor(account: MeterAccount): MeterProgress {
  let reconciled = false;
  return {
    async failureVersion() {
      const [row] = await fencedDatabase()
        .select({ version: cloudBillingAccount.stripeFailureVersion })
        .from(cloudBillingAccount)
        .where(eq(cloudBillingAccount.organizationId, account.organizationId));
      if (row === undefined)
        throw new Error("Stripe reconciliation lost its billing account");
      return row.version;
    },
    async reconcile(read, at) {
      await reconcileStripeAccount(account.stripeCustomerId, read, at);
      reconciled = true;
    },
    async failed() {
      await markStripeCustomerFailed(account.stripeCustomerId);
    },
    async recovered(version, latestClosedHour, at) {
      if (!reconciled) return false;
      return fencedDatabase().transaction(async (tx) => {
        const unresolved = await tx
          .select({ channel: cloudMeterPeriod.channel })
          .from(cloudMeterPeriod)
          .where(
            and(
              eq(cloudMeterPeriod.organizationId, account.organizationId),
              sql`(${cloudMeterPeriod.pendingIdentifier} is not null or ${cloudMeterPeriod.state} = 'needs_attention' or ${cloudMeterPeriod.uncertainSeconds} > 0 or (greatest(${cloudMeterPeriod.periodStartedAt}, ${account.activatedAt}::timestamptz) < ${latestClosedHour.endedAt}::timestamptz and (${cloudMeterPeriod.observedThroughHour} is null or ${cloudMeterPeriod.observedThroughHour} < ${latestClosedHour.startedAt}::timestamptz)))`,
            ),
          )
          .limit(1);
        if (unresolved.length > 0) return false;
        const recovered = await tx
          .update(cloudBillingAccount)
          .set({ stripeFailedAt: null, updatedAt: at })
          .where(
            and(
              eq(cloudBillingAccount.organizationId, account.organizationId),
              eq(cloudBillingAccount.stripeFailureVersion, version),
            ),
          )
          .returning({ id: cloudBillingAccount.id });
        return recovered.length === 1;
      });
    },
    async periods() {
      const rows = await fencedDatabase()
        .select()
        .from(cloudMeterPeriod)
        .where(eq(cloudMeterPeriod.organizationId, account.organizationId));
      return rows.map((row) => ({
        stripeSubscriptionId: row.stripeSubscriptionId,
        periodStartedAt: row.periodStartedAt,
        periodEndsAt: row.periodEndsAt,
        channel: row.channel,
        meterId: row.meterId,
        eventName: row.eventName,
        priceId: row.priceId,
        invoiceId: row.invoiceId,
        acceptingUsage: false,
      }));
    },
    async next(period, latestClosedHour, at) {
      return fencedDatabase().transaction(async (tx) => {
        await tx
          .insert(cloudMeterPeriod)
          .values({
            organizationId: account.organizationId,
            stripeCustomerId: account.stripeCustomerId,
            stripeSubscriptionId: period.stripeSubscriptionId,
            periodStartedAt: period.periodStartedAt,
            periodEndsAt: period.periodEndsAt,
            channel: period.channel,
            meterId: period.meterId,
            eventName: period.eventName,
            priceId: period.priceId,
            invoiceId: period.invoiceId,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(keyOf(account, period))
          .for("update");
        if (row === undefined)
          throw new Error("meter period disappeared while preparing usage");
        if (
          row.meterId !== period.meterId ||
          row.eventName !== period.eventName ||
          row.priceId !== period.priceId
        ) {
          throw new Error(
            "Stripe changed the collection objects of an existing meter period",
          );
        }
        if (period.invoiceId !== null && period.invoiceId !== row.invoiceId) {
          await tx
            .update(cloudMeterPeriod)
            .set({ invoiceId: period.invoiceId, updatedAt: at })
            .where(keyOf(account, period));
        }
        if (
          row.pendingIdentifier !== null &&
          row.pendingSeconds !== null &&
          row.pendingValue !== null &&
          row.pendingTimestamp !== null &&
          row.pendingHour !== null &&
          row.pendingFirstSentAt !== null
        ) {
          if (!period.acceptingUsage) {
            await tx
              .update(cloudMeterPeriod)
              .set({
                state: "needs_attention",
                lastOutcome: "invoice_closed",
                updatedAt: at,
              })
              .where(keyOf(account, period));
          }
          return {
            kind: "send",
            report: {
              period,
              identifier: row.pendingIdentifier,
              seconds: row.pendingSeconds,
              value: row.pendingValue,
              timestamp: row.pendingTimestamp,
              hour: row.pendingHour,
              firstSentAt: row.pendingFirstSentAt,
            },
          };
        }
        const floor = new Date(
          Math.max(
            account.activatedAt.getTime(),
            period.periodStartedAt.getTime(),
          ),
        );
        let hour =
          row.observedThroughHour === null
            ? hourAround(floor).startedAt
            : new Date(row.observedThroughHour.getTime() + HOUR);
        if (hour > latestClosedHour.startedAt) return { kind: "idle" };
        // Once the period ended, only newly visible completions can change its total.
        if (hour >= period.periodEndsAt) hour = latestClosedHour.startedAt;
        const [totals] = await tx
          .select(voiceSecondsSelection())
          .from(simulation)
          .where(
            and(
              eq(simulation.organizationId, account.organizationId),
              gte(simulation.startedAt, floor),
              lt(simulation.startedAt, period.periodEndsAt),
              lt(simulation.startedAt, new Date(hour.getTime() + HOUR)),
            ),
          );
        const seconds = Number(
          period.channel === "phone_minutes"
            ? (totals?.phoneSeconds ?? 0)
            : (totals?.webCallSeconds ?? 0),
        );
        const offset = row.acceptedSeconds + row.uncertainSeconds;
        const value = minuteValueAdded(offset, seconds);
        const delta = seconds - offset;
        await tx
          .update(cloudMeterPeriod)
          .set({
            lastObservedSeconds: seconds,
            invoiceId: period.invoiceId ?? row.invoiceId,
            updatedAt: at,
          })
          .where(keyOf(account, period));
        if (delta === 0) {
          await tx
            .update(cloudMeterPeriod)
            .set({
              observedThroughHour: hour,
              state: period.acceptingUsage ? "open" : "closed",
            })
            .where(keyOf(account, period));
          return { kind: "advanced" };
        }
        const timestamp = new Date(
          Math.min(
            Math.max(hour.getTime(), period.periodStartedAt.getTime()),
            period.periodEndsAt.getTime() - 1_000,
          ),
        );
        const reason = !period.acceptingUsage
          ? "invoice_closed"
          : timestamp.getTime() <
              at.getTime() - METER_TIMESTAMP_WINDOW_DAYS * 24 * HOUR
            ? "timestamp_expired"
            : undefined;
        if (reason !== undefined) {
          // Known usage remains outstanding until the late-invoice policy is settled.
          await tx
            .update(cloudMeterPeriod)
            .set({ state: "needs_attention", lastOutcome: reason })
            .where(keyOf(account, period));
          return { kind: "attention", reason, seconds: delta };
        }
        const identifier = createHash("sha256")
          .update(
            [
              account.organizationId,
              period.stripeSubscriptionId,
              period.periodStartedAt.toISOString(),
              period.periodEndsAt.toISOString(),
              period.channel,
              hour.toISOString(),
            ].join(":"),
          )
          .digest("hex");
        await tx
          .update(cloudMeterPeriod)
          .set({
            pendingIdentifier: identifier,
            pendingSeconds: delta,
            pendingValue: value,
            pendingTimestamp: timestamp,
            pendingHour: hour,
            pendingFirstSentAt: at,
            state: "open",
            updatedAt: at,
          })
          .where(keyOf(account, period));
        return {
          kind: "send",
          report: {
            period,
            identifier,
            seconds: delta,
            value,
            timestamp,
            hour,
            firstSentAt: at,
          },
        };
      });
    },
    async finish(report, outcome, at) {
      await fencedDatabase().transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(cloudMeterPeriod)
          .where(keyOf(account, report.period))
          .for("update");
        if (row === undefined || row.pendingIdentifier !== report.identifier)
          return;
        if (row.pendingSeconds === null || row.pendingHour === null)
          throw new Error("incomplete frozen meter report");
        await tx
          .update(cloudMeterPeriod)
          .set({
            acceptedSeconds:
              row.acceptedSeconds +
              (outcome === "uncertain" ? 0 : row.pendingSeconds),
            uncertainSeconds:
              row.uncertainSeconds +
              (outcome === "uncertain" ? row.pendingSeconds : 0),
            observedThroughHour: row.pendingHour,
            pendingIdentifier: null,
            pendingSeconds: null,
            pendingValue: null,
            pendingTimestamp: null,
            pendingHour: null,
            pendingFirstSentAt: null,
            state: report.period.acceptingUsage ? "open" : "closed",
            lastOutcome: outcome,
            updatedAt: at,
          })
          .where(keyOf(account, report.period));
      });
    },
  };
}
