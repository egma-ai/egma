import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { createdAt, idText, moment, nonEmpty, oneOf, prefixCheck, updatedAt } from "./columns.ts";
import { usageRecord } from "./billing.ts";
import { organization } from "./tenancy.ts";

/**
 * What Egma Cloud keeps about money. Four tables, every one of them `cloud_`.
 *
 * **They are in the shared migration tree and read by no shared code.** One
 * schema serves every deployment, so a self-hoster carries these four tables
 * empty and dropping them can break nothing — which is the property the prefix
 * exists to make visible. They reference `organization` and `usage_record` and
 * are referenced by neither: the arrow points one way, always, so the open
 * product never depends on the cloud's rows existing.
 *
 * **Every read and write of them lives in `ee/`.** The rows are defined here
 * because a migration tree with a hole in it is not a migration tree; the
 * access functions are in the commercially licensed package, behind the same
 * `AuthContext` fence `packages/db/src/access/` sits behind. See ADR-0024.
 *
 * **Typed columns, not a JSON blob.** Six or seven fields each, with the same
 * checks every other Egma table carries. Langfuse's own cloud config is one
 * JSON column and its code shows the cost: a parse failure empties every cloud
 * field at once, and no constraint can say a plan code is one of two words.
 */

/** The plans Egma Cloud sells. Two rows at launch. */
export const PLAN_CODES = ["hobby", "pro"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/**
 * A Stripe subscription's status, in Stripe's own words.
 *
 * Kept as Stripe writes it rather than folded into Egma's own words, because
 * the webhook that writes it is copying a fact from another system and a
 * translation here would be a second opinion about somebody else's object.
 * What Egma decides from it — Pro or Hobby — is decided in `ee/`.
 */
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
  "usage_record",
  "checkout_session",
  "operator",
] as const;
export type LedgerReferenceKind = (typeof LEDGER_REFERENCE_KINDS)[number];

/**
 * One plan: its fee, its three allowances, its two overage prices, and the
 * Stripe prices that charge for them.
 *
 * **An allowance of `null` is unlimited, and that is the whole rule.** Pro's
 * chat allowance is null because a chat simulation's only marginal cost is
 * inference, which the balance or the customer's own key pays for. Zero would
 * have meant "none at all", which is the opposite, so the absence is the right
 * shape and the check below refuses a negative one either way.
 *
 * Changing a price is a row change and never a deploy: the launch values are
 * seeded from a file in `ee/` the way the rate card is seeded from its own.
 */
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
    /**
     * What one minute past the allowance costs, in millionths of a US dollar.
     *
     * Only a plan whose allowance is a number can have overage: Hobby pauses
     * instead, so its prices are zero and nothing reads them. Stripe prices
     * the tiers from the meter; these rows are what a page publishes and what
     * the Stripe prices are created from.
     */
    webCallOverageMicrosPerMinute: bigint("web_call_overage_micros_per_minute", {
      mode: "number",
    }).notNull(),
    phoneOverageMicrosPerMinute: bigint("phone_overage_micros_per_minute", {
      mode: "number",
    }).notNull(),
    /**
     * The Stripe objects this plan is sold through, once they exist.
     *
     * **Nullable, and a plan row is complete without any of them.** The
     * allowances are enforced from Egma's own rows and never from Stripe, so
     * Hobby — which has no Stripe object of any kind — leaves all six null and
     * so does a deployment whose sandbox has not been set up yet.
     *
     * They are written by the setup that creates the Stripe objects and never
     * by the boot seed, which would blank them on the next boot. The two meter
     * ids are kept beside the prices they price because a meter is found by
     * its event name and created once: Stripe's test-data deletion does not
     * remove one, so the id is the proof this deployment already has it.
     */
    stripeProductId: text("stripe_product_id"),
    stripeFeePriceId: text("stripe_fee_price_id"),
    stripeWebCallMeterPriceId: text("stripe_web_call_meter_price_id"),
    stripePhoneMeterPriceId: text("stripe_phone_meter_price_id"),
    stripeWebCallMeterId: text("stripe_web_call_meter_id"),
    stripePhoneMeterId: text("stripe_phone_meter_id"),
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

/**
 * One organization's billing account: its plan, its month, whatever Stripe
 * holds for it, and its inference balance.
 *
 * **One row per organization, held by a unique index rather than by care.**
 * The account is created lazily, on the first question anybody asks about the
 * customer's money, and two questions arriving at once must not make two
 * accounts and two welcome credits. The index is what makes the second write
 * impossible; the code around it only has to notice.
 *
 * **The balance is a cache of the ledger and says so.** It is written in the
 * same transaction as every ledger row, so the two can never be seen
 * disagreeing, and the ledger stays the source of truth: a nightly job proves
 * the sum. It is signed, because work already claimed finishes and is charged
 * — so the balance may go below zero by at most what was in flight, which the
 * founders accepted and the ten-minute simulation ceiling bounds.
 */
export const cloudBillingAccount = pgTable(
  "cloud_billing_account",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    planCode: text("plan_code").notNull(),
    /**
     * When this organization's month turns over: its creation instant on
     * Hobby, Stripe's subscription anchor on Pro. Stored rather than derived,
     * because moving to Pro moves it and the old date must not come back.
     */
    periodAnchor: moment("period_anchor").notNull(),
    /** What Stripe holds, once it holds anything. Hobby never has any of it. */
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionStatus: text("stripe_subscription_status"),
    /**
     * The inference balance in millionths of a US dollar, as a materialised
     * sum of the ledger. Signed: see the note above.
     */
    balanceMicros: bigint("balance_micros", { mode: "number" })
      .notNull()
      .default(0),
    /**
     * The start of the last hour whose overage Stripe has taken, or `null`
     * where none has been reported.
     *
     * **The mark that makes a missed hour recoverable.** The hourly job posts
     * whole minutes as the difference between two running totals, so an hour
     * that was never posted would have its minutes swallowed by the next one's
     * "before" — the arithmetic that loses nothing inside a period loses
     * everything about a gap. This says where to resume from, and it moves
     * only after Stripe has accepted an hour or refused it as one it already
     * has. A replay is safe either way: the meter event's identifier is the
     * meter, the organization and the hour.
     *
     * Hobby has none and never will; a Pro account's is set the first time the
     * job reports it, at the hour that had just closed, so moving to Pro never
     * back-bills a month that was free.
     */
    overageReportedThrough: moment("overage_reported_through"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("cloud_billing_account_id_prefix", table.id, "cba"),
    oneOf("cloud_billing_account_plan_code_allowed", table.planCode, [
      ...PLAN_CODES,
    ]),
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

/**
 * One movement of one inference balance.
 *
 * **Append-only, and a movement happens at most once because of one unique
 * index.** The idempotency key is derived from what caused the movement — the
 * organization for a welcome credit, the usage record for a charge, the
 * Checkout session for a purchase — so a replayed webhook, a redelivered
 * measurement or a second boot writes nothing rather than doubling somebody's
 * money. It is a permanent index and not a vendor's idempotency window.
 *
 * **The sign is the direction and is held by a check.** A credit adds, a
 * charge subtracts, and a correction is an operator saying which. Nothing here
 * infers a direction from a kind at read time, so a sum over the rows is the
 * balance with no case analysis anywhere.
 */
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
    /**
     * The usage record this charge is for, as a real edge into the shared
     * table rather than only as text. Null for every other kind — a credit
     * names a Checkout session Egma did not write a row for, and a welcome
     * credit names the organization.
     *
     * **The edge refuses a delete rather than following one**, which is the
     * opposite of every other key in this schema and is the point. A charge is
     * money that moved: it is summed into `balance_micros`, and a cascade that
     * quietly took the row with its usage record would leave the materialised
     * balance disagreeing with the ledger it caches, silently, for one
     * customer. Nothing in the product deletes a usage record today, so this
     * costs nothing now; the day something does, this key is what makes
     * somebody decide what happens to the charge instead of finding out later.
     */
    usageRecordId: idText("usage_record_id").references(() => usageRecord.id),
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
        when 'inference_charge' then ${table.referenceKind} = 'usage_record'
        else true
      end`,
    ),
    // The edge and the text say the same thing, so a reader can trust either.
    check(
      "cloud_ledger_entry_charge_names_its_usage_record",
      sql`case when ${table.referenceKind} = 'usage_record'
        then ${table.usageRecordId} = ${table.referenceId}
        else ${table.usageRecordId} is null
      end`,
    ),
    // A credit adds and a charge takes away. A movement of nothing is not a
    // movement, so zero is refused for both.
    check(
      "cloud_ledger_entry_sign_follows_its_kind",
      sql`case ${table.kind}
        when 'welcome_credit' then ${table.amountMicros} > 0
        when 'purchased_credit' then ${table.amountMicros} > 0
        when 'inference_charge' then ${table.amountMicros} <= 0
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

/**
 * One Stripe event Egma has already applied.
 *
 * **Stripe's own event id is the primary key**, which is the whole mechanism:
 * a redelivery inserts nothing and the handler stops. It is not an Egma
 * identifier and carries no prefix, because it is somebody else's name for
 * somebody else's object and inventing a second one would let the same event
 * be applied under two names.
 *
 * Nothing writes this row yet. It is here now because the webhook handler that
 * will is the one place a redelivery can double somebody's money, and a table
 * added in the same migration as the ledger cannot be forgotten in the release
 * that needs it.
 */
export const cloudStripeEvent = pgTable(
  "cloud_stripe_event",
  {
    /** Stripe's `evt_...`, verbatim. */
    id: text("id").primaryKey(),
    /** Stripe's own event type, e.g. `checkout.session.completed`. */
    type: text("type").notNull(),
    receivedAt: moment("received_at").notNull().defaultNow(),
  },
  (table) => [
    nonEmpty("cloud_stripe_event_id_is_not_blank", table.id),
    nonEmpty("cloud_stripe_event_type_is_not_blank", table.type),
  ],
);
