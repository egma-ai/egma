import { sql } from "drizzle-orm";
import { bigint, check, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { createdAt, idText, moment, nonEmpty, oneOf, updatedAt } from "./columns.ts";
import { organization } from "./tenancy.ts";

export const METER_CHANNELS = ["web_call_minutes", "phone_minutes"] as const;
export type MeterChannel = (typeof METER_CHANNELS)[number];

/** One channel's collection progress in one Stripe service period. */
export const cloudMeterPeriod = pgTable(
  "cloud_meter_period",
  {
    organizationId: idText("organization_id").notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    periodStartedAt: moment("period_started_at").notNull(),
    periodEndsAt: moment("period_ends_at").notNull(),
    channel: text("channel").$type<MeterChannel>().notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    meterId: text("meter_id").notNull(),
    eventName: text("event_name").notNull(),
    priceId: text("price_id").notNull(),
    invoiceId: text("invoice_id"),
    observedThroughHour: moment("observed_through_hour"),
    acceptedSeconds: bigint("accepted_seconds", { mode: "number" }).notNull().default(0),
    uncertainSeconds: bigint("uncertain_seconds", { mode: "number" }).notNull().default(0),
    lastObservedSeconds: bigint("last_observed_seconds", { mode: "number" }).notNull().default(0),
    // Freeze these fields before sending; a retry never changes the payload.
    pendingIdentifier: text("pending_identifier"),
    pendingSeconds: bigint("pending_seconds", { mode: "number" }),
    pendingValue: numeric("pending_value", { precision: 30, scale: 12 }),
    pendingTimestamp: moment("pending_timestamp"),
    pendingHour: moment("pending_hour"),
    pendingFirstSentAt: moment("pending_first_sent_at"),
    lateInvoicedCents: bigint("late_invoiced_cents", { mode: "number" }).notNull().default(0),
    lateObservedSeconds: bigint("late_observed_seconds", { mode: "number" }).notNull().default(0),
    latePendingIdentifier: text("late_pending_identifier"),
    latePendingThroughSeconds: bigint("late_pending_through_seconds", { mode: "number" }),
    latePendingAmountCents: bigint("late_pending_amount_cents", { mode: "number" }),
    lateInvoiceCreateStartedAt: moment("late_invoice_create_started_at"),
    lateInvoiceId: text("late_invoice_id"),
    lateItemCreateStartedAt: moment("late_item_create_started_at"),
    lateInvoiceItemId: text("late_invoice_item_id"),
    state: text("state").$type<"open" | "needs_attention" | "closed">().notNull().default("open"),
    lastOutcome: text("last_outcome").$type<
      "accepted" | "duplicate" | "uncertain" | "invoice_closed" | "timestamp_expired"
    >(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ name: "cloud_meter_period_pk", columns: [
      table.organizationId, table.stripeSubscriptionId,
      table.periodStartedAt, table.periodEndsAt, table.channel,
    ] }),
    oneOf("cloud_meter_period_channel_allowed", table.channel, [...METER_CHANNELS]),
    oneOf("cloud_meter_period_state_allowed", table.state, ["open", "needs_attention", "closed"]),
    check("cloud_meter_period_outcome_allowed", sql`${table.lastOutcome} is null or ${table.lastOutcome} in ('accepted', 'duplicate', 'uncertain', 'invoice_closed', 'timestamp_expired')`),
    nonEmpty("cloud_meter_period_subscription_not_blank", table.stripeSubscriptionId),
    nonEmpty("cloud_meter_period_customer_not_blank", table.stripeCustomerId),
    nonEmpty("cloud_meter_period_meter_not_blank", table.meterId),
    nonEmpty("cloud_meter_period_event_not_blank", table.eventName),
    nonEmpty("cloud_meter_period_price_not_blank", table.priceId),
    check("cloud_meter_period_bounds", sql`${table.periodEndsAt} > ${table.periodStartedAt}`),
    check("cloud_meter_period_seconds_counted", sql`
      ${table.acceptedSeconds} between 0 and 9007199254740991
      and ${table.uncertainSeconds} between 0 and 9007199254740991
      and ${table.lastObservedSeconds} between 0 and 9007199254740991
    `),
    check("cloud_meter_period_pending_complete", sql`
      num_nonnulls(${table.pendingIdentifier}, ${table.pendingSeconds}, ${table.pendingValue},
        ${table.pendingTimestamp}, ${table.pendingHour}, ${table.pendingFirstSentAt}) in (0, 6)
    `),
    check("cloud_meter_period_late_counted", sql`
      ${table.lateInvoicedCents} between 0 and 9007199254740991
      and ${table.lateObservedSeconds} between 0 and 9007199254740991
    `),
    check("cloud_meter_period_late_pending_complete", sql`
      num_nonnulls(${table.latePendingIdentifier}, ${table.latePendingThroughSeconds}, ${table.latePendingAmountCents}) in (0, 3)
      and (${table.latePendingIdentifier} is not null or num_nonnulls(${table.lateInvoiceCreateStartedAt}, ${table.lateInvoiceId}, ${table.lateItemCreateStartedAt}, ${table.lateInvoiceItemId}) = 0)
    `),
    check("cloud_meter_period_late_pending_valid", sql`${table.latePendingIdentifier} is null or (
      btrim(${table.latePendingIdentifier}) <> ''
      and ${table.latePendingThroughSeconds} between 1 and 9007199254740991
      and ${table.latePendingAmountCents} between 1 and 9007199254740991
      and (${table.lateInvoiceId} is null or (${table.lateInvoiceCreateStartedAt} is not null and btrim(${table.lateInvoiceId}) <> ''))
      and (${table.lateItemCreateStartedAt} is null or ${table.lateInvoiceId} is not null)
      and (${table.lateInvoiceItemId} is null or (${table.lateItemCreateStartedAt} is not null and btrim(${table.lateInvoiceItemId}) <> ''))
    )`),
    check("cloud_meter_period_pending_valid", sql`${table.pendingIdentifier} is null or (
      btrim(${table.pendingIdentifier}) <> ''
      and ${table.pendingSeconds} between 1 and 9007199254740991
      and ${table.pendingValue} > 0
      and ${table.pendingTimestamp} >= ${table.periodStartedAt}
      and ${table.pendingTimestamp} < ${table.periodEndsAt}
    )`),
  ],
);
