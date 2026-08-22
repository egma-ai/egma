import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * The agent is the customer's voice agent — the thing egma is establishing
 * trust in, and the identity every test result accumulates against. A
 * connection is how egma reaches one: the same logical agent might be a Retell
 * chat endpoint in CI, a Retell web call in staging, and a phone number in
 * production, and its history must stay under one identity through all of
 * them. So a connection says how egma *reaches* an agent and never which
 * platform runs it — that fact is the agent's own, where a team that migrates
 * frameworks keeps their agent and its record by moving one column.
 *
 * The agent is also the one place an agent is known, so how its production
 * traffic reaches egma hangs off it: an optional platform binding, an optional
 * sealed monitoring key, and one declared switch. Pull is declared here; push
 * needs no row at all, because the customer's own process sends spans to the
 * OTLP door with the project key and the stored evidence is the whole record.
 *
 * Deliberately unversioned, both tables. egma versions what egma authors, and
 * an agent's real content — prompt, model, tools — lives on the provider's
 * side or in the customer's own repo, where egma cannot freeze it. The table
 * is shaped so an `agent_version` pair can arrive later (the persona
 * pattern) without touching anything that references `agent`.
 */

/** The products or frameworks that run or expose an agent. */
export const AGENT_PLATFORMS = ["retell", "livekit_agents"] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** The direct paths Egma's simulator can select to reach an agent. */
export const CONNECTION_TYPES = [
  "retell_chat_api",
  "phone_number",
  "livekit_room",
] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** The authority and configuration used inside one connection type. */
export const ACCESS_VARIANTS = [
  "retell_chat_api.api_key",
  "phone_number.public_e164",
  "livekit_room.project_credentials",
  "livekit_room.customer_token_endpoint",
] as const;
export type AccessVariant = (typeof ACCESS_VARIANTS)[number];

/**
 * Which layer is under test: chat exercises the harness (prompt, reasoning,
 * tools); voice exercises the harness plus the speech stack.
 */
export const MODALITIES = ["voice", "chat"] as const;
export type Modality = (typeof MODALITIES)[number];

/**
 * Who moves first when a simulation starts. Derived from the connection type by
 * the access layer, never supplied by a caller — it predicts whether an agent
 * on a laptop is reachable, and a caller's guess would just be wrong.
 */
export const TOPOLOGIES = [
  "agent-dials-out",
  "hosted-broker",
  "egma-dials-in",
] as const;
export type Topology = (typeof TOPOLOGIES)[number];

export const agent = pgTable(
  "agent",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    name: text("name").notNull(),
    /** Which platform runs this agent, or null while nobody has said. */
    agentPlatform: text("agent_platform"),
    /** The platform's own identity for it, beside the platform that issued it. */
    platformAgentId: text("platform_agent_id"),
    /**
     * The sealed platform key egma pulls this agent's production calls with.
     *
     * A monitoring-only credential, deliberately separate from anything a
     * connection holds for simulation: a customer who chat-tests and
     * pull-monitors one Retell account enters the key twice, once per job, and
     * the two custodies never entangle. Sealed exactly as connection
     * credentials are — same envelope, same one-opener rule — and custody is
     * per agent, so five agents on one account store five sealed copies of one
     * key. Sealing is randomized, so the copies are not recognizable as the
     * same key and key-wide facts are unrepresentable by design.
     */
    monitoringApiKey: text("monitoring_api_key"),
    /** The last characters of that key, kept so a person can tell keys apart. */
    monitoringApiKeyHint: text("monitoring_api_key_hint"),
    /**
     * The one monitoring choice anywhere in the product: whether egma polls
     * this agent's platform for its production calls.
     *
     * Pull is declared and push is observed, so there is no switch beside this
     * one. A pushing agent shows itself through its traffic alone.
     */
    pullProductionCalls: boolean("pull_production_calls")
      .notNull()
      .default(false),
    /**
     * When this agent stopped being available for new work, or null while it
     * is. Archive rather than delete: past runs name it and stay readable, and
     * the whole of what Archive does is stop it entering anything new.
     */
    archivedAt: moment("archived_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("agent_id_prefix", table.id, "agt"),
    oneOf("agent_agent_platform_allowed", table.agentPlatform, [
      ...AGENT_PLATFORMS,
    ]),
    check(
      "agent_monitoring_key_hint_agrees",
      sql`(${table.monitoringApiKey} is null) = (${table.monitoringApiKeyHint} is null)`,
    ),
    // A key with nothing to spend it on is a secret stored for no reason.
    check(
      "agent_monitoring_key_needs_platform",
      sql`${table.monitoringApiKey} is null or ${table.agentPlatform} is not null`,
    ),
    // The switch's truth is the whole precondition of polling, said once here
    // so no writer anywhere can turn it on over a binding that cannot be used.
    check(
      "agent_pull_needs_binding",
      sql`${table.pullProductionCalls} = false or (${table.agentPlatform} is not null and ${table.platformAgentId} is not null and ${table.monitoringApiKey} is not null)`,
    ),
    // The pairing, not each column on its own: an agent cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "agent_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that makes an agent/connection project mismatch unrepresentable.
    unique("agent_id_project_id_unique").on(table.id, table.projectId),
    // Partial, so an archived agent releases its name to the active.
    uniqueIndex("agent_project_id_name_unique")
      .on(table.projectId, table.name)
      .where(sql`${table.archivedAt} is null`),
    // Two egma agents polling one platform agent would double the API load and
    // contest the attribution of every call. The claim ledger would absorb the
    // duplicates; the fight is made unrepresentable instead. Partial on the
    // switch, so two agents that are not being polled may name the same one.
    uniqueIndex("agent_pulled_platform_agent_unique")
      .on(table.projectId, table.agentPlatform, table.platformAgentId)
      .where(sql`${table.pullProductionCalls}`),
    index("agent_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
  ],
);

export const connection = pgTable(
  "connection",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    agentId: idText("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The direct path the simulator selects. */
    connectionType: text("connection_type").notNull(),
    modality: text("modality").notNull(),
    topology: text("topology").notNull(),
    /**
     * The authority and configuration used inside this connection type,
     * written down once at create and never changed.
     *
     * The access variant used to be re-derived from config on every read, by looking
     * for the discriminating key. That works while the registry is the registry
     * this row was written under, and stops working the moment a variant gains
     * or loses a key — the same stored config would then answer a different
     * access variant, and the credential rule a Restore is held to would change
     * underneath a connection nobody edited. So the access variant is a stored fact
     * about this row, and changing it is a new connection.
     */
    accessVariant: text("access_variant").notNull(),
    /** A label (`staging`, `production`), never a level in the hierarchy. */
    environment: text("environment"),
    /** Non-secret, validated per access variant: what to reach, never how to prove. */
    config: jsonb("config").notNull(),
    /**
     * The sealed envelope (`v1.<iv>.<ciphertext>.<tag>`), or null for variants
     * where the customer supplies no secret. Never selected by any read; the
     * one opener is the access layer's credential resolver.
     */
    credentials: text("credentials"),
    /** The last characters of the secret, kept so a person can tell keys apart. */
    credentialsHint: text("credentials_hint"),
    /** When this connection stopped being reachable for new work, or null. */
    archivedAt: moment("archived_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("connection_id_prefix", table.id, "con"),
    oneOf("connection_type_allowed", table.connectionType, [
      ...CONNECTION_TYPES,
    ]),
    oneOf("connection_access_variant_allowed", table.accessVariant, [
      ...ACCESS_VARIANTS,
    ]),
    oneOf("connection_modality_allowed", table.modality, [...MODALITIES]),
    oneOf("connection_topology_allowed", table.topology, [...TOPOLOGIES]),
    check(
      "connection_credentials_hint_agrees",
      sql`(${table.credentials} is null) = (${table.credentialsHint} is null)`,
    ),
    foreignKey({
      name: "connection_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // The pairing again, one level down: a connection cannot name one project
    // and another project's agent. With both rows' own project/organization
    // pairs already pinned above, matching the agent's project is what makes
    // the whole tenancy triangle agree.
    foreignKey({
      name: "connection_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // Inert today; the composite-FK target that lets the future run table
    // prove its (agent_id, connection_id) actually pair.
    unique("connection_id_agent_id_unique").on(table.id, table.agentId),
    // Partial, so an archived connection releases its name.
    uniqueIndex("connection_agent_id_name_unique")
      .on(table.agentId, table.name)
      .where(sql`${table.archivedAt} is null`),
    index("connection_agent_id_idx")
      .on(table.agentId)
      .where(sql`${table.archivedAt} is null`),
  ],
);
