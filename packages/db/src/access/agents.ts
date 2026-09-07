import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  agent,
  connection,
  type AccessVariant,
  type AgentPlatform,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { monitoringState } from "../schema/production.ts";
import { sealCredentials } from "../sealing.ts";
import {
  credentialRuleOf,
  descriptorOf,
  platformOfConnectionType,
  productLabelOf,
  reuseFamilyOf,
  validConfig,
  validCredentials,
  validModality,
  accessVariantById,
} from "./connection-registry.ts";
import type { AuthContext } from "./context.ts";
import {
  AgentWriteRefusedError,
  ConnectionRestoreRefusedError,
  IdentityConflictError,
  ProjectOutsideOrganizationError,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { stopWorkOverConnections } from "./runs.ts";
import { within } from "./within.ts";

/**
 * Read and write agents and their connections within the authorized organization
 * and project scope. Connection operations name the owning agent; a wrong
 * agent or organization returns the same answer as a missing connection.
 * Public reads omit credentials. Internal execution paths resolve plaintext
 * credentials in access/runs.ts; each resolver enforces its own permissions.
 */

export type NewConnection = {
  /** Defaults from the connection kind and modality, so onboarding never stalls. */
  readonly name?: string | undefined;
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  /** A label (`staging`, `production`), never a level in the hierarchy. */
  readonly environment?: string | undefined;
  /** Validated per access variant: what to reach, never how to prove. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Required or refused per access variant; sealed before it touches the row. */
  readonly credentials?: Readonly<Record<string, unknown>> | undefined;
};

export type Connection = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  /**
   * Derived, never stored: the platform the connection type pins, else the
   * agent's own binding, else null. See ADR-0015.
   */
  readonly agentPlatform: AgentPlatform;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  /** Derived from the connection type, never caller-supplied. */
  readonly topology: Topology;
  /** Human display text derived from the stable technical axes. */
  readonly productLabel: string;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  /** The last characters of the sealed secret, or null where none belongs. */
  readonly credentialsHint: string | null;
  /** When it stopped being reachable for new work, or null while it is. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. The four technical axes are deliberately absent:
 * changing what a connection *is* is a new connection, and mutating it in place
 * would attribute yesterday's chat results to something that is now a phone number.
 * Credentials replace whole or stay untouched — never a merge, so plaintext
 * never round-trips out for editing. Absent means keep.
 */
export type ConnectionChanges = {
  readonly name?: string | undefined;
  readonly environment?: string | null | undefined;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly credentials?: Readonly<Record<string, unknown>> | undefined;
};

/** What a connection Archive answers: the row, and the work it stopped. */
export type ArchivedConnection = {
  readonly connection: Connection;
  readonly canceledRunCount: number;
};

/**
 * Restore requires an explicit credential decision. Optional variants use replace
 * or clear; never reuse the archived envelope implicitly.
 */
export type RestoreCredential =
  | { readonly choice: "replace"; readonly credentials: Readonly<Record<string, unknown>> }
  | { readonly choice: "clear" };

export type NewAgent = {
  readonly name: string;
  /** Which product or framework runs this agent. */
  readonly agentPlatform: AgentPlatform;
  /**
   * The optional first connection, written in the same transaction — the
   * happy onboarding path never produces an unreachable agent, and a bad
   * connection payload leaves no agent behind.
   */
  readonly connection?: NewConnection | undefined;
};

export type Agent = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Which platform runs this agent. */
  readonly agentPlatform: AgentPlatform;
  /** That platform's own id for it, or null. */
  readonly platformAgentId: string | null;
  /**
   * The durable Retell connection modality: Voice when any Retell voice path
   * has ever existed, otherwise Chat when any Retell chat path has existed.
   */
  readonly retellModality: "voice" | "chat" | null;
  /** The last characters of the sealed monitoring key, or null. */
  readonly monitoringApiKeyHint: string | null;
  /** The declared pull switch. Off until somebody turns it on. */
  readonly pullProductionCalls: boolean;
  /** Whether pull monitoring has ever been started for this agent. */
  readonly monitoringConfigured: boolean;
  /**
   * When a production call last arrived for this agent, or null while none
   * has. Read from the machine notebook, which is where the drainer stamps it.
   *
   * It travels with the agent because the agent is where a person reads it:
   * whether pull is on, whether it has ever been configured, and when a call
   * last arrived are the stored facts the monitoring view derives from.
   */
  readonly lastReceivedAt: Date | null;
  /** When it stopped being available for new work, or null while it is. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** What `createAgent` answers: the agent, wired if the create asked for it. */
export type CreatedAgent = Agent & {
  readonly connection?: Connection;
};

/**
 * What an edit may touch: the name, in place. There is no version to move —
 * the agent is deliberately unversioned, because its real content lives on the
 * provider's side where egma cannot freeze it. Absent means keep.
 *
 * There is no revision either: two people editing one agent from two browsers
 * is silent last-writer-wins, accepted pre-launch (ADR-0015).
 */
export type AgentChanges = {
  readonly name?: string | undefined;
};

/**
 * Agent identity with all active connections, fetched together for list rendering.
 * Archived connections are read separately; an archived agent has no active connections.
 */
export type AgentWithConnections = Agent & {
  readonly connections: readonly Connection[];
};

export type AgentPage = {
  readonly items: readonly AgentWithConnections[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

/** What an Archive answers: the agent as it now stands, and what went with it. */
export type ArchivedAgent = {
  readonly agent: Agent;
  /** Every child connection this Archive took, active until now. */
  readonly connections: readonly string[];
  /** How many run headers this Archive set to canceled. */
  readonly canceledRunCount: number;
};

type AgentRow = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly agentPlatform: string;
  readonly platformAgentId: string | null;
  readonly retellModality: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly pullProductionCalls: boolean;
  readonly monitoringConfigured: boolean;
  readonly lastReceivedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The platform column is narrowed by assertion; its CHECK already refuses the rest. */
function agentFromRow(row: AgentRow): Agent {
  return {
    ...row,
    agentPlatform: row.agentPlatform as AgentPlatform,
    retellModality: row.retellModality as Agent["retellModality"],
  };
}

const notArchived: SQL = isNull(agent.archivedAt);
const connectionNotArchived: SQL = isNull(connection.archivedAt);

/**
 * Read the monitoring timestamp through a scalar subquery, including RETURNING paths.
 * Qualify the outer agent ID: a bare id would resolve inside monitoring_state.
 * Its unique agent_id prevents row multiplication; mapWith uses the timestamp decoder.
 */
const LAST_RECEIVED_AT = sql`(
  select ${monitoringState.lastReceivedAt} from ${monitoringState}
   where ${monitoringState.agentId}
       = ${sql.identifier(getTableName(agent))}.${sql.identifier(agent.id.name)}
)`.mapWith(monitoringState.lastReceivedAt);

/**
 * Whether the pull switch has ever created this agent's machine notebook.
 *
 * The notebook survives when pull is stopped, while sealing a key for a
 * simulation connection does not create one. Its existence therefore keeps
 * "not configured" distinct from "configured, then stopped" without a second
 * stored flag that could disagree with the notebook.
 */
const MONITORING_CONFIGURED = sql`exists (
  select 1 from ${monitoringState}
   where ${monitoringState.agentId}
       = ${sql.identifier(getTableName(agent))}.${sql.identifier(agent.id.name)}
)`.mapWith(agent.pullProductionCalls);

/**
 * The Retell modality this agent's full connection history establishes.
 *
 * Archived rows stay in the table, so this deliberately has no active-row
 * filter. A Retell chat path pins its own platform. A phone path counts only
 * when its agent is Retell, because phone numbers also reach LiveKit agents.
 * Voice sorts first so it remains the answer when both paths have existed.
 */
const RETELL_MODALITY = sql`(
  select ${connection.modality} from ${connection}
   where ${connection.agentId}
       = ${sql.identifier(getTableName(agent))}.${sql.identifier(agent.id.name)}
     and (
       ${connection.connectionType} = 'retell_chat_api'
       or (
         ${connection.connectionType} = 'phone_number'
         and ${sql.identifier(getTableName(agent))}.${sql.identifier(agent.agentPlatform.name)} = 'retell'
       )
     )
   order by case when ${connection.modality} = 'voice' then 0 else 1 end
   limit 1
)`.mapWith(connection.modality);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: agent.id,
  projectId: agent.projectId,
  name: agent.name,
  agentPlatform: agent.agentPlatform,
  platformAgentId: agent.platformAgentId,
  retellModality: RETELL_MODALITY,
  monitoringApiKeyHint: agent.monitoringApiKeyHint,
  pullProductionCalls: agent.pullProductionCalls,
  monitoringConfigured: MONITORING_CONFIGURED,
  lastReceivedAt: LAST_RECEIVED_AT,
  archivedAt: agent.archivedAt,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
} as const;

/** A connection as any read answers it. The sealed envelope has no row here. */
const CONNECTION_COLUMNS = {
  id: connection.id,
  agentId: connection.agentId,
  projectId: connection.projectId,
  name: connection.name,
  connectionType: connection.connectionType,
  accessVariant: connection.accessVariant,
  modality: connection.modality,
  topology: connection.topology,
  environment: connection.environment,
  config: connection.config,
  credentialsHint: connection.credentialsHint,
  archivedAt: connection.archivedAt,
  createdAt: connection.createdAt,
  updatedAt: connection.updatedAt,
} as const;

/**
 * The name as it will be stored: trimmed, because a handle that participates
 * in a uniqueness check must not get around it on invisible characters.
 */
function validName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new AgentWriteRefusedError("needs_a_name", `${what} needs a name`);
  }
  return trimmed;
}

/**
 * Match the named uniqueness constraint through wrapped causes, not message text.
 * Shared internally so racing writes receive the same domain refusal.
 */
export function lostToConstraint(error: unknown, constraint: string): boolean {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (carrier.constraint === constraint) return true;
    at = carrier.cause;
  }
  return false;
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(agent.projectId, auth.projectId);
}

/** The named agent, active, within the caller's tenancy and scope. */
function theAgent(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    agent,
    and(eq(agent.id, id), notArchived, inActingProject(auth)),
  );
}

/**
 * The named agent whether or not it is archived.
 *
 * Archive is not deletion, and the whole difference is that an archived agent
 * stays readable: a run that names it has to keep opening, and Restore has to
 * be able to find the thing it restores. So the reads and the lifecycle verbs
 * come through here, and only the verbs that put an agent into *new* work go
 * through the active door above.
 */
function theAgentEvenArchived(auth: AuthContext, id: string): SQL {
  return within(auth, agent, and(eq(agent.id, id), inActingProject(auth)));
}

/**
 * The named connection, alive, on this agent, within the caller's tenancy.
 * Callers have already walked through `visibleAgent`, so the agent side —
 * alive, in scope — is settled; this pins the connection to it, and the
 * `agent_id` equality is what makes another agent's connection unreachable.
 */
function theConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): SQL {
  return within(
    auth,
    connection,
    and(eq(connection.id, connectionId), eq(connection.agentId, agentId)),
  );
}

/**
 * The one door every connection verb walks through first. A connection is
 * reached only through its agent, so an agent the caller cannot see — another
 * customer's, another project's, a deleted one — makes every connection under
 * it answer as if it did not exist.
 */
async function visibleAgent(
  auth: AuthContext,
  agentId: string,
): Promise<
  | {
      id: string;
      projectId: string;
      agentPlatform: AgentPlatform;
      platformAgentId: string | null;
      monitoringApiKeyHint: string | null;
      archivedAt: Date | null;
    }
  | undefined
> {
  const [row] = await db()
    .select({
      id: agent.id,
      projectId: agent.projectId,
      // Every connection read under this agent derives its platform through
      // here when its own type does not pin one, so the read that proves the
      // agent is visible is the read that answers it.
      agentPlatform: agent.agentPlatform,
      // What turning the web-call switch on is checked against: there must be
      // a platform agent to branch a temporary copy of, and a sealed key to
      // branch it with.
      platformAgentId: agent.platformAgentId,
      monitoringApiKeyHint: agent.monitoringApiKeyHint,
      archivedAt: agent.archivedAt,
    })
    .from(agent)
    .where(theAgentEvenArchived(auth, agentId))
    .limit(1);
  return row === undefined
    ? undefined
    : { ...row, agentPlatform: row.agentPlatform as AgentPlatform };
}

/**
 * Validate stored JSON or decrypted envelopes as key-value records.
 * Check shape only so older rows remain readable after registry rules tighten.
 * Shared with runs.ts; not exported from the package.
 */
export function stringRecordFromRow(
  value: unknown,
  malformed: () => Error,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw malformed();
    record[key] = entry;
  }
  return record;
}

function configFromRow(
  value: unknown,
  connectionId: string,
): Record<string, string> {
  return stringRecordFromRow(
    value,
    () =>
      new Error(
        `connection ${connectionId} holds config in a shape Egma never ` +
          `writes; the row needs repairing before anybody can read it`,
      ),
  );
}

type ConnectionRow = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: unknown;
  readonly credentialsHint: string | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * A selected row as the caller sees it. The three enumerated columns are
 * narrowed by assertion because the schema's CHECK constraints already refuse
 * anything outside the lists — a value the assertion would get wrong cannot be
 * in the table.
 */
function connectionFromRow(
  row: ConnectionRow,
  /**
   * The platform its agent declares. **Required, with no default**:
   * a default would silently drop the second half of the rule and let a
   * `phone_number` connection on a Retell agent read back as belonging to no
   * platform — and read back differently from the way it was written.
   */
  agentPlatformOfAgent: AgentPlatform,
): Connection {
  const connectionType = row.connectionType as ConnectionType;
  // The type answers where it pins one platform; otherwise the agent answers.
  // See ADR-0015.
  const agentPlatform =
    platformOfConnectionType(connectionType) ?? agentPlatformOfAgent;
  const accessVariant = row.accessVariant as AccessVariant;
  const modality = row.modality as Modality;
  return {
    ...row,
    agentPlatform,
    connectionType,
    accessVariant,
    modality,
    topology: row.topology as Topology,
    productLabel: productLabelOf(
      agentPlatform,
      connectionType,
      accessVariant,
      modality,
    ),
    config: configFromRow(row.config, row.id),
  };
}

/**
 * A new connection once the registry has had its say: modality checked
 * against the tuple, config gated key by key, credentials sealed or refused,
 * topology derived. The name may still be absent — defaulting it takes a
 * read, and this shape exists so that read can wait for the insert's own
 * transaction.
 */
type AdmittedConnection = {
  readonly name: string | undefined;
  /**
   * The platform the payload named. It selects the product label the write is
   * held to; it is not stored, because the connection row has no platform
   * column any more.
   */
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  readonly topology: Topology;
  readonly environment: string | null;
  readonly config: Record<string, string>;
  readonly credentials: string | null;
  readonly credentialsHint: string | null;
};

/**
 * Pure validation — nothing here touches the database, so a bad payload dies
 * before anything is written, wherever the caller is in a transaction.
 */
function admitConnection(input: NewConnection): AdmittedConnection {
  const descriptor = descriptorOf(input.connectionType);
  const modality = validModality(
    input.connectionType,
    input.accessVariant,
    input.modality,
  );
  // The payload's own tuple has to be one egma supports — this is what turns
  // away a combination nobody can reach, before any database work.
  //
  // **It is not the last word on the platform.** Where the connection type
  // does not pin one, the agent answers, so `insertConnection` checks the
  // tuple again against the platform this connection will actually be
  // represented under. Validating only here would let the door admit one
  // tuple and the row read back as another. The label is discarded both
  // times, because it is derived on every read.
  productLabelOf(
    input.agentPlatform,
    input.connectionType,
    input.accessVariant,
    modality,
  );
  const config = validConfig(
    input.connectionType,
    input.accessVariant,
    input.config,
  );
  const sealed = validCredentials(
    input.connectionType,
    input.accessVariant,
    input.credentials,
  );

  return {
    name:
      input.name === undefined
        ? undefined
        : validName(input.name, "a connection"),
    agentPlatform: input.agentPlatform,
    connectionType: input.connectionType,
    accessVariant: input.accessVariant,
    modality,
    topology: descriptor.topology,
    environment: input.environment ?? null,
    config,
    credentials: sealed === null ? null : sealCredentials(sealed.sealed),
    credentialsHint: sealed === null ? null : sealed.hint,
  };
}

/** The stable stem for one generated connection name. */
function defaultNameStem(
  connectionType: ConnectionType,
  modality: Modality,
): string {
  if (connectionType !== "livekit_room") return connectionType;
  return modality === "chat" ? "livekit_chat" : "livekit_voice";
}

/**
 * The smallest free `<kind>-<n>` among the agent's living names, so an unnamed
 * add always lands — a removed connection's number comes back into play the
 * same way its name does. LiveKit includes its modality because one worker can
 * have both a chat connection and a voice connection.
 */
async function freeDefaultName(
  on: Queryable,
  agentId: string,
  connectionType: ConnectionType,
  modality: Modality,
): Promise<string> {
  const taken = new Set(
    (
      await on
        .select({ name: connection.name })
        .from(connection)
        .where(and(eq(connection.agentId, agentId), connectionNotArchived))
    ).map((row) => row.name),
  );

  const stem = defaultNameStem(connectionType, modality);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The refusal both agent writes share, for the moment the database says a
 * living agent in the project already holds the name.
 */
function refusingHeldAgentName(name: string): (error: unknown) => never {
  return (error: unknown) => {
    if (lostToConstraint(error, "agent_project_id_name_unique")) {
      throw new AgentWriteRefusedError(
        "name_taken",
        `an agent named "${name}" already exists in this project`,
      );
    }
    throw error;
  };
}

/**
 * The refusal both connection writes share, for the moment the database says
 * a living connection already holds the name.
 */
function refusingHeldConnectionName(name: string): (error: unknown) => never {
  return (error: unknown) => {
    if (lostToConstraint(error, "connection_agent_id_name_unique")) {
      throw new AgentWriteRefusedError(
        "name_taken",
        `a connection named "${name}" already exists on this agent`,
      );
    }
    throw error;
  };
}

/**
 * The insert both create paths share, wherever the caller is in a
 * transaction. The input has already passed `admitConnection`; this owns the
 * name default and the friendly refusal when a living connection holds the
 * name already.
 */
/**
 * Use the connection type's fixed agent platform when defined; otherwise use the
 * parent agent's platform. Reject a conflicting explicit platform instead of relabeling it.
 */
function representedPlatform(
  admitted: AdmittedConnection,
  agentPlatformOfAgent: AgentPlatform,
): AgentPlatform {
  const pinned = platformOfConnectionType(admitted.connectionType);
  if (pinned !== null) return pinned;

  if (
    admitted.agentPlatform !== null &&
    admitted.agentPlatform !== agentPlatformOfAgent
  ) {
    throw new AgentWriteRefusedError(
      "platform_contradicts_agent",
      `This connection names ${admitted.agentPlatform} and its agent is on ` +
        `${agentPlatformOfAgent}. A ${admitted.connectionType} connection ` +
        `reaches whichever platform its agent is on, so it cannot name ` +
        `another one. Send ${agentPlatformOfAgent}, or leave the platform ` +
        `out and the agent will answer.`,
    );
  }

  // What the row will be represented as has to be a supported tuple in its own
  // right, not only the tuple the payload happened to name.
  productLabelOf(
    agentPlatformOfAgent,
    admitted.connectionType,
    admitted.accessVariant,
    admitted.modality,
  );
  return agentPlatformOfAgent;
}

async function insertConnection(
  on: Queryable,
  auth: AuthContext,
  home: {
    readonly id: string;
    readonly projectId: string;
    /**
     * The agent's own binding. What comes back is derived from this and never
     * from the payload's `agentPlatform`, so the product label a create
     * answers is the one the next read answers.
     */
    readonly agentPlatform: AgentPlatform;
    readonly platformAgentId: string | null;
    readonly monitoringApiKeyHint: string | null;
  },
  admitted: AdmittedConnection,
): Promise<Connection> {
  // Before the write, and here rather than at the door, because this is the
  // first point that knows which agent the connection lands under.
  const agentPlatform = representedPlatform(admitted, home.agentPlatform);
  const name =
    admitted.name ??
    (await freeDefaultName(
      on,
      home.id,
      admitted.connectionType,
      admitted.modality,
    ));

  const [inserted] = await on
    .insert(connection)
    .values({
      id: newId("con"),
      organizationId: auth.organizationId,
      projectId: home.projectId,
      agentId: home.id,
      name,
      connectionType: admitted.connectionType,
      accessVariant: admitted.accessVariant,
      modality: admitted.modality,
      topology: admitted.topology,
      environment: admitted.environment,
      config: admitted.config,
      credentials: admitted.credentials,
      credentialsHint: admitted.credentialsHint,
      createdBy: auth.userId,
    })
    .returning(CONNECTION_COLUMNS)
    .catch(refusingHeldConnectionName(name));

  if (inserted === undefined) throw new Error("the connection was not written");
  return connectionFromRow(inserted, agentPlatform);
}

/**
 * The insert every agent-writing path shares, wherever the caller is in a
 * transaction. It owns the friendly refusal for the moment a living agent in
 * the project already holds the name.
 */
/**
 * Write one agent row, on whatever connection or transaction is handed in.
 *
 * **Exported to the module, not from the package.** Production monitoring
 * needs the very same insert inside its own transaction — registering an
 * unregistered platform agent and flipping its switch have to be one atomic
 * act — and a second copy of this insert there would be a second place the
 * agent's identity, its tenancy stamp and its held-name refusal are decided.
 */
export async function insertAgentWithin(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  identity: { readonly name: string; readonly agentPlatform: AgentPlatform },
): Promise<Agent> {
  const [inserted] = await on
    .insert(agent)
    .values({
      id: newId("agt"),
      organizationId: auth.organizationId,
      projectId,
      name: identity.name,
      agentPlatform: identity.agentPlatform,
      createdBy: auth.userId,
    })
    .returning(COLUMNS)
    .catch(refusingHeldAgentName(identity.name));

  if (inserted === undefined) throw new Error("the agent was not written");
  return agentFromRow(inserted);
}

/** Read one agent through the same derived columns, on the caller's connection. */
async function readAgentWithin(
  on: Queryable,
  auth: AuthContext,
  id: string,
): Promise<Agent | undefined> {
  const [row] = await on
    .select(COLUMNS)
    .from(agent)
    .where(theAgentEvenArchived(auth, id))
    .limit(1);
  return row === undefined ? undefined : agentFromRow(row);
}

/**
 * Everything a write to this factory settles before it touches the database:
 * where the rows land, what the agent is called, and the inline connection
 * once its connection-type registry entry has had its say.
 *
 * Pulled out because both write paths do it in the same order and the order is
 * the point — a bad inline connection dies before there is an agent to orphan,
 * and only an input worth writing costs the project-membership read.
 */
async function settled(
  auth: AuthContext,
  input: NewAgent,
): Promise<{
  readonly projectId: string;
  readonly name: string;
  readonly agentPlatform: AgentPlatform;
  readonly inline: AdmittedConnection | undefined;
}> {
  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "an agent belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  const name = validName(input.name, "an agent");
  const inline =
    input.connection === undefined
      ? undefined
      : admitConnection(input.connection);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  return { projectId, name, agentPlatform: input.agentPlatform, inline };
}

export async function createAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<CreatedAgent> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId, name, agentPlatform, inline } = await settled(auth, input);
  const identity = { name, agentPlatform };

  if (inline === undefined) {
    return insertAgentWithin(db(), auth, projectId, identity);
  }

  // Both rows or neither: the transaction is what makes the happy onboarding
  // path unable to produce an agent its own connection failed to reach.
  return db().transaction(async (tx) => {
    const written = await insertAgentWithin(tx, auth, projectId, identity);
    const wired = await insertConnection(
      tx,
      auth,
      {
        id: written.id,
        projectId,
        agentPlatform: written.agentPlatform,
        platformAgentId: written.platformAgentId,
        monitoringApiKeyHint: written.monitoringApiKeyHint,
      },
      inline,
    );
    const standing = await readAgentWithin(tx, auth, written.id);
    if (standing === undefined) throw new Error("the wired agent was not found");
    return { ...standing, connection: wired };
  });
}

/** What a registration turned out to be, once the reuse rule had its say. */
export type RegistrationResult = "created" | "reused" | "connection_added";

export type Registration = {
  readonly result: RegistrationResult;
  readonly agent: Agent;
  /** Absent only when the registration named no connection at all. */
  readonly connection?: Connection;
};

/**
 * Register an identity alone, or atomically register it with an inline connection.
 * With an inline connection, reuse-family identity determines the outcome:
 * - Same type, access variant, and modality: reuse and replace credentials whole.
 * - Same platform agent through another family connection: add a connection.
 * - No identity match: create both rows.
 * Keep the existing agent name on reuse.
 *
 * Apply the full normalized identity rule after SQL candidate filtering. Lock the
 * organization/project/family/normalized identity before reading so concurrent
 * registrations resolve to one agent, even across connection types.
 */
export async function registerAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<Registration> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId, name, agentPlatform, inline } = await settled(auth, input);
  const identity = { name, agentPlatform };

  if (inline === undefined) {
    return {
      result: "created",
      agent: await insertAgentWithin(db(), auth, projectId, identity),
    };
  }

  const reuse = descriptorOf(inline.connectionType).reuse;
  const vendorAgent = reuse?.identityOf(inline.config);

  const bothRows = async (tx: Queryable): Promise<Registration> => {
    const written = await insertAgentWithin(tx, auth, projectId, identity);
    const wired = await insertConnection(
      tx,
      auth,
      {
        id: written.id,
        projectId,
        agentPlatform: written.agentPlatform,
        platformAgentId: written.platformAgentId,
        monitoringApiKeyHint: written.monitoringApiKeyHint,
      },
      inline,
    );
    const standing = await readAgentWithin(tx, auth, written.id);
    if (standing === undefined) throw new Error("the registered agent was not found");
    return {
      result: "created",
      agent: standing,
      connection: wired,
    };
  };

  // A kind with no reuse rule, or a config the rule finds no identity in — an
  // access variant carrying none of its keys — has nothing to match on, so this
  // is `createAgent` with a word for what it did.
  if (reuse === undefined || vendorAgent === undefined) {
    return db().transaction(bothRows);
  }

  // Every connection type whose rule names the same identity namespace — the
  // vendor-id family this registration belongs to. A living connection through
  // any of these doors on the same vendor agent is the same Egma agent.
  const family = reuseFamilyOf(inline.connectionType);

  // What the lock is taken on: this one vendor agent under its family's
  // namespace, in this one project, of this one customer. Every door of one
  // agent shares it, so two doors racing on one agent settle to one rather
  // than one losing to the name index. The identity is the normalized one, so
  // two spellings of one LiveKit server take one lock rather than passing each
  // other on the way to the same insert. Nothing else waits behind it.
  const namespace = reuse.family ?? inline.connectionType;
  const racing = `${auth.organizationId}:${projectId}:${namespace}:${vendorAgent}`;

  return db().transaction(async (tx): Promise<Registration> => {
    // Taken before anything is read, and let go when the transaction ends.
    // Two machines registering one vendor agent at the same instant is the
    // ordinary retry rather than a rare race, so the second one waits here and
    // then reads what the first one wrote instead of colliding with it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${racing}::text, 0))`,
    );

    const candidates = await tx
      .select({ identity: COLUMNS, reached: CONNECTION_COLUMNS })
      .from(connection)
      .innerJoin(agent, eq(connection.agentId, agent.id))
      .where(
        within(
          auth,
          connection,
          and(
            eq(connection.projectId, projectId),
            inArray(connection.connectionType, [...family]),
            // The keys the rule can be narrowed by, and only those: this is a
            // filter that keeps the read small, never the decision.
            ...reuse.matchedKeys.map(
              (key) =>
                sql`${connection.config}->>${key} = ${inline.config[key] ?? null}`,
            ),
            connectionNotArchived,
            notArchived,
          ),
        ),
      )
      .orderBy(asc(connection.id));

    // The decision, taken where the rule can be run whole. A LiveKit worker of
    // one name on two servers narrows to two rows here and is two agents after
    // this line, which is the case the SQL above cannot see. Each row answers
    // under its own type's rule, because a family member is a candidate only
    // when its own rule names the same vendor agent.
    const living = candidates.filter((row) => {
      const rule = descriptorOf(row.reached.connectionType).reuse;
      return (
        rule !== undefined &&
        rule.identityOf(configFromRow(row.reached.config, row.reached.id)) ===
          vendorAgent
      );
    });

    // The exact same door — same connection type, access variant and modality
    // — is a re-registration of this connection, and it rotates the key. A
    // door that only shares the vendor agent is a different lane on that agent
    // and must not be rotated onto: text mode and a chat API are both chat,
    // and one is not the other; a chat dispatch and a voice dispatch of one
    // LiveKit worker each keep a credential of their own.
    const sameDoor = living.find(
      (row) =>
        row.reached.connectionType === inline.connectionType &&
        row.reached.accessVariant === inline.accessVariant &&
        row.reached.modality === inline.modality,
    );

    if (sameDoor !== undefined) {
      const [rotated] = await tx
        .update(connection)
        .set({
          // Whole, never merged: what arrived replaces what is stored, and a
          // variant that takes no secret clears both columns together, which is
          // what the row's own CHECK demands.
          credentials: inline.credentials,
          credentialsHint: inline.credentialsHint,
          updatedAt: new Date(),
        })
        .where(eq(connection.id, sameDoor.reached.id))
        .returning(CONNECTION_COLUMNS);

      if (rotated === undefined) {
        throw new Error("the connection was not rotated");
      }
      return {
        result: "reused",
        agent: agentFromRow(sameDoor.identity),
        connection: connectionFromRow(
          rotated,
          sameDoor.identity.agentPlatform as AgentPlatform,
        ),
      };
    }

    // The same vendor agent reached through a different door. Oldest first, so
    // which agent gains the connection is the same answer every time.
    const known = living[0];
    if (known !== undefined) {
      const home = agentFromRow(known.identity);
      const wired = await insertConnection(
        tx,
        auth,
        {
          id: home.id,
          projectId,
          agentPlatform: home.agentPlatform,
          platformAgentId: home.platformAgentId,
          monitoringApiKeyHint: home.monitoringApiKeyHint,
        },
        inline,
      );
      const standing = await readAgentWithin(tx, auth, home.id);
      if (standing === undefined) throw new Error("the extended agent was not found");
      return {
        result: "connection_added",
        agent: standing,
        connection: wired,
      };
    }

    return bothRows(tx);
  });
}

/**
 * One agent, archived or not.
 *
 * **An archived agent reads.** Its runs still open, its detail page still
 * answers, and Restore has something to find — which is the whole difference
 * between Archive and the deletion this replaced. What archiving takes away is
 * entry into *new* work, and that is enforced where new work is created rather
 * than by making the row invisible.
 */
export async function getAgent(
  auth: AuthContext,
  id: string,
): Promise<Agent | undefined> {
  authorize(auth, "read", here(auth));
  return readAgentWithin(db(), auth, id);
}

const DEFAULT_PAGE_SIZE = 50;
const LARGEST_PAGE_SIZE = 200;

/**
 * Fetch active connections for the whole agent page in one query, then group by agent.
 * Apply organization and project scope again on this query.
 */
async function connectionsOf(
  auth: AuthContext,
  agents: readonly Agent[],
): Promise<readonly AgentWithConnections[]> {
  if (agents.length === 0) return [];

  const rows = await db()
    .select(CONNECTION_COLUMNS)
    .from(connection)
    .where(
      within(
        auth,
        connection,
        and(
          inArray(
            connection.agentId,
            agents.map((one) => one.id),
          ),
          connectionNotArchived,
        ),
      ),
    )
    .orderBy(asc(connection.id));

  const platformOf = new Map(
    agents.map((one) => [one.id, one.agentPlatform] as const),
  );
  const held = new Map<string, Connection[]>();
  for (const row of rows) {
    const homePlatform = platformOf.get(row.agentId);
    if (homePlatform === undefined) {
      throw new Error(`connection ${row.id} has no agent in this page`);
    }
    const one = connectionFromRow(row, homePlatform);
    const already = held.get(one.agentId);
    if (already === undefined) held.set(one.agentId, [one]);
    else already.push(one);
  }

  // An agent with none keeps an empty list rather than losing the field. "No
  // way in" is a fact a list has to be able to show, and a missing key would
  // read as "nobody asked".
  return agents.map((one) => ({ ...one, connections: held.get(one.id) ?? [] }));
}

/**
 * List newest agents first with an ID cursor. UUIDv7-derived IDs under C collation
 * provide time ordering. Fetch active connections in one additional page-wide query.
 */
export async function listAgents(
  auth: AuthContext,
  page?: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
    /**
     * Part of a name, matched without regard to case. A list of forty agents
     * is a list; a list of four hundred is a search box, and one that filtered
     * only the page already fetched would answer differently depending on how
     * far somebody had scrolled.
     */
    readonly search?: string | undefined;
    /**
     * Which half of the project to show. `active` is the authoring list and the
     * default; `archived` is the explicit filter that makes removal reversible
     * by making what was removed findable. There is deliberately no `both` —
     * a mixed list would need a column saying which each row is, and the two
     * halves are asked for by different questions.
     */
    readonly archived?: boolean | undefined;
  },
): Promise<AgentPage> {
  authorize(auth, "read", here(auth));

  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LARGEST_PAGE_SIZE) {
    throw new Error(`a page holds between 1 and ${LARGEST_PAGE_SIZE} agents`);
  }
  const cursor = page?.cursor;
  if (cursor !== undefined && !isId("agt", cursor)) {
    throw new Error(`"${cursor}" is not an agent id, so it cannot be a cursor`);
  }

  const olderThanCursor =
    cursor === undefined ? undefined : lt(agent.id, cursor);

  const wanted = page?.search?.trim();
  // `ilike` with the pattern's own wildcards escaped, so a name containing a
  // percent sign is searched for rather than treated as "anything".
  const named =
    wanted === undefined || wanted === ""
      ? undefined
      : ilike(agent.name, `%${wanted.replace(/([\\%_])/g, "\\$1")}%`);

  const half =
    page?.archived === true ? isNotNull(agent.archivedAt) : notArchived;

  // One row beyond the page answers "is there more?" without a second query.
  const rows = await db()
    .select(COLUMNS)
    .from(agent)
    .where(
      within(
        auth,
        agent,
        and(half, named, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(agent.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit).map(agentFromRow);
  return {
    items: await connectionsOf(auth, items),
    // Read off the agent rows rather than off the widened items: the cursor is
    // an agent id and stays one, whatever else now travels beside it.
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * Rename in place without a content version or revision check; concurrent edits
 * use the last write. No-op updates preserve updated_at. Unseen agents return undefined.
 */
export async function updateAgent(
  auth: AuthContext,
  id: string,
  changes: AgentChanges,
): Promise<Agent | undefined> {
  authorize(auth, "configure_agents", here(auth));

  const name =
    changes.name === undefined
      ? undefined
      : validName(changes.name, "an agent");

  if (name === undefined) return getAgent(auth, id);

  const [updated] = await db()
    .update(agent)
    .set({ name, updatedAt: new Date() })
    .where(theAgent(auth, id))
    .returning(COLUMNS)
    .catch((error: unknown) => {
      refusingHeldAgentName(name)(error);
      throw error;
    });

  if (updated !== undefined) return agentFromRow(updated);
  return undefined;
}

/*
 * **There is no "this agent cannot be mocked" refusal here any more.** There
 * was one: turning the web-call mock switch on demanded that the agent already
 * held Retell's own identity for it and a sealed key, because a temporary copy
 * cannot be branched without both. The switch is gone with the project-owned
 * mocked world, so there is nothing at connection-write time left to refuse —
 * whether a run mocks anything is decided by the tests it executes, and the
 * demand for an identity and a key belongs where the run is started.
 */

/**
 * Require an acting project for agent creation, archive, and restore.
 * Connection writes inherit their agent's project. HTTP resolves this context
 * before calling; direct access-layer callers must supply it too.
 */
function guardProjectScoped(auth: AuthContext, what: string): void {
  if (auth.projectId === undefined) {
    throw new Error(
      `${what} an agent happens inside its project, and this credential is ` +
        `for the whole organization and acting in none`,
    );
  }
}

/**
 * Archive the agent and active connections in one transaction, stopping pending
 * and active work while preserving past evidence. Restoring the agent does not
 * restore connections or their old credentials.
 */
export async function archiveAgent(
  auth: AuthContext,
  id: string,
): Promise<ArchivedAgent | undefined> {
  authorize(auth, "configure_agents", here(auth));

  guardProjectScoped(auth, "archiving");

  const now = new Date();

  return db().transaction(async (tx): Promise<ArchivedAgent | undefined> => {
    const [archived] = await tx
      .update(agent)
      /*
       * Archiving releases the production watch the way it releases the
       * agent's name: the one-watcher claim belongs to the living. Without
       * this, the archived row keeps `agent_pulled_platform_agent_unique`
       * held and keeps being polled, and the next agent bound to the same
       * platform agent is refused by a row no screen can show. The sealed
       * key and the monitoring history stay, exactly as stopping leaves
       * them.
       */
      .set({ archivedAt: now, updatedAt: now, pullProductionCalls: false })
      .where(
        theAgent(auth, id),
      )
      .returning(COLUMNS);

    if (archived === undefined) {
      // Archiving an already-archived agent is nothing to do rather than a
      // refusal: the caller wanted it out of new work and it is out of new
      // work. A conflict is only a conflict when the row is still active.
      const [standing] = await tx
        .select(COLUMNS)
        .from(agent)
        .where(theAgentEvenArchived(auth, id))
        .limit(1);
      if (standing === undefined) return undefined;
      if (standing.archivedAt !== null) {
        return {
          agent: agentFromRow(standing),
          connections: [],
          canceledRunCount: 0,
        };
      }
      return undefined;
    }

    const children = await tx
      .update(connection)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        within(
          auth,
          connection,
          and(eq(connection.agentId, id), connectionNotArchived),
        ),
      )
      .returning({ id: connection.id });

    const canceledRunCount = await stopWorkOverConnections(
      tx,
      auth,
      children.map((row) => row.id),
      now,
    );

    return {
      agent: agentFromRow(archived),
      connections: children.map((row) => row.id),
      canceledRunCount,
    };
  });
}

/**
 * Restore only the agent; connections require separate restoration with new
 * credential decisions. Refuse a taken name unless the caller supplies a replacement.
 */
export async function restoreAgent(
  auth: AuthContext,
  id: string,
  options: {
    /** A different name, when the old one has been taken. */
    readonly name?: string | undefined;
  } = {},
): Promise<Agent | undefined> {
  authorize(auth, "configure_agents", here(auth));

  // Restore is the same decision as Archive, taken the other way: it is about
  // whether this agent appears in a project. It was missing this guard while
  // Archive had it, which made the pair answer an organization-wide credential
  // two different ways for one decision.
  guardProjectScoped(auth, "restoring");

  const name =
    options.name === undefined ? undefined : validName(options.name, "an agent");
  const now = new Date();

  // What this Restore is asking to be called: the replacement, or — when it
  // brought none — the name the row already carries, which is the one the
  // unique index will refuse it.
  const [held] = await db()
    .select({ name: agent.name })
    .from(agent)
    .where(theAgentEvenArchived(auth, id))
    .limit(1);
  const wanted = name ?? held?.name ?? "";

  const [restored] = await db()
    .update(agent)
    .set({
      archivedAt: null,
      ...(name === undefined ? {} : { name }),
      updatedAt: now,
    })
    .where(
      and(
        theAgentEvenArchived(auth, id),
        isNotNull(agent.archivedAt),
      ),
    )
    .returning(COLUMNS)
    .catch((error: unknown) => {
      // The name is the row's own when the Restore brought no replacement, and
      // the constraint is what discovers that somebody else has taken it.
      if (lostToConstraint(error, "agent_project_id_name_unique")) {
        throw new AgentWriteRefusedError(
          "name_taken",
          nameTakenMessage(wanted, "agent"),
        );
      }
      throw error;
    });

  if (restored !== undefined) return agentFromRow(restored);

  const [standing] = await db()
    .select(COLUMNS)
    .from(agent)
    .where(theAgentEvenArchived(auth, id))
    .limit(1);
  if (standing === undefined) return undefined;
  // Restoring an active agent is nothing to do, exactly as archiving an
  // archived one is.
  if (standing.archivedAt === null) return agentFromRow(standing);
  return undefined;
}

/**
 * Name the requested restore name, including when it comes from the archived row.
 * Do not identify the conflicting row, which the caller may not be allowed to see.
 */
function nameTakenMessage(name: string, resource: "agent" | "connection"): string {
  return (
    `The name ${name} is already used by an active ${resource}. ` +
    `Choose a different name in Restore and try again.`
  );
}

/**
 * A connection attached to an agent the caller can already see. Answers
 * `undefined` when the agent is out of reach, exactly as fetching the agent
 * would — the caller cannot tell an invisible agent from an absent one, and
 * neither can this.
 */
export async function addConnection(
  auth: AuthContext,
  agentId: string,
  input: NewConnection,
): Promise<Connection | undefined> {
  authorize(auth, "configure_agents", here(auth));

  const admitted = admitConnection(input);

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;
  // A new way of reaching an archived agent is new work over something that
  // has been taken out of new work. Restore the agent first.
  if (home.archivedAt !== null) {
    throw new ConnectionRestoreRefusedError(
      "parent_agent_archived",
      `Connection cannot be added while agent ${agentId} is archived. ` +
        `Restore the agent first, then add this connection.`,
      { agentId },
    );
  }

  return insertConnection(db(), auth, home, admitted);
}

/**
 * Read only the connection type by ID for the phone-setup gate before run creation.
 * Use startRun's active-agent, active-connection, organization, and project scope.
 * Do not expose configuration or credentials.
 */
export async function connectionTypeOf(
  auth: AuthContext,
  connectionId: string,
): Promise<ConnectionType | undefined> {
  authorize(auth, "read", here(auth));

  // A run happens inside a project, so a credential acting in none is one
  // `startRun` will refuse for that reason and in those words. Answering
  // nothing here leaves it to say so.
  const { projectId } = auth;
  if (projectId === undefined) return undefined;
  if (!isId("con", connectionId)) return undefined;

  const [row] = await db()
    .select({ connectionType: connection.connectionType })
    .from(connection)
    .innerJoin(agent, eq(connection.agentId, agent.id))
    .where(
      within(
        auth,
        connection,
        and(
          eq(connection.id, connectionId),
          eq(connection.projectId, projectId),
          connectionNotArchived,
          isNull(agent.archivedAt),
        ),
      ),
    )
    .limit(1);

  // The column is text, as every enum-shaped column in this schema is, and the
  // registry is what decides which strings are connection types. The cast is the same one
  // `connectionFromRow` makes for the same reason, in the same file.
  return row === undefined
    ? undefined
    : (row.connectionType as ConnectionType);
}

export async function getConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): Promise<Connection | undefined> {
  authorize(auth, "read", here(auth));

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;

  const [row] = await db()
    .select(CONNECTION_COLUMNS)
    .from(connection)
    .where(theConnection(auth, agentId, connectionId))
    .limit(1);

  return row === undefined
    ? undefined
    : connectionFromRow(row, home.agentPlatform);
}

/**
 * List active or archived connections oldest first.
 * Return undefined for an unseen agent and [] for one without matching connections.
 */
export async function listConnections(
  auth: AuthContext,
  agentId: string,
  options: { readonly archived?: boolean | undefined } = {},
): Promise<readonly Connection[] | undefined> {
  authorize(auth, "read", here(auth));

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;

  const half =
    options.archived === true
      ? isNotNull(connection.archivedAt)
      : connectionNotArchived;

  const rows = await db()
    .select(CONNECTION_COLUMNS)
    .from(connection)
    .where(
      within(auth, connection, and(eq(connection.agentId, agentId), half)),
    )
    .orderBy(asc(connection.id));

  return rows.map((row) => connectionFromRow(row, home.agentPlatform));
}

/**
 * Update name, environment, and config in place. Validate config against the stored
 * access variant; replace credentials whole with a new IV or leave them unchanged.
 * Agent platform, connection type, access variant, and modality are immutable.
 * Return undefined for connections outside the caller's scope.
 */
export async function updateConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
  changes: ConnectionChanges,
): Promise<Connection | undefined> {
  authorize(auth, "configure_agents", here(auth));

  // The changes type has no such fields, but a caller reaching this from
  // looser code — a request body, a spread — must hear the rule, not watch
  // an edit quietly drop half its payload.
  for (const immutable of [
    "agentPlatform",
    "connectionType",
    "accessVariant",
    "modality",
    "topology",
  ] as const) {
    if (immutable in changes) {
      throw new Error(
        `a connection's ${immutable} never changes: what a connection is, ` +
          `is a new connection`,
      );
    }
  }

  const name =
    changes.name === undefined
      ? undefined
      : validName(changes.name, "a connection");

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;

  const [current] = await db()
    .select({
      id: connection.id,
      connectionType: connection.connectionType,
      accessVariant: connection.accessVariant,
      config: connection.config,
      archivedAt: connection.archivedAt,
    })
    .from(connection)
    .where(theConnection(auth, agentId, connectionId))
    .limit(1);
  if (current === undefined) return undefined;

  // The registry rules are the row's own access variant's — which cannot have changed
  // since the read above, because nothing can change it at all.
  const connectionType = current.connectionType as ConnectionType;
  const accessVariant = current.accessVariant as AccessVariant;

  const config =
    changes.config === undefined
      ? undefined
      : validConfig(connectionType, accessVariant, changes.config);

  // The stored access variant owns the credential rule. An edit can replace
  // the credential, but cannot turn this connection into another variant.
  const sealed =
    changes.credentials === undefined
      ? undefined
      : validCredentials(
          connectionType,
          accessVariant,
          changes.credentials,
        );

  const [updated] = await db()
    .update(connection)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(changes.environment === undefined
        ? {}
        : { environment: changes.environment }),
      ...(config === undefined ? {} : { config }),
      ...(sealed === undefined || sealed === null
        ? {}
        : {
            credentials: sealCredentials(sealed.sealed),
            credentialsHint: sealed.hint,
          }),
      updatedAt: new Date(),
    })
    .where(
      and(
        theConnection(auth, agentId, connectionId),
      ),
    )
    .returning(CONNECTION_COLUMNS)
    .catch(
      // Only a name change can lose to the name constraint.
      name === undefined
        ? (error: unknown) => {
            throw error;
          }
        : refusingHeldConnectionName(name),
    );

  return updated === undefined
    ? undefined
    : connectionFromRow(updated, home.agentPlatform);
}

/**
 * Archive any connection, including the last one. Block new claims, settle queued
 * work, and request active-work cancellation at heartbeat. Preserve all past evidence.
 */
export async function archiveConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): Promise<ArchivedConnection | undefined> {
  authorize(auth, "configure_agents", here(auth));

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;

  const now = new Date();

  return db().transaction(async (tx) => {
    const [archived] = await tx
      .update(connection)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          theConnection(auth, agentId, connectionId),
          connectionNotArchived,
        ),
      )
      .returning(CONNECTION_COLUMNS);

    if (archived === undefined) {
      const [standing] = await tx
        .select(CONNECTION_COLUMNS)
        .from(connection)
        .where(theConnection(auth, agentId, connectionId))
        .limit(1);
      if (standing === undefined) return undefined;
      if (standing.archivedAt !== null) {
        return {
          connection: connectionFromRow(standing, home.agentPlatform),
          canceledRunCount: 0,
        };
      }
      return undefined;
    }

    const canceledRunCount = await stopWorkOverConnections(
      tx,
      auth,
      [connectionId],
      now,
    );

    return {
      connection: connectionFromRow(archived, home.agentPlatform),
      canceledRunCount,
    };
  });
}

/**
 * Restore only under an active agent. Required credentials must be replaced;
 * forbidden credentials are rejected; optional credentials require replace or clear.
 * Clear removes the archived envelope. Never reactivate the old secret.
 */
export async function restoreConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
  options: {
    readonly name?: string | undefined;
    readonly credential?: RestoreCredential | undefined;
  } = {},
): Promise<Connection | undefined> {
  authorize(auth, "configure_agents", here(auth));

  const home = await visibleAgent(auth, agentId);
  if (home === undefined) return undefined;

  const [current] = await db()
    .select({
      id: connection.id,
      name: connection.name,
      connectionType: connection.connectionType,
      accessVariant: connection.accessVariant,
      config: connection.config,
      archivedAt: connection.archivedAt,
    })
    .from(connection)
    .where(theConnection(auth, agentId, connectionId))
    .limit(1);
  if (current === undefined) return undefined;

  // Nothing to do, and answered as the read would answer — the same shape a
  // second Archive of an archived row gets.
  if (current.archivedAt === null) {
    return getConnection(auth, agentId, connectionId);
  }

  if (home.archivedAt !== null) {
    throw new ConnectionRestoreRefusedError(
      "parent_agent_archived",
      `Connection ${connectionId} cannot be restored while agent ${agentId} ` +
        `is archived. Restore the agent first, then restore this connection.`,
      { agentId },
    );
  }

  const connectionType = current.connectionType as ConnectionType;
  const accessVariant = current.accessVariant as AccessVariant;
  const variant = accessVariantById(connectionType, accessVariant);
  const rule = credentialRuleOf(variant);
  const supplied = options.credential;

  if (rule === "required" && supplied?.choice !== "replace") {
    throw new ConnectionRestoreRefusedError(
      "credential_required",
      `Connection ${connectionId} uses ${connectionType}, which requires a new ` +
        `credential after Archive. Enter a new credential and restore it again.`,
      { connectionId, connectionType },
    );
  }
  if (rule === "forbidden" && supplied?.choice === "replace") {
    throw new ConnectionRestoreRefusedError(
      "credential_forbidden",
      `Connection ${connectionId} uses ${connectionType}, which does not accept ` +
        `customer credentials. Remove the credential and restore it again.`,
      { connectionId, connectionType },
    );
  }
  if (rule === "optional" && supplied === undefined) {
    throw new ConnectionRestoreRefusedError(
      "credential_choice_required",
      `Connection ${connectionId} uses ${connectionType}, which has an optional ` +
        `credential. Choose Replace and enter a new credential, or choose ` +
        `Clear, then restore it again.`,
      { connectionId, connectionType },
    );
  }

  const sealed =
    supplied?.choice === "replace"
      ? validCredentials(
          connectionType,
          accessVariant,
          supplied.credentials,
        )
      : null;

  const name =
    options.name === undefined
      ? undefined
      : validName(options.name, "a connection");
  const now = new Date();

  const [restored] = await db()
    .update(connection)
    .set({
      archivedAt: null,
      ...(name === undefined ? {} : { name }),
      // Replace seals the new one; every other path clears the envelope, so no
      // archived credential can ever become live again.
      credentials: sealed === null ? null : sealCredentials(sealed.sealed),
      credentialsHint: sealed === null ? null : sealed.hint,
      updatedAt: now,
    })
    .where(
      and(
        theConnection(auth, agentId, connectionId),
        isNotNull(connection.archivedAt),
      ),
    )
    .returning(CONNECTION_COLUMNS)
    .catch((error: unknown) => {
      if (lostToConstraint(error, "connection_agent_id_name_unique")) {
        throw new AgentWriteRefusedError(
          "name_taken",
          // `current` was read above and carries the row's own name, which is
          // what a Restore bringing no replacement is asking for.
          nameTakenMessage(name ?? current.name, "connection"),
        );
      }
      throw error;
    });

  return restored === undefined
    ? undefined
    : connectionFromRow(restored, home.agentPlatform);
}
