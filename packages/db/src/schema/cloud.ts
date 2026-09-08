import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { createdAt, idText, moment, nonEmpty, oneOf, prefixCheck, updatedAt } from "./columns.ts";
import { organization } from "./tenancy.ts";



/** The plans Egma Cloud sells. Two rows at launch. */
export const PLAN_CODES = ["hobby", "pro"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];


export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** What moved an inference balance. */
export const LEDGER_ENTRY_KINDS = [
  "welcome_credit",
  "purchased_credit",
  "inference_charge",
  "correction",
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** What caused a movement, by the kind of thing it names. */
export const LEDGER_REFERENCE_KINDS = [
  "organization",
  "settlement_interval",
  "checkout_session",
  "operator",
] as const;
export type LedgerReferenceKind = (typeof LEDGER_REFERENCE_KINDS)[number];


export const cloudPlan = pgTable(
  "cloud_plan",
  {
    id: idText("id").primaryKey(),
    /** `hobby` or `pro`. What an account names, and what a page prints. */
    code: text("code").notNull(),
    /** What the plan is called on a page. */
    name: text("name").notNull(),
    /** The monthly fee in millionths of a US dollar. Hobby is 0. */
    feeMicros: bigint("fee_micros", { mode: "number" }).notNull(),
    /** Chat simulations a month. `null` is unlimited. */
    chatSimulationsAllowance: bigint("chat_simulations_allowance", {
      mode: "number",
    }),
    /** Web-call minutes a month. `null` is unlimited. */
    webCallMinutesAllowance: bigint("web_call_minutes_allowance", {
      mode: "number",
    }),
    /** Phone minutes a month. `null` is unlimited. */
    phoneMinutesAllowance: bigint("phone_minutes_allowance", {
      mode: "number",
    }),

    webCallOverageMicrosPerMinute: bigint("web_call_overage_micros_per_minute", {
      mode: "number",
    }).notNull(),
    phoneOverageMicrosPerMinute: bigint("phone_overage_micros_per_minute", {
      mode: "number",
    }).notNull(),

    stripeProductId: text("stripe_product_id"),
    stripeFeePriceId: text("stripe_fee_price_id"),
    stripeWebCallMeterPriceId: text("stripe_web_call_meter_price_id"),
    stripePhoneMeterPriceId: text("stripe_phone_meter_price_id"),
    stripeWebCallMeterId: text("stripe_web_call_meter_id"),
    stripePhoneMeterId: text("stripe_phone_meter_id"),
    billingActivatedAt: moment("billing_activated_at"),
    /** The Hobby row holds deployment-wide payment readiness. */
    stripePaymentsReady: boolean("stripe_payments_ready").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("cloud_plan_id_prefix", table.id, "cpl"),
    oneOf("cloud_plan_code_allowed", table.code, [...PLAN_CODES]),
    nonEmpty("cloud_plan_name_is_not_blank", table.name),
    check("cloud_plan_fee_is_not_negative", sql`${table.feeMicros} >= 0`),
    check(
      "cloud_plan_allowances_are_not_negative",
      sql`coalesce(${table.chatSimulationsAllowance}, 0) >= 0
        and coalesce(${table.webCallMinutesAllowance}, 0) >= 0
        and coalesce(${table.phoneMinutesAllowance}, 0) >= 0`,
    ),
    check(
      "cloud_plan_overage_prices_are_not_negative",
      sql`${table.webCallOverageMicrosPerMinute} >= 0
        and ${table.phoneOverageMicrosPerMinute} >= 0`,
    ),
    // The identity of a plan, and what an account names. It is what makes the
    // boot seed idempotent.
    unique("cloud_plan_code_unique").on(table.code),
  ],
);


export const cloudBillingAccount = pgTable(
  "cloud_billing_account",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    planCode: text("plan_code").notNull(),

    periodAnchor: moment("period_anchor").notNull(),
    /** What Stripe holds, once it holds anything. Hobby never has any of it. */
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionStatus: text("stripe_subscription_status"),
    /** Last successful canonical subscription refresh; never an ordering gate. */
    stripeSubscriptionRefreshedAt: moment("stripe_subscription_refreshed_at"),
    stripePeriodStartedAt: moment("stripe_period_started_at"),
    stripePeriodEndsAt: moment("stripe_period_ends_at"),
    /** Scheduled Pro end from the current Stripe subscription, cleared on undo. */
    stripeCancelAt: moment("stripe_cancel_at"),
    stripeFailedAt: moment("stripe_failed_at"),
    stripeFailureVersion: bigint("stripe_failure_version", { mode: "number" }).notNull().default(0),
    /** Usage before this immutable boundary is excluded. */
    activatedAt: moment("activated_at").notNull(),
    inferenceSettledThrough: moment("inference_settled_through"),
    settlementFailedAt: moment("settlement_failed_at"),
    /**
     * The inference balance in millionths of a US dollar, as a materialised
     * sum of the ledger. Signed: see the note above.
     */
    balanceMicros: bigint("balance_micros", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("cloud_billing_account_id_prefix", table.id, "cba"),
    oneOf("cloud_billing_account_plan_code_allowed", table.planCode, [
      ...PLAN_CODES,
    ]),
    check("cloud_billing_account_stripe_failure_version_is_exact", sql`${table.stripeFailureVersion} >= 0 and ${table.stripeFailureVersion} <= 9007199254740991`),
    check(
      "cloud_billing_account_subscription_status_allowed",
      sql`${table.stripeSubscriptionStatus} is null
        or ${table.stripeSubscriptionStatus} in ${sql.raw(
          `(${SUBSCRIPTION_STATUSES.map((status) => `'${status}'`).join(", ")})`,
        )}`,
    ),
    // A subscription is Stripe's, so it cannot exist without the customer it
    // belongs to. Hobby has neither and that is the ordinary case.
    check(
      "cloud_billing_account_subscription_needs_a_customer",
      sql`${table.stripeSubscriptionId} is null
        or ${table.stripeCustomerId} is not null`,
    ),
    check(
      "cloud_billing_account_subscription_status_needs_a_subscription",
      sql`${table.stripeSubscriptionStatus} is null
        or ${table.stripeSubscriptionId} is not null`,
    ),
    // One account per organization. The whole of what makes a second welcome
    // credit impossible, and the row the ledger's own key hangs off.
    unique("cloud_billing_account_organization_unique").on(table.organizationId),
    // A Stripe customer belongs to one organization, so a webhook naming one
    // can never be applied to two accounts.
    unique("cloud_billing_account_stripe_customer_unique").on(
      table.stripeCustomerId,
    ),
    unique("cloud_billing_account_stripe_subscription_unique").on(
      table.stripeSubscriptionId,
    ),
    // The plan is a row, so a plan code no plan defines cannot be written.
    foreignKey({
      name: "cloud_billing_account_plan_fk",
      columns: [table.planCode],
      foreignColumns: [cloudPlan.code],
    }),
  ],
);


export const cloudLedgerEntry = pgTable(
  "cloud_ledger_entry",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id").notNull(),
    kind: text("kind").notNull(),
    /**
     * The movement in millionths of a US dollar, signed: positive adds to the
     * balance, negative takes from it.
     */
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    referenceKind: text("reference_kind").notNull(),
    /** The identifier of the thing that caused it, in that kind's own words. */
    referenceId: text("reference_id").notNull(),
    intervalStartedAt: moment("interval_started_at"),
    intervalEndedAt: moment("interval_ended_at"),
    /** What makes this movement happen at most once. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** When the movement happened, off the fact rather than off the write. */
    occurredAt: moment("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("cloud_ledger_entry_id_prefix", table.id, "cle"),
    oneOf("cloud_ledger_entry_kind_allowed", table.kind, [
      ...LEDGER_ENTRY_KINDS,
    ]),
    oneOf("cloud_ledger_entry_reference_kind_allowed", table.referenceKind, [
      ...LEDGER_REFERENCE_KINDS,
    ]),
    nonEmpty("cloud_ledger_entry_reference_id_is_not_blank", table.referenceId),
    nonEmpty(
      "cloud_ledger_entry_idempotency_key_is_not_blank",
      table.idempotencyKey,
    ),
    // A kind names one kind of cause. An operator's correction is the one that
    // can name anything, which is what a correction is for.
    check(
      "cloud_ledger_entry_kind_names_its_cause",
      sql`case ${table.kind}
        when 'welcome_credit' then ${table.referenceKind} = 'organization'
        when 'purchased_credit' then ${table.referenceKind} = 'checkout_session'
        when 'inference_charge' then ${table.referenceKind} = 'settlement_interval'
        else true
      end`,
    ),
    check(
      "cloud_ledger_entry_interval_matches_kind",
      sql`case when ${table.kind} = 'inference_charge'
        then ${table.intervalStartedAt} is not null and ${table.intervalEndedAt} is not null
          and ${table.intervalStartedAt} < ${table.intervalEndedAt}
        else ${table.intervalStartedAt} is null and ${table.intervalEndedAt} is null end`,
    ),
    unique("cloud_ledger_entry_organization_interval_unique").on(
      table.organizationId, table.intervalStartedAt, table.intervalEndedAt,
    ),
    // A credit adds and a charge takes away. A movement of nothing is not a
    // movement, so zero is refused for both.
    check(
      "cloud_ledger_entry_sign_follows_its_kind",
      sql`case ${table.kind}
        when 'welcome_credit' then ${table.amountMicros} > 0
        when 'purchased_credit' then ${table.amountMicros} > 0
        when 'inference_charge' then ${table.amountMicros} < 0
        else ${table.amountMicros} <> 0
      end`,
    ),
    // The permanent index that makes a replay a no-op.
    unique("cloud_ledger_entry_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    // Every entry belongs to an account, and the account belongs to an
    // organization — so an entry cannot exist for a customer with no account,
    // and deleting an organization takes the account and the ledger with it.
    foreignKey({
      name: "cloud_ledger_entry_account_fk",
      columns: [table.organizationId],
      foreignColumns: [cloudBillingAccount.organizationId],
    }).onDelete("cascade"),
    // The balance read's own shape: one customer's rows, newest last.
    index("cloud_ledger_entry_organization_idx").on(
      table.organizationId,
      table.id,
    ),
  ],
);
