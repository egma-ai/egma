import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { MODEL_ADAPTERS, MODEL_PROVIDERS } from "../models/catalog.ts";
import { USAGE_TYPES, USAGE_UNITS } from "../models/rate-card.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";
import { run, simulation } from "./runs.ts";
import { organization, project } from "./tenancy.ts";

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

/**
 * One provider request Egma made, measured in the unit the provider bills and
 * priced at the moment it is stored.
 *
 * **The identity is deterministic and is not the primary key.** Egma's
 * identifiers are prefixed and time-sortable, which a hash is not — so the row
 * keeps an ordinary `usg_` identity and carries the deterministic identity
 * beside it in `dedupe_key`, unique, written with `on conflict do nothing`. A
 * write-ahead log replaying the same bytes collapses onto the one row; a
 * re-executed simulation mints new span ids, so it is new spend, correctly.
 *
 * **There is no foreign key to the grading job**, and that is deliberate: a
 * successful grading job's row is deleted once its grades are durable, and a
 * key would either take the usage record with it or refuse the delete. The
 * simulation is different — it is kept — so that key is closed the usual way.
 */
export const usageRecord = pgTable(
  "usage_record",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /** When the provider answered, off the evidence rather than off the write. */
    occurredAt: moment("occurred_at").notNull(),
    /** The run this work belonged to. Null for production grading, which has none. */
    runId: idText("run_id"),
    workKind: text("work_kind").notNull(),
    simulationId: idText("simulation_id"),
    /**
     * The grading job, by id and by id alone. Deliberately un-keyed: the row it
     * names is deleted the moment its grades are durable.
     */
    gradingJobId: idText("grading_job_id"),
    /**
     * Which attempt of the work made the request: the grading job's own retry
     * counter, and zero for a simulation, whose re-execution is a new
     * simulation rather than another attempt at this one.
     */
    attempt: bigint("attempt", { mode: "number" }).notNull().default(0),
    /** The trace and the span this request happened inside, where there is one. */
    traceId: text("trace_id"),
    spanId: text("span_id"),
    provider: text("provider").notNull(),
    /** The provider's own model string, as the request named it. */
    model: text("model").notNull(),
    /**
     * Which provider protocol was spoken, in the executable catalog's own
     * adapter words — so there is no second vocabulary for the same fact.
     */
    operation: text("operation").notNull(),
    unit: text("unit").notNull(),
    /** The normalised quantities, keyed by usage type. */
    quantities: jsonb("quantities")
      .$type<Readonly<Record<string, number>>>()
      .notNull(),
    measurement: text("measurement").notNull(),
    /** The provider's own reference for the request, where it gives one. */
    providerRef: text("provider_ref"),
    paymentSource: text("payment_source").notNull(),
    /** Which key paid, where a deployment holds more than one. Null today. */
    credentialRef: text("credential_ref"),
    /**
     * The provider's usage object, verbatim. Kept so a wrong normalisation can
     * be re-rated later instead of re-measured, and so a check against the
     * providers' own reports stays possible. `{}` where Egma counted the
     * quantity itself and the provider returned no usage at all.
     */
    rawUsage: jsonb("raw_usage")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    /**
     * What this request cost, in millionths of a US dollar, worked out at the
     * write. Integer because money is counted, never measured; the rounding is
     * to the nearest micro-dollar and happens once, here.
     */
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    /**
     * The exact rate-card rows that priced it, keyed by usage type — so a
     * reader can see which price applied to which quantity, and a price change
     * can be told from a measurement change.
     */
    pricedBy: jsonb("priced_by")
      .$type<Readonly<Record<string, string>>>()
      .notNull(),
    /** The deterministic identity. A resend collapses here and nowhere else. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("usage_record_id_prefix", table.id, "usg"),
    oneOf("usage_record_work_kind_allowed", table.workKind, [
      ...USAGE_WORK_KINDS,
    ]),
    oneOf("usage_record_provider_allowed", table.provider, [
      ...MODEL_PROVIDERS,
    ]),
    oneOf("usage_record_operation_allowed", table.operation, [
      ...MODEL_ADAPTERS,
    ]),
    oneOf("usage_record_unit_allowed", table.unit, [...USAGE_UNITS]),
    oneOf("usage_record_measurement_allowed", table.measurement, [
      ...USAGE_MEASUREMENTS,
    ]),
    oneOf("usage_record_payment_source_allowed", table.paymentSource, [
      ...USAGE_PAYMENT_SOURCES,
    ]),
    // Which work made the request decides which control record it names. A
    // simulation's own request names its simulation; a grading job's names its
    // job, and its simulation too when it graded one.
    check(
      "usage_record_work_kind_names_its_control_record",
      sql`case ${table.workKind}
        when 'simulation' then ${table.simulationId} is not null and ${table.gradingJobId} is null
        when 'grading' then ${table.gradingJobId} is not null
        else false
      end`,
    ),
    check(
      "usage_record_attempt_is_counted",
      sql`${table.attempt} >= 0`,
    ),
    check(
      "usage_record_amount_is_not_negative",
      sql`${table.amountMicros} >= 0`,
    ),
    check(
      "usage_record_quantities_are_an_object",
      sql`jsonb_typeof(${table.quantities}) = 'object'
        and ${table.quantities} <> '{}'::jsonb`,
    ),
    check(
      "usage_record_raw_usage_is_an_object",
      sql`jsonb_typeof(${table.rawUsage}) = 'object'`,
    ),
    check(
      "usage_record_priced_by_is_an_object",
      sql`jsonb_typeof(${table.pricedBy}) = 'object'`,
    ),
    check(
      "usage_record_dedupe_key_is_not_blank",
      sql`btrim(${table.dedupeKey}) <> ''`,
    ),
    // A resend collapses here. Nothing else in this table is unique, and
    // nothing else needs to be.
    unique("usage_record_dedupe_key_unique").on(table.dedupeKey),
    // The tenancy triangle's one edge this table has: the project is of the
    // organization the row names, held by the database rather than by care.
    foreignKey({
      name: "usage_record_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // And the simulation it belongs to is that project's own, so no raw write
    // can file one customer's spend under another's conversation.
    foreignKey({
      name: "usage_record_simulation_project_fk",
      columns: [table.simulationId, table.projectId],
      foreignColumns: [simulation.id, simulation.projectId],
    }).onDelete("cascade"),
    // The run edge, closed the same way. A composite key with a nullable
    // column matches nothing when the column is null, which is exactly the
    // behaviour a grading job on a production trace needs: it names no run,
    // and the key lets it, while a record that *does* name one can only name
    // its own project's.
    foreignKey({
      name: "usage_record_run_project_fk",
      columns: [table.runId, table.projectId],
      foreignColumns: [run.id, run.projectId],
    }).onDelete("cascade"),
    index("usage_record_organization_id_project_id_idx").on(
      table.organizationId,
      table.projectId,
    ),
    // The simulation page's own read: one conversation's spend.
    index("usage_record_simulation_id_idx").on(table.simulationId),
  ],
);
