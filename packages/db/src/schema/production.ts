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
 * Production evidence reaches egma through exactly two mechanism families, and
 * only one of them is configured.
 *
 * **Pull** is declared: an agent binds to its platform, holds that platform's
 * sealed monitoring key, and its `pull_production_calls` switch turns polling
 * on. **Push** is observed: the customer's own process sends spans to the OTLP
 * door with the project key, and the stored evidence is the whole record —
 * nothing is configured, nothing is stamped, and nobody can know in advance
 * when a customer starts.
 *
 * So there is no monitoring setup object here and no health surface. What
 * remains is machinery, and only for pull: one notebook per pulled agent, and
 * one short-lived retry record per call that could not be turned into
 * evidence. There is no receipt book — once a call arrives it belongs to the
 * ingestion boundary: write-ahead log, object store, drainer, and exactly-once
 * by committed span identity. See ADR-0014 and ADR-0015.
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
 * One agent's poller notebook — machine-owned, platform-neutral, and never
 * edited by a person.
 *
 * The row is created by the pull switch and, in v1, only by it; turning the
 * switch off leaves the row where it is, and turning it on again is a new
 * observation of the provider from that moment — a fresh `import_generation`
 * and a `regular_floor_at` at the switch, never a backfill of what happened
 * while it was off. The deep historical import runs once, on an agent's first
 * ever switch-on. Cursors are opaque text and windows are generic moments, so
 * a later Vapi or ElevenLabs pull reuses the table unchanged.
 *
 * The failure columns are a retry clock, not a health surface: they push
 * `next_poll_at` out and nothing reads them on a screen. There is no
 * account-wide gate, because there is no account-wide anything — a shared key
 * that starts refusing is discovered independently by each agent's poller, and
 * each backs off on its own.
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
     * The earliest instant a regular scan may look back to, while it is set.
     *
     * A regular window normally starts five minutes before the last completed
     * upper bound, so a call the provider exposes a little late is still found.
     * A floor overrides that subtraction, which is what a resume needs: the
     * first window after the switch comes on must not reach behind it and
     * import the conversations that happened while it was off. It is cleared
     * once a window has completed above it, and the overlap resumes.
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
 * One Retell call egma could not turn into evidence, and nothing else.
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
 * A marker expires on its own once the call is outside every regular overlap
 * window, and deleting the agent takes its rows with it. There is no replay
 * door and no failure list: giving up is one structured event and one
 * low-cardinality metric, and the product surface says nothing about it.
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
