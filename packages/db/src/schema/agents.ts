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
 * them.
 *
 * The agent owns its platform binding, and the connection does not. Which
 * platform a connection reaches is answered by its connection type where the
 * type pins one (`retell_chat_api` -> retell, `livekit_room` -> livekit), else
 * through the agent — `phone_number` spans platforms. The agent's own binding
 * is what production monitoring
 * needs: the platform, that platform's identity for this agent, and the
 * sealed monitoring key egma pulls its finished production conversations
 * with. See ADR-0015.
 *
 * Deliberately unversioned, both tables. egma versions what egma authors, and
 * an agent's real content — prompt, model, tools — lives on the provider's
 * side or in the customer's own repo, where egma cannot freeze it. The table
 * is shaped so an `agent_version` pair can arrive later (the persona
 * pattern) without touching anything that references `agent`.
 */

/** The products or frameworks that run or expose an agent. */
export const AGENT_PLATFORMS = ["retell", "livekit"] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** The direct paths Egma's simulator can select to reach an agent. */
export const CONNECTION_TYPES = [
  "retell_chat_api",
  "retell_text_mode",
  "retell_web_call",
  "phone_number",
  "livekit_room",
] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** The authority and configuration used inside one connection type. */
export const ACCESS_VARIANTS = [
  "retell_chat_api.api_key",
  "retell_text_mode.api_key",
  "retell_web_call.api_key",
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
 * Who moves first when a simulation starts. Derived from the connection type by the
 * access layer, never supplied by a caller — it predicts whether an agent on a
 * laptop is reachable, and a caller's guess would just be wrong.
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
    /**
     * Which platform runs this agent, and that platform's own identity for
     * it. Every agent declares its platform when it is registered. The
     * platform's own identifier stays optional because not every platform
     * gives Egma one.
     */
    agentPlatform: text("agent_platform").notNull(),
    platformAgentId: text("platform_agent_id"),
    /**
     * The agent's sealed **platform key**, in the same envelope a connection's
     * credentials use and opened by the same one opener.
     *
     * **Its role is wider than its column name.** It was a monitoring-only
     * credential — the key egma pulls this agent's finished production
     * conversations with — and it is now also the key that does the platform
     * writes the mock-tools tick consents to: branching a temporary version at
     * run start, writing the mocked tools onto it, deleting it at run end, and
     * pinning and restoring a number's binding around the run. Nothing else
     * widened: a connection's own key keeps its own job, which is opening the
     * calls.
     *
     * The column keeps its name because renaming a shipped column is an add
     * and a remove rather than one statement, and the name is not where the
     * rule lives. The glossary carries the widened role.
     *
     * A customer who chat-tests and pull-monitors one Retell account pastes the
     * key twice, once per job, so the two custodies never entangle. Custody is
     * per agent and duplication across agents of one account is accepted
     * knowingly — sealing is randomized, so the copies are not even
     * recognizable as the same key.
     */
    monitoringApiKey: text("monitoring_api_key"),
    /** The last characters of the key, kept so a person can tell keys apart. */
    monitoringApiKeyHint: text("monitoring_api_key_hint"),
    /**
     * The declared switch: egma asks this agent's platform for its finished
     * production conversations, on a clock. Off by default, and the only
     * stored monitoring choice in the product — push is observed, never
     * declared.
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
    oneOf("agent_platform_allowed", table.agentPlatform, [...AGENT_PLATFORMS]),
    check(
      "agent_monitoring_key_hint_agrees",
      sql`(${table.monitoringApiKey} is null) = (${table.monitoringApiKeyHint} is null)`,
    ),
    // Kept as a named database invariant even though the platform column is
    // now required: a monitoring key always names the platform that opens it.
    check(
      "agent_monitoring_key_needs_platform",
      sql`${table.monitoringApiKey} is null or ${table.agentPlatform} is not null`,
    ),
    // The switch is a promise the poller has to be able to keep: it can only
    // be on when there is a platform to ask, an id to ask about, and a key to
    // ask with.
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
    index("agent_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.archivedAt} is null`),
    // Two egma agents polling one platform agent would double the API load and
    // contest attribution. The claim ledger would absorb the duplicates, but
    // the fight should be unrepresentable instead. Partial on the switch, so
    // two switched-off rows may still name the same platform agent.
    uniqueIndex("agent_pulled_platform_agent_unique")
      .on(table.projectId, table.agentPlatform, table.platformAgentId)
      .where(sql`${table.pullProductionCalls}`),
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
    /**
     * The direct path the simulator selects. It answers the platform question
     * on its own where it pins one; where it does not — `phone_number` spans
     * platforms — the agent answers, or nobody does.
     */
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
    /**
     * The switch: a run over this connection is conducted with Egma's mock
     * tools in front of the agent's own.
     *
     * **On the connection rather than on the agent**, because the lane is what
     * decides whether a mocked run is a thing Egma can conduct at all. A text
     * exchange and a web call are conversations Egma creates against a named
     * agent version, so a temporary version is reachable; a phone call is the
     * real carrier leg to the customer's published number, and Egma never
     * dials it for a mocked run. One switch above all three would govern one of
     * them and quietly misdescribe the other two.
     *
     * Off by default and checked: only a `retell_text_mode` or
     * `retell_web_call` connection may hold true. A text connection is created
     * with it on — that lane carries its answers on each request and writes
     * nothing to the customer's account — and a web-call connection turns it on
     * only through the consent screen, where the platform identity and the
     * sealed key it needs are checked at write time.
     */
    mockToolsEnabled: boolean("mock_tools_enabled").notNull().default(false),
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
    // The switch can only be on where a mocked run is a conversation Egma
    // creates itself. A ticked phone connection would be a box promising
    // isolation that no run over it could keep.
    check(
      "connection_mock_tools_lanes",
      sql`${table.mockToolsEnabled} = false
        or ${table.connectionType} in ('retell_text_mode', 'retell_web_call')`,
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
