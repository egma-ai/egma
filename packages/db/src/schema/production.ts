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

import { user } from "./identity.ts";
import { organization, project } from "./tenancy.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/** Agent platforms with a customer-facing production Monitoring setup. */
export const MONITORING_PLATFORMS = ["retell", "livekit_agents"] as const;
export type MonitoringPlatform = (typeof MONITORING_PLATFORMS)[number];

/** How one platform sends production evidence to Egma. */
export const MONITORING_STRATEGIES = [
  "retell_api_polling",
  "livekit_otlp",
] as const;
export type MonitoringStrategy = (typeof MONITORING_STRATEGIES)[number];

/** A setup-wide Retell condition. Empty successful polls do not change it. */
export const MONITORING_HEALTH_STATES = [
  "healthy",
  "invalid_credential",
  "rate_limited",
  "provider_unavailable",
] as const;
export type MonitoringHealthState = (typeof MONITORING_HEALTH_STATES)[number];

/** The fixed scan a selected Retell agent is currently completing. */
export const RETELL_SCAN_KINDS = [
  "historical_import",
  "regular",
  "reconciliation",
] as const;
export type RetellScanKind = (typeof RETELL_SCAN_KINDS)[number];

/** Customer-visible progress for one selected Retell voice agent. */
export const RETELL_MONITORED_AGENT_STATES = [
  "importing",
  "active",
  "degraded",
] as const;
export type RetellMonitoredAgentState =
  (typeof RETELL_MONITORED_AGENT_STATES)[number];

/** The cross-store write has either been taken or completed. */
export const PRODUCTION_CLAIM_STATUSES = ["claimed", "written"] as const;
export type ProductionClaimStatus = (typeof PRODUCTION_CLAIM_STATUSES)[number];

/** A permanent per-call import failure can later be replayed explicitly. */
export const RETELL_FAILURE_STATUSES = ["open", "resolved"] as const;
export type RetellFailureStatus = (typeof RETELL_FAILURE_STATUSES)[number];

/**
 * Project configuration for receiving production evidence from one platform.
 *
 * This is not a simulation connection. Retell owns a sealed account key;
 * LiveKit owns no provider secret because the customer's worker pushes OTLP
 * with the existing Egma project key.
 */
export const monitoringSetup = pgTable(
  "monitoring_setup",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    agentPlatform: text("agent_platform").notNull(),
    strategy: text("strategy").notNull(),
    /** A sealed `{apiKey}` object for Retell; null for LiveKit OTLP. */
    credentials: text("credentials"),
    credentialsHint: text("credentials_hint"),
    healthState: text("health_state").notNull().default("healthy"),
    /** A key-wide Retell gate. No selected agent may bypass it. */
    blockedUntil: moment("blocked_until"),
    failureStartedAt: moment("failure_started_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastErrorAt: moment("last_error_at"),
    lastRecoveredAt: moment("last_recovered_at"),
    lastReceivedAt: moment("last_received_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("monitoring_setup_id_prefix", table.id, "mns"),
    oneOf("monitoring_setup_platform_allowed", table.agentPlatform, [
      ...MONITORING_PLATFORMS,
    ]),
    oneOf("monitoring_setup_strategy_allowed", table.strategy, [
      ...MONITORING_STRATEGIES,
    ]),
    oneOf("monitoring_setup_health_allowed", table.healthState, [
      ...MONITORING_HEALTH_STATES,
    ]),
    check(
      "monitoring_setup_credentials_hint_agrees",
      sql`(${table.credentials} is null) = (${table.credentialsHint} is null)`,
    ),
    check(
      "monitoring_setup_platform_strategy_agrees",
      sql`(${table.agentPlatform} = 'retell' and ${table.strategy} = 'retell_api_polling' and ${table.credentials} is not null) or (${table.agentPlatform} = 'livekit_agents' and ${table.strategy} = 'livekit_otlp' and ${table.credentials} is null)`,
    ),
    unique("monitoring_setup_project_platform_unique").on(
      table.projectId,
      table.agentPlatform,
    ),
    foreignKey({
      name: "monitoring_setup_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("monitoring_setup_project_idx").on(table.projectId),
  ],
);

/** One Retell voice agent selected inside a Retell Monitoring setup. */
export const retellMonitoredAgent = pgTable(
  "retell_monitored_agent",
  {
    id: idText("id").primaryKey(),
    monitoringSetupId: idText("monitoring_setup_id")
      .notNull()
      .references(() => monitoringSetup.id, { onDelete: "cascade" }),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    providerAgentId: text("provider_agent_id").notNull(),
    providerAgentName: text("provider_agent_name").notNull(),
    state: text("state").notNull().default("importing"),
    /** The fixed provider window and opaque page cursor currently in flight. */
    scanKind: text("scan_kind"),
    scanFrom: moment("scan_from"),
    scanThrough: moment("scan_through"),
    paginationKey: text("pagination_key"),
    /** Every opaque cursor already followed in this fixed scan. */
    paginationTrail: text("pagination_trail").notNull().default("[]"),
    /** A paused daily scan keeps its exact fixed window while regular polling runs. */
    reconciliationFrom: moment("reconciliation_from"),
    reconciliationThrough: moment("reconciliation_through"),
    reconciliationPaginationKey: text("reconciliation_pagination_key"),
    reconciliationPaginationTrail: text("reconciliation_pagination_trail")
      .notNull()
      .default("[]"),
    /** A bounded reconciliation slice must yield to one current scan. */
    reconciliationNeedsRegular: boolean("reconciliation_needs_regular")
      .notNull()
      .default(false),
    /** Upper bound of the last completed import or regular scan. */
    completedThrough: moment("completed_through"),
    /** Regular polling has its own cadence; reconciliation cannot move it. */
    nextRegularPollAt: moment("next_regular_poll_at").notNull(),
    /** The next scheduler wake for either regular or reconciliation work. */
    nextPollAt: moment("next_poll_at").notNull(),
    nextReconciliationAt: moment("next_reconciliation_at").notNull(),
    /** One DB-backed owner prevents duplicate Retell reads across API replicas. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: moment("lease_expires_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastErrorKind: text("last_error_kind"),
    lastErrorAt: moment("last_error_at"),
    lastSuccessAt: moment("last_success_at"),
    lastCallReceivedAt: moment("last_call_received_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("retell_monitored_agent_id_prefix", table.id, "rma"),
    oneOf("retell_monitored_agent_state_allowed", table.state, [
      ...RETELL_MONITORED_AGENT_STATES,
    ]),
    oneOf("retell_monitored_agent_scan_kind_allowed", table.scanKind, [
      ...RETELL_SCAN_KINDS,
    ]),
    check(
      "retell_monitored_agent_scan_agrees",
      sql`(${table.scanKind} is null and ${table.scanFrom} is null and ${table.scanThrough} is null and ${table.paginationKey} is null) or (${table.scanKind} is not null and ${table.scanFrom} is not null and ${table.scanThrough} is not null)`,
    ),
    check(
      "retell_monitored_agent_reconciliation_agrees",
      sql`(${table.reconciliationFrom} is null and ${table.reconciliationThrough} is null and ${table.reconciliationPaginationKey} is null and ${table.reconciliationNeedsRegular} = false) or (${table.reconciliationFrom} is not null and ${table.reconciliationThrough} is not null)`,
    ),
    check(
      "retell_monitored_agent_lease_agrees",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    unique("retell_monitored_agent_setup_provider_unique").on(
      table.monitoringSetupId,
      table.providerAgentId,
    ),
    foreignKey({
      name: "retell_monitored_agent_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("retell_monitored_agent_due_idx").on(
      table.nextPollAt,
      table.leaseExpiresAt,
    ),
    index("retell_monitored_agent_project_idx").on(table.projectId),
  ],
);

/**
 * Durable Retell call identity and cross-store recovery point.
 *
 * The unique product promise is one visible historical-import trace per
 * `(project, Retell call id)`. It does not depend on a setup row, selected
 * agent row, key, page, or simulation connection.
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
    providerAgentId: text("provider_agent_id").notNull(),
    providerAgentName: text("provider_agent_name"),
    providerAgentVersion: text("provider_agent_version"),
    /** Safe Retell document with bearer-like fields removed. */
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

/** A safe record of one call that bounded retries could not import. */
export const retellIngestionFailure = pgTable(
  "retell_ingestion_failure",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    retellMonitoredAgentId: idText("retell_monitored_agent_id")
      .notNull()
      .references(() => retellMonitoredAgent.id, { onDelete: "cascade" }),
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
    prefixCheck("retell_ingestion_failure_id_prefix", table.id, "rif"),
    oneOf("retell_ingestion_failure_status_allowed", table.status, [
      ...RETELL_FAILURE_STATUSES,
    ]),
    unique("retell_ingestion_failure_project_call_unique").on(
      table.projectId,
      table.providerCallId,
    ),
    check(
      "retell_ingestion_failure_resolved_agrees",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} is not null)`,
    ),
    check(
      "retell_ingestion_failure_replay_lease_agrees",
      sql`(${table.replayLeaseOwner} is null) = (${table.replayLeaseExpiresAt} is null)`,
    ),
    foreignKey({
      name: "retell_ingestion_failure_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("retell_ingestion_failure_open_idx")
      .on(table.retellMonitoredAgentId, table.lastAttemptAt)
      .where(sql`${table.status} = 'open'`),
  ],
);
