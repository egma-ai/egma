import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { USAGE_TYPES, USAGE_UNITS } from "../models/rate-card.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * Measuring what Egma's work costs, and pricing it. Both tables are the
 * product's, on every deployment: a self-hoster and a customer on their own
 * provider keys see their spend from these two rows and nothing else.
 *
 * Neither table knows anything about who pays. That is the cloud's question
 * and it lives in the cloud's own tables, which reference these and are
 * referenced by nothing here.
 */

/** How a quantity was learnt: the provider said so, or Egma counted it. */
export const USAGE_MEASUREMENTS = ["provider_reported", "client_measured"] as const;
export type UsageMeasurement = (typeof USAGE_MEASUREMENTS)[number];

/**
 * Whose key paid for the request.
 *
 * `platform` is the deployment's own key — a self-hoster's operator key and
 * Egma Cloud's key are both the platform's, and telling them apart is the
 * cloud adapter's business rather than this column's. `customer` is an
 * organization's own key, which nothing sets yet: the field exists so the
 * record already says which it was on the day one arrives, instead of a
 * migration having to guess for every row written before it.
 */
export const USAGE_PAYMENT_SOURCES = ["platform", "customer"] as const;
export type UsagePaymentSource = (typeof USAGE_PAYMENT_SOURCES)[number];

/** Which of Egma's two kinds of work made the request. */
export const USAGE_WORK_KINDS = ["simulation", "grading"] as const;
export type UsageWorkKind = (typeof USAGE_WORK_KINDS)[number];

/**
 * One price for one usage type of one model, from one date.
 *
 * **Append-only, and the boot upsert is the only writer.** A price change is a
 * new row with a later `effective_from`; the old row stays, because a usage
 * record cites the row that priced it and a past simulation's cost may never
 * move. Rating picks the newest row effective at or before the usage's own
 * instant, which is Langfuse's `startDate` rule under Egma's own words.
 */
export const rateCard = pgTable(
  "rate_card",
  {
    id: idText("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    usageType: text("usage_type").notNull(),
    unit: text("unit").notNull(),
    /**
     * US dollars per 1,000,000 of the unit. `numeric` rather than a float:
     * a sixtieth of a cent per second does not terminate in binary, and a
     * price that drifted in the eleventh place would drift the same way on
     * every record ever rated against it.
     */
    usdPerMillion: numeric("usd_per_million", {
      precision: 24,
      scale: 12,
    }).notNull(),
    effectiveFrom: moment("effective_from").notNull(),
    /** The provider page the number was read from, and the day it was read. */
    source: text("source").notNull(),
    readAt: text("read_at").notNull(),
    /** Why this number is what it is, where a reader would otherwise ask. */
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("rate_card_id_prefix", table.id, "rat"),
    oneOf("rate_card_usage_type_allowed", table.usageType, [...USAGE_TYPES]),
    oneOf("rate_card_unit_allowed", table.unit, [...USAGE_UNITS]),
    check(
      "rate_card_price_is_not_negative",
      sql`${table.usdPerMillion} >= 0`,
    ),
    // The identity of a price: one model's one usage type from one date. It is
    // what makes the boot upsert idempotent, and what makes a second edit of a
    // shipped price impossible to write as anything but a new date.
    unique("rate_card_price_identity_unique").on(
      table.provider,
      table.model,
      table.usageType,
      table.effectiveFrom,
    ),
    // Rating's own shape: this model's prices, newest effective first.
    index("rate_card_effective_idx").on(
      table.provider,
      table.model,
      table.effectiveFrom,
    ),
  ],
);

