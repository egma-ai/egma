import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { agent } from "./agents.ts";
import { organization, project } from "./tenancy.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * Pull monitoring uses an agent platform credential and the pull switch.
 * Push ingestion accepts customer spans through OTLP with a project key.
 * These tables track pull progress and failed imports; span storage and
 * deduplication belong to ingestion. See ADR-0014 and ADR-0015.
 */

/**
 * The fixed scan a pulled agent is currently completing.
 *
 * Two, and there is no third. An import is the deliberate deep read a customer
 * asks for the first time they turn the switch on; a regular poll is the
 * shallow one that keeps up. Anything else would be egma reading a customer's
 * provider history on its own schedule, which is exactly the cost this design
 * removes.
 */
export const MONITORING_SCAN_KINDS = ["historical_import", "regular"] as const;
export type MonitoringScanKind = (typeof MONITORING_SCAN_KINDS)[number];

/**
 * Per-agent pull progress. First enablement starts a historical import; later
 * enablement starts a new generation with a floor at that time, excluding
 * the disabled period. Disabling pull retains this row.
 * Failure fields schedule per-agent backoff; they are not product health status.
 */
export const monitoringState = pgTable(
  "monitoring_state",
  {
    id: idText("id").primaryKey(),
    /** One row per agent: the primary key of the thing being polled. */
    agentId: idText("agent_id").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /** The fixed provider window and opaque page cursor currently in flight. */
    scanKind: text("scan_kind"),
    scanFrom: moment("scan_from"),
    scanThrough: moment("scan_through"),
    paginationKey: text("pagination_key"),
    /** Every opaque cursor already followed in this fixed scan. */
    paginationTrail: text("pagination_trail").notNull().default("[]"),
    /** Upper bound of the last completed import or regular scan. */
    completedThrough: moment("completed_through"),
    /**
     * The one scheduler wake: a yielded scan resumed, the next regular poll,
     * and provider backoff are the same fact — when this agent may be read
     * again — and one column is the only way they cannot disagree. A refused
     * key parks it far out; turning the switch on again is what wakes it.
     */
    nextPollAt: moment("next_poll_at").notNull(),
    /**
     * Prevents the regular overlap window from reaching into a disabled period.
     * Cleared after a window completes above the floor.
     */
    regularFloorAt: moment("regular_floor_at"),
    /**
     * Which observation this agent's transient call state belongs to.
     *
     * Turning the switch on again is a new observation of the provider and
     * starts a new generation. It is what lets a fresh start take its own
     * bounded look at a call an earlier regular scan gave up on, without
     * letting an ordinary repeated poll do the same.
     */
    importGeneration: integer("import_generation").notNull().default(1),
    /** One DB-backed owner prevents duplicate provider reads across API replicas. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: moment("lease_expires_at"),
    /** The retry clock: how far `next_poll_at` is pushed out. Never a screen. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** When the current run of failures began, so one log line can measure it. */
    failureStartedAt: moment("failure_started_at"),
    /**
     * The class of the last provider refusal, and the reason a lesser failure
     * cannot shorten a longer park: a refused key stays parked until the
     * customer acts, whatever a rate limit says afterwards. Null once the
     * provider answers again.
     */
    lastErrorKind: text("last_error_kind"),
    lastErrorAt: moment("last_error_at"),
    lastSuccessAt: moment("last_success_at"),
    /** Stamped as pulled calls arrive. The one thing a screen may show. */
    lastReceivedAt: moment("last_received_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("monitoring_state_id_prefix", table.id, "mst"),
    oneOf("monitoring_state_scan_kind_allowed", table.scanKind, [
      ...MONITORING_SCAN_KINDS,
    ]),
    check(
      "monitoring_state_scan_agrees",
      sql`(${table.scanKind} is null and ${table.scanFrom} is null and ${table.scanThrough} is null and ${table.paginationKey} is null) or (${table.scanKind} is not null and ${table.scanFrom} is not null and ${table.scanThrough} is not null)`,
    ),
    check(
      "monitoring_state_lease_agrees",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    // One notebook per agent, and the switch is what creates it.
    unique("monitoring_state_agent_unique").on(table.agentId),
    foreignKey({
      name: "monitoring_state_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "monitoring_state_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    index("monitoring_state_due_idx").on(
      table.nextPollAt,
      table.leaseExpiresAt,
    ),
    index("monitoring_state_project_idx").on(table.projectId),
  ],
);

/**
 * Retry state for a Retell import that failed; stores identity, not payload.
 * An active retry has next_attempt_at. An exhausted retry has expires_at
 * instead, preventing overlap scans from starting another retry budget.
 * Expired markers can be swept after the call leaves the overlap window.
 * Deleting the agent cascades to these rows.
 */
export const retellCallRetry = pgTable(
  "retell_call_retry",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /** The pulled agent the call belongs to — the key the notebook uses too. */
    agentId: idText("agent_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    /** Stable low-cardinality class, never the provider's message or body. */
    errorKind: text("error_kind").notNull(),
    /** One initial attempt plus at most three automatic retries. */
    attempts: smallint("attempts").notNull().default(1),
    lastAttemptAt: moment("last_attempt_at").notNull(),
    /** Set while retries remain. Null on a marker, which schedules nothing. */
    nextAttemptAt: moment("next_attempt_at"),
    /** Set on a marker alone, and the reason it cannot outlive its purpose. */
    expiresAt: moment("expires_at"),
    /** The observation generation this row was created under. */
    importGeneration: integer("import_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("retell_call_retry_id_prefix", table.id, "rcr"),
    unique("retell_call_retry_project_call_unique").on(
      table.projectId,
      table.providerCallId,
    ),
    check(
      "retell_call_retry_one_schedule",
      sql`(${table.nextAttemptAt} is null) <> (${table.expiresAt} is null)`,
    ),
    check(
      "retell_call_retry_attempts_bounded",
      sql`${table.attempts} between 1 and 4`,
    ),
    foreignKey({
      name: "retell_call_retry_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "retell_call_retry_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // The batched page lookup reads `(project_id, provider_call_id)`, and the
    // unique constraint above already builds exactly that btree. A second
    // index on the same pair would be one more thing every retry write has to
    // maintain and nothing at all to read from.
    index("retell_call_retry_due_idx")
      .on(table.agentId, table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} is not null`),
  ],
);
