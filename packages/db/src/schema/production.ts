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

/**
 * The fixed scan a selected Retell agent is currently completing.
 *
 * Two, and there is no third. An import is the deliberate deep read a customer
 * asks for by selecting the agent; a regular poll is the shallow one that keeps
 * up. Anything else would be Egma reading a customer's provider history on its
 * own schedule, which is exactly the cost this design removes.
 */
export const RETELL_SCAN_KINDS = ["historical_import", "regular"] as const;
export type RetellScanKind = (typeof RETELL_SCAN_KINDS)[number];

/** Customer-visible progress for one selected Retell voice agent. */
export const RETELL_MONITORED_AGENT_STATES = [
  "importing",
  "active",
  "degraded",
] as const;
export type RetellMonitoredAgentState =
  (typeof RETELL_MONITORED_AGENT_STATES)[number];

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
    // The selected-agent row repeats the tenant facts so its composite foreign
    // key can prove that it uses this project's setup and credential.
    unique("monitoring_setup_id_tenant_unique").on(
      table.id,
      table.projectId,
      table.organizationId,
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
    monitoringSetupId: idText("monitoring_setup_id").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    platformAgentId: text("platform_agent_id").notNull(),
    platformAgentName: text("platform_agent_name").notNull(),
    state: text("state").notNull().default("importing"),
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
     * The earliest instant a regular scan may look back to, while it is set.
     *
     * A regular window normally starts five minutes before the last completed
     * upper bound, so a call the provider exposes a little late is still found.
     * A floor overrides that subtraction, which is what a cutover needs: the
     * first window after one must not reach behind it and re-import evidence
     * the release deliberately removed. It is cleared once a window has
     * completed above it, and the overlap resumes.
     */
    regularFloorAt: moment("regular_floor_at"),
    /**
     * Which explicit import this agent's transient call state belongs to.
     *
     * Selecting the agent again is a new observation of the provider's history
     * and starts a new generation. It is what lets a fresh import take its own
     * bounded look at a call an earlier regular scan gave up on, without
     * letting an ordinary repeated poll do the same.
     */
    importGeneration: integer("import_generation").notNull().default(1),
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
      "retell_monitored_agent_lease_agrees",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    unique("retell_monitored_agent_setup_platform_agent_unique").on(
      table.monitoringSetupId,
      table.platformAgentId,
    ),
    // Transient call rows repeat the tenant facts, so they can prove that their
    // selected agent belongs to the same project and organization.
    unique("retell_monitored_agent_id_tenant_unique").on(
      table.id,
      table.projectId,
      table.organizationId,
    ),
    foreignKey({
      name: "retell_monitored_agent_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "retell_monitored_agent_setup_tenant_fk",
      columns: [
        table.monitoringSetupId,
        table.projectId,
        table.organizationId,
      ],
      foreignColumns: [
        monitoringSetup.id,
        monitoringSetup.projectId,
        monitoringSetup.organizationId,
      ],
    }).onDelete("cascade"),
    index("retell_monitored_agent_due_idx").on(
      table.nextPollAt,
      table.leaseExpiresAt,
    ),
    index("retell_monitored_agent_project_idx").on(table.projectId),
  ],
);

/**
 * One Retell call Egma could not turn into evidence, and nothing else.
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
 * window, and deleting a selected agent or its Monitoring setup takes its rows
 * with it.
 */
export const retellCallRetry = pgTable(
  "retell_call_retry",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    retellMonitoredAgentId: idText("retell_monitored_agent_id").notNull(),
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
      name: "retell_call_retry_agent_tenant_fk",
      columns: [
        table.retellMonitoredAgentId,
        table.projectId,
        table.organizationId,
      ],
      foreignColumns: [
        retellMonitoredAgent.id,
        retellMonitoredAgent.projectId,
        retellMonitoredAgent.organizationId,
      ],
    }).onDelete("cascade"),
    // The batched page lookup reads `(project_id, provider_call_id)`, and the
    // unique constraint above already builds exactly that btree. A second
    // index on the same pair would be one more thing every retry write has to
    // maintain and nothing at all to read from.
    index("retell_call_retry_due_idx")
      .on(table.retellMonitoredAgentId, table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} is not null`),
  ],
);

