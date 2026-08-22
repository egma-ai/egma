import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
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
 * remains is machinery: one notebook per pulled agent, one receipt book for
 * every production conversation, and one poison-call record. See ADR-0015.
 */

/** The fixed scan a pulled agent is currently completing. */
export const MONITORING_SCAN_KINDS = [
  "historical_import",
  "regular",
  "reconciliation",
] as const;
export type MonitoringScanKind = (typeof MONITORING_SCAN_KINDS)[number];

/** The cross-store write has either been taken or completed. */
export const PRODUCTION_CLAIM_STATUSES = ["claimed", "written"] as const;
export type ProductionClaimStatus = (typeof PRODUCTION_CLAIM_STATUSES)[number];

/** A permanent per-call import failure can later be replayed explicitly. */
export const MONITORING_FAILURE_STATUSES = ["open", "resolved"] as const;
export type MonitoringFailureStatus =
  (typeof MONITORING_FAILURE_STATUSES)[number];

/**
 * One agent's poller notebook — machine-owned, platform-neutral, and never
 * edited by a person.
 *
 * The row is created by the pull switch and, in v1, only by it; turning the
 * switch off leaves the row where it is so a re-enable resumes from the cursor
 * it already reached. Cursors are opaque text and windows are generic
 * moments, so a later Vapi or ElevenLabs pull reuses the table unchanged.
 *
 * `consecutive_failures` is a retry clock, not a health surface: it pushes
 * `next_poll_at` out and nothing reads it on a screen. There is no
 * account-wide gate, because there is no account-wide anything — a shared key
 * that starts refusing is discovered independently by each agent's poller.
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
    /** A paused daily re-walk keeps its exact fixed window while regular polling runs. */
    reconciliationFrom: moment("reconciliation_from"),
    reconciliationThrough: moment("reconciliation_through"),
    reconciliationPaginationKey: text("reconciliation_pagination_key"),
    reconciliationPaginationTrail: text("reconciliation_pagination_trail")
      .notNull()
      .default("[]"),
    /** A bounded re-walk slice must yield to one current scan. */
    reconciliationNeedsRegular: boolean("reconciliation_needs_regular")
      .notNull()
      .default(false),
    /** Upper bound of the last completed import or regular scan. */
    completedThrough: moment("completed_through"),
    /** Regular polling has its own cadence; the re-walk cannot move it. */
    nextRegularPollAt: moment("next_regular_poll_at").notNull(),
    /** The next scheduler wake for either regular or re-walk work. */
    nextPollAt: moment("next_poll_at").notNull(),
    nextReconciliationAt: moment("next_reconciliation_at").notNull(),
    /** One DB-backed owner prevents duplicate provider reads across API replicas. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: moment("lease_expires_at"),
    /** The retry clock: how far `next_poll_at` is pushed out. Never a screen. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Stamped as pulled calls arrive. */
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
      "monitoring_state_reconciliation_agrees",
      sql`(${table.reconciliationFrom} is null and ${table.reconciliationThrough} is null and ${table.reconciliationPaginationKey} is null and ${table.reconciliationNeedsRegular} = false) or (${table.reconciliationFrom} is not null and ${table.reconciliationThrough} is not null)`,
    ),
    check(
      "monitoring_state_lease_agrees",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    // One notebook per agent, and the switch is what creates it.
    unique("monitoring_state_agent_unique").on(table.agentId),
    // Failure rows repeat the tenant facts, so they can prove that their agent
    // belongs to the same project and organization.
    unique("monitoring_state_id_tenant_unique").on(
      table.id,
      table.projectId,
      table.organizationId,
    ),
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
 * Durable production call identity and cross-store recovery point.
 *
 * The unique product promise is one visible historical-import trace per
 * `(project, provider call id)`. It does not depend on a setup row, an agent
 * row, a key, a page, or a simulation connection — which is what makes a
 * destructive redesign of everything around it safe for stored conversations.
 */
export const productionTraceClaim = pgTable(
  "production_trace_claim",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    traceId: text("trace_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    platformAgentId: text("platform_agent_id").notNull(),
    platformAgentName: text("platform_agent_name"),
    platformAgentVersion: text("platform_agent_version"),
    /**
     * The pulling agent's id beside the safe Retell document, with
     * bearer-like fields removed. The id is in here rather than in a
     * column of its own because this table references nothing — which is
     * what makes it survive a redesign — and crash recovery still has to
     * stamp the notebook of the agent that actually pulled the call.
     */
    payload: text("payload").notNull(),
    endedAt: moment("ended_at").notNull(),
    degraded: boolean("degraded").notNull().default(false),
    status: text("status").notNull(),
    claimedAt: moment("claimed_at").notNull(),
    writtenAt: moment("written_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("production_trace_claim_id_prefix", table.id, "ptc"),
    oneOf("production_trace_claim_status_allowed", table.status, [
      ...PRODUCTION_CLAIM_STATUSES,
    ]),
    unique("production_trace_claim_project_call_unique").on(
      table.projectId,
      table.providerCallId,
    ),
    unique("production_trace_claim_trace_id_unique").on(table.traceId),
    check(
      "production_trace_claim_written_agrees",
      sql`(${table.status} = 'written') = (${table.writtenAt} is not null)`,
    ),
    foreignKey({
      name: "production_trace_claim_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("production_trace_claim_unwritten_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'claimed'`),
  ],
);

/**
 * A safe record of one call that bounded retries could not import.
 *
 * Without it the cursor either stalls forever on one broken document or steps
 * over a production conversation with no record of having done so. Pull-only
 * today; named for the mechanism family rather than for Retell, so a future
 * push-side failure record has a lawful home.
 */
export const monitoringFailure = pgTable(
  "monitoring_failure",
  {
    id: idText("id").primaryKey(),
    agentId: idText("agent_id").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    /** Stable low-cardinality class, never the provider's message or body. */
    errorKind: text("error_kind").notNull(),
    /** A sanitized list summary when one exists; never credentials. */
    payload: text("payload"),
    attempts: integer("attempts").notNull().default(1),
    status: text("status").notNull().default("open"),
    lastAttemptAt: moment("last_attempt_at").notNull(),
    /** A short lease for one explicit replay request. */
    replayLeaseOwner: text("replay_lease_owner"),
    replayLeaseExpiresAt: moment("replay_lease_expires_at"),
    resolvedAt: moment("resolved_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("monitoring_failure_id_prefix", table.id, "mnf"),
    oneOf("monitoring_failure_status_allowed", table.status, [
      ...MONITORING_FAILURE_STATUSES,
    ]),
    unique("monitoring_failure_project_call_unique").on(
      table.projectId,
      table.providerCallId,
    ),
    check(
      "monitoring_failure_resolved_agrees",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} is not null)`,
    ),
    check(
      "monitoring_failure_replay_lease_agrees",
      sql`(${table.replayLeaseOwner} is null) = (${table.replayLeaseExpiresAt} is null)`,
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
    index("monitoring_failure_open_idx")
      .on(table.agentId, table.lastAttemptAt)
      .where(sql`${table.status} = 'open'`),
  ],
);
