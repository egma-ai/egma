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
 * The agent under test owns its agent platform identity and result history.
 * Connections define ways to reach it, such as Retell text mode or a web call.
 * Platform-specific connection types imply a platform; phone connections use
 * the agent's declared platform. The agent also holds production monitoring
 * credentials. These rows are unversioned; agent content lives on the platform
 * or in the customer repository (ADR-0015).
 */

/** The products or frameworks that run or expose an agent. */
export const AGENT_PLATFORMS = ["retell", "livekit"] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** The direct paths Egma's simulator can select to reach an agent. */
export const CONNECTION_TYPES = [
  "retell_text_mode",
  "retell_web_call",
  "phone_number",
  "livekit_room",
] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** Stored history includes connection types that the product no longer creates. */
const PERSISTED_CONNECTION_TYPES = [
  ...CONNECTION_TYPES,
  "retell_chat_api",
] as const;

/**
 * Connection types that can supply an agent POV (ADR-0024 §2): LiveKit SDK push
 * and Retell web-call record pull. Phone and text-mode connections
 * have no supported second-POV path. Grading also requires this simulation's
 * provider reference before waiting; capability alone is not enough.
 */
export const LANES_WITH_AN_AGENT_POV = [
  "retell_web_call",
  "livekit_room",
] as const satisfies readonly ConnectionType[];

/** Whether a conversation over this connection could have a second account. */
export function laneProducesAnAgentPov(connectionType: string): boolean {
  return (LANES_WITH_AN_AGENT_POV as readonly string[]).includes(
    connectionType,
  );
}

/** The authority and configuration used inside one connection type. */
export const ACCESS_VARIANTS = [
  "retell_text_mode.api_key",
  "retell_web_call.api_key",
  "phone_number.public_e164",
  "livekit_room.project_credentials",
  "livekit_room.customer_token_endpoint",
] as const;
export type AccessVariant = (typeof ACCESS_VARIANTS)[number];

/** Stored history includes credentials shapes that the product no longer creates. */
const PERSISTED_ACCESS_VARIANTS = [
  ...ACCESS_VARIANTS,
  "retell_chat_api.api_key",
] as const;

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
     * Encrypted agent platform key for production polling and temporary Retell version
     * build/cleanup. Connection credentials are stored separately for simulation access.
     * Connect flows can reuse the agent key; encrypted copies are randomized.
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
     * Archive timestamp, or null while active. Past runs remain readable.
     * Archiving also retires connections and cancels unfinished work.
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
    // Only the living watch. An archived row that kept its switch on would
    // hold the one-watcher claim and keep being polled while no screen can
    // show it, so the state is unrepresentable rather than merely avoided by
    // the archive path.
    check(
      "agent_archived_releases_pull",
      sql`${table.pullProductionCalls} = false or ${table.archivedAt} is null`,
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
     * Immutable access variant ID chosen at creation. Read its rules by this ID,
     * never infer a different variant from config keys. Changing it requires a new connection.
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
      ...PERSISTED_CONNECTION_TYPES,
    ]),
    oneOf("connection_access_variant_allowed", table.accessVariant, [
      ...PERSISTED_ACCESS_VARIANTS,
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
    // Foreign-key target that keeps runs and simulations on the connection's agent.
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
