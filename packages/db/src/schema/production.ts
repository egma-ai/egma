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
 * The fixed scan a monitored agent is currently completing.
 *
 * Two, and there is no third. An import is the deliberate deep read a customer
 * asks for by turning the switch on; a regular poll is the shallow one that
 * keeps up. Anything else would be Egma reading a customer's provider history
 * on its own schedule, which is exactly the cost this design removes.
 */
export const MONITORING_SCAN_KINDS = ["historical_import", "regular"] as const;
export type MonitoringScanKind = (typeof MONITORING_SCAN_KINDS)[number];

/**
 * One agent's polling notebook: what the poller needs and nothing a person
 * edits.
 *
 * **Machine-owned, and platform-neutral on purpose.** Cursors are opaque text
 * and windows are generic instants, so a second platform's pull reuses this
 * table unchanged. The name is mechanism-neutral for the same reason: push
 * bookkeeping, if it is ever wanted, has a lawful home here instead of a
 * second table beside it.
 *
 * **Keyed by the agent, one row per agent, created by the pull switch alone.**
 * There is no health surface: `consecutive_failures` is a retry clock that
 * pushes `next_poll_at` out, read by the poller and shown to nobody. Turning
 * the switch off stops the polling and leaves the row, so turning it back on
 * resumes from where the cursor stood rather than re-reading a customer's
 * history.
 */
export const monitoringState = pgTable(
  "monitoring_state",
  {
    agentId: idText("agent_id")
      .primaryKey()
      .references(() => agent.id, { onDelete: "cascade" }),
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
     * again — and one column is the only way they cannot disagree.
     */
    nextPollAt: moment("next_poll_at").notNull(),
    /**
     * Which explicit import this agent's transient call state belongs to.
     *
     * Turning the switch on again is a new observation of the provider's
     * history and starts a new generation. It is what lets a fresh import take
     * its own bounded look at a call an earlier regular scan gave up on,
     * without letting an ordinary repeated poll do the same.
     */
    importGeneration: integer("import_generation").notNull().default(1),
    /** One DB-backed owner prevents duplicate provider reads across replicas. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: moment("lease_expires_at"),
    /** A retry clock, never a health surface: it pushes `next_poll_at` out. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Stamped as this agent's pulled calls become readable evidence. */
    lastReceivedAt: moment("last_received_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("monitoring_state_agent_id_prefix", table.agentId, "agt"),
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
    // Repeated so the failure row's composite foreign key can prove that the
    // agent it names belongs to the same project and organization.
    unique("monitoring_state_agent_id_project_id_unique").on(
      table.agentId,
      table.projectId,
    ),
    foreignKey({
      name: "monitoring_state_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // The tenancy triangle, exactly as a connection closes it: this row cannot
    // name one project and another project's agent.
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
 * One production call Egma could not turn into evidence, and nothing else.
 *
 * **Short-lived control state, never a payload archive.** A call whose fetch or
 * normalization failed leaves an identity and a bounded budget here — never the
 * provider's document, never a transcript, never a receipt. A call that lands
 * leaves no row at all: Postgres growth follows failures, not conversations.
 *
 * **One table for two shapes, because it is one row changing state.** While
 * automatic retries remain, `next_attempt_at` says when the next one is due.
 * When the budget ends the same row loses that time and gains `expires_at`,
 * becoming a marker that schedules nothing. It exists then for one reason: the
 * regular five-minute overlap lists the same provider call again, and without a
 * trace of the terminal drop that repeat would silently start a second budget.
 * Exactly one of the two instants is set, and the check makes the other shape
 * unwritable rather than merely unusual.
 *
 * Pull-only today, and named neutrally so a future push-side failure record has
 * a lawful home. A marker expires on its own once the call is outside every
 * regular overlap window, and deleting the agent takes its rows with it.
 */
export const monitoringFailure = pgTable(
  "monitoring_failure",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
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
    /** The import generation this row was created under. */
    importGeneration: integer("import_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("monitoring_failure_id_prefix", table.id, "mnf"),
    unique("monitoring_failure_project_call_unique").on(
      table.projectId,
      table.providerCallId,
    ),
    check(
      "monitoring_failure_one_schedule",
      sql`(${table.nextAttemptAt} is null) <> (${table.expiresAt} is null)`,
    ),
    check(
      "monitoring_failure_attempts_bounded",
      sql`${table.attempts} between 1 and 4`,
    ),
    foreignKey({
      name: "monitoring_failure_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "monitoring_failure_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // The batched page lookup reads `(project_id, provider_call_id)`, and the
    // unique constraint above already builds exactly that btree. A second
    // index on the same pair would be one more thing every retry write has to
    // maintain and nothing at all to read from.
    index("monitoring_failure_due_idx")
      .on(table.agentId, table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} is not null`),
  ],
);
