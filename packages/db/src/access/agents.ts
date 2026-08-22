import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
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
import { sealCredentials } from "../sealing.ts";
import {
  credentialRuleOf,
  descriptorOf,
  platformOfConnectionType,
  productLabelOf,
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
 * Reading and writing agents and their connections — what they are is the
 * schema file's story (`schema/agents.ts`); this file is how they are reached.
 *
 * The agent is the aggregate root of the factory: every connection verb takes
 * the agent's id, because a connection is how you reach an agent and there is
 * no path to one that doesn't name its agent first. A connection named through
 * the wrong agent — or the wrong customer — answers exactly what a connection
 * that doesn't exist answers.
 *
 * Project scoping works as the persona factory's does. A context acting
 * in a project writes and reads there; a context acting in none — an
 * organization-scoped credential — reaches the whole customer. It creates no
 * agent and deletes none, because an agent belongs to a project and a
 * credential for the whole customer is acting in none; the connection verbs
 * it may use, because a connection lands in the project its agent already
 * names.
 *
 * Credentials pass through here once, sealed on the way in (create and
 * whole-object rotation) and never opened on the way out: every read shape
 * omits the field entirely, so leaking a secret through a serializer is a
 * compile error rather than a review catch. The one door to the plaintext is
 * the dispatch path's `resolveSimulationConnection`, beside the claim that
 * mints the only kind of context it opens for. (This file's own role-gated
 * resolver was retired on 2026-08-08 without ever gaining a production
 * caller: the caller it imagined — something resolving credentials as a run
 * starts — is exactly what the claim's door replaced, refusing by how a
 * context came to exist rather than by what a role permits.)
 */

export type NewConnection = {
  /** Defaults from the product label, so onboarding never stalls. */
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
  readonly agentPlatform: AgentPlatform | null;
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
 * What a Restore brings for the credential, and why the third case is a choice
 * rather than an absence.
 *
 * An access variant whose credential is `optional` genuinely works either way, so a
 * Restore that simply left it out could mean two opposite things — *keep going
 * without one* and *I forgot* — and the archived envelope is still sitting
 * there for one of those readings to silently reuse. So the author says which:
 * `replace` with a new credential, or `clear`, which removes the stored
 * envelope outright. Nothing about Restore ever reuses what was sealed before.
 */
export type RestoreCredential =
  | { readonly choice: "replace"; readonly credentials: Readonly<Record<string, unknown>> }
  | { readonly choice: "clear" };

export type NewAgent = {
  readonly name: string;
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
  /** Which platform runs this agent, or null while nobody has bound it. */
  readonly agentPlatform: AgentPlatform | null;
  /** That platform's own id for it, or null. */
  readonly platformAgentId: string | null;
  /** The last characters of the sealed monitoring key, or null. */
  readonly monitoringApiKeyHint: string | null;
  /** The declared pull switch. Off until somebody turns it on. */
  readonly pullProductionCalls: boolean;
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
 * An agent as a list of them answers it: its identity, and every living way
 * egma can reach it.
 *
 * **The connections travel with the agent because they are the question the
 * list exists to answer.** Which agents egma can reach, and how, is what
 * somebody opens a list of agents to find out. A shape that answered only the
 * names would make that one request per row, and a project of four hundred
 * agents would ask four hundred times for what one read already holds.
 *
 * They are the *active* ones, always, and the split is the one
 * `listConnections` already keeps: an archived connection is how egma used to
 * reach an agent, which is a different question and is asked separately. An
 * archived agent, whose Archive took its connections with it, therefore
 * carries none — which is the truth about it rather than a gap in the read.
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
  readonly agentPlatform: string | null;
  readonly platformAgentId: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly pullProductionCalls: boolean;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The platform column is narrowed by assertion; its CHECK already refuses the rest. */
function agentFromRow(row: AgentRow): Agent {
  return { ...row, agentPlatform: row.agentPlatform as AgentPlatform | null };
}

const notArchived: SQL = isNull(agent.archivedAt);
const connectionNotArchived: SQL = isNull(connection.archivedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: agent.id,
  projectId: agent.projectId,
  name: agent.name,
  agentPlatform: agent.agentPlatform,
  platformAgentId: agent.platformAgentId,
  monitoringApiKeyHint: agent.monitoringApiKeyHint,
  pullProductionCalls: agent.pullProductionCalls,
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
 * Whether this write lost to a live row already holding the name. Read from
 * the constraint's own name, walking the `cause` chain because the query layer
 * may hand the driver's error back wrapped — recognising it by message
 * substring would break silently the day the text changed.
 *
 * Exported to the module, not from the package: every factory with a
 * uniqueness rule owes the loser a sentence rather than a driver error, and one
 * of them recognising the loss differently from another is how a race comes to
 * be answered as a fault on one path and as an answer on the next.
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
      agentPlatform: AgentPlatform | null;
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
      archivedAt: agent.archivedAt,
    })
    .from(agent)
    .where(theAgentEvenArchived(auth, agentId))
    .limit(1);
  return row === undefined
    ? undefined
    : { ...row, agentPlatform: row.agentPlatform as AgentPlatform | null };
}

/**
 * The shape guard on every read of stored key-value data. Jsonb — and an
 * opened envelope — comes back `unknown`, and a row somebody hand-edited must
 * fail here, loudly and naming itself, rather than leak into a caller as a
 * shape it isn't. Shape only, deliberately: the registry's demands may
 * tighten later, and an old row must stay readable exactly as it was written.
 *
 * Exported for the one sibling that also reads a connection's stored shapes —
 * the simulator's connection door in `runs.ts` — so the two files cannot
 * drift into two ideas of what a well-formed row is. It is not on the
 * package's surface.
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
   * The platform its agent is bound to, or null. **Required, with no default**:
   * a default would silently drop the second half of the rule and let a
   * `phone_number` connection on a Retell agent read back as belonging to no
   * platform — and read back differently from the way it was written.
   */
  agentPlatformOfAgent: AgentPlatform | null,
): Connection {
  const connectionType = row.connectionType as ConnectionType;
  // The type answers where it pins one platform; otherwise the agent answers,
  // and where the agent is unbound nobody does. See ADR-0015.
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
  const modality = validModality(input.connectionType, input.modality);
  // This validates the complete supported tuple. The label is deliberately
  // discarded here because it is derived again on reads.
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

/**
 * The smallest free `<kind>-<n>` among the agent's living names, so an unnamed
 * add always lands — a removed connection's number comes back into play the
 * same way its name does.
 */
async function freeDefaultName(
  on: Queryable,
  agentId: string,
  connectionType: ConnectionType,
): Promise<string> {
  const taken = new Set(
    (
      await on
        .select({ name: connection.name })
        .from(connection)
        .where(and(eq(connection.agentId, agentId), connectionNotArchived))
    ).map((row) => row.name),
  );

  for (let n = 1; ; n += 1) {
    const candidate = `${connectionType}-${n}`;
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
    readonly agentPlatform: AgentPlatform | null;
  },
  admitted: AdmittedConnection,
): Promise<Connection> {
  const name =
    admitted.name ??
    (await freeDefaultName(on, home.id, admitted.connectionType));

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
  return connectionFromRow(inserted, home.agentPlatform);
}

/**
 * The insert every agent-writing path shares, wherever the caller is in a
 * transaction. It owns the friendly refusal for the moment a living agent in
 * the project already holds the name.
 */
async function insertAgent(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  identity: { readonly name: string },
): Promise<Agent> {
  const [inserted] = await on
    .insert(agent)
    .values({
      id: newId("agt"),
      organizationId: auth.organizationId,
      projectId,
      name: identity.name,
      createdBy: auth.userId,
    })
    .returning(COLUMNS)
    .catch(refusingHeldAgentName(identity.name));

  if (inserted === undefined) throw new Error("the agent was not written");
  return agentFromRow(inserted);
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

  return { projectId, name, inline };
}

export async function createAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<CreatedAgent> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId, name, inline } = await settled(auth, input);
  const identity = { name };

  if (inline === undefined) {
    return insertAgent(db(), auth, projectId, identity);
  }

  // Both rows or neither: the transaction is what makes the happy onboarding
  // path unable to produce an agent its own connection failed to reach.
  return db().transaction(async (tx) => {
    const written = await insertAgent(tx, auth, projectId, identity);
    const wired = await insertConnection(
      tx,
      auth,
      { id: written.id, projectId, agentPlatform: written.agentPlatform },
      inline,
    );
    return { ...written, connection: wired };
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
 * Register an agent, and answer whether that meant creating one.
 *
 * `createAgent` writes what it is given and refuses a name a living agent
 * already holds. That is the right answer for somebody registering a second
 * agent by hand, and the wrong one for the path this exists for: a developer's
 * `connect`, and the coding agent that retries it after an uncertain network
 * failure. Minting a second identity for one vendor agent splits a team's
 * results history in half, which is the one thing that must not happen quietly.
 *
 * So the connection type's reuse key decides (`connection-registry.ts`), and a living
 * connection in the project naming the same vendor agent decides the outcome:
 *
 * - **same modality** → that agent and that connection answer, with the
 *   supplied credential replacing the stored one **whole**. Rotation never
 *   asks for the old secret and never merges into it, so plaintext has no
 *   reason to travel back out. `reused`.
 * - **a different modality** → the same agent gains a new connection, because
 *   a chat endpoint and a voice endpoint on one vendor agent are two ways to
 *   reach one thing. `connection_added`.
 * - **no match, or a kind with no reuse key at all** → both rows, exactly as
 *   `createAgent` writes them. `created`.
 *
 * The reused and extended paths answer the agent as it stands and leave its
 * name alone: the registration named an identity that already
 * exists, and quietly renaming somebody's agent because a second machine typed
 * it differently would be a change nobody asked for.
 *
 * **Racing registrations settle to one agent.** Two identical creates arriving
 * together would both find nothing, both insert, and one would lose to the
 * name index — an error where a retry-safe path must answer. The transaction
 * takes an advisory lock on the vendor agent first, so the second one reads
 * the first one's committed work and reuses it.
 */
export async function registerAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<Registration> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId, name, inline } = await settled(auth, input);
  const identity = { name };

  if (inline === undefined) {
    return {
      result: "created",
      agent: await insertAgent(db(), auth, projectId, identity),
    };
  }

  const reuseKey = descriptorOf(inline.connectionType).reuseKey;
  const vendorAgent =
    reuseKey === undefined ? undefined : inline.config[reuseKey];

  const bothRows = async (tx: Queryable): Promise<Registration> => {
    const written = await insertAgent(tx, auth, projectId, identity);
    return {
      result: "created",
      agent: written,
      connection: await insertConnection(
        tx,
        auth,
        { id: written.id, projectId, agentPlatform: written.agentPlatform },
        inline,
      ),
    };
  };

  // A kind with no reuse key has nothing to match on, so this is `createAgent`
  // with a word for what it did.
  if (reuseKey === undefined || vendorAgent === undefined) {
    return db().transaction(bothRows);
  }

  // What the lock is taken on: this one vendor agent, in this one project, of
  // this one customer. Nothing else waits behind it.
  const racing = `${auth.organizationId}:${projectId}:${inline.connectionType}:${vendorAgent}`;

  return db().transaction(async (tx): Promise<Registration> => {
    // Taken before anything is read, and let go when the transaction ends.
    // Two machines registering one vendor agent at the same instant is the
    // ordinary retry rather than a rare race, so the second one waits here and
    // then reads what the first one wrote instead of colliding with it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${racing}::text, 0))`,
    );

    const living = await tx
      .select({ identity: COLUMNS, reached: CONNECTION_COLUMNS })
      .from(connection)
      .innerJoin(agent, eq(connection.agentId, agent.id))
      .where(
        within(
          auth,
          connection,
          and(
            eq(connection.projectId, projectId),
            eq(connection.connectionType, inline.connectionType),
            eq(connection.accessVariant, inline.accessVariant),
            sql`${connection.config}->>${reuseKey} = ${vendorAgent}`,
            connectionNotArchived,
            notArchived,
          ),
        ),
      )
      .orderBy(asc(connection.id));

    const sameModality = living.find(
      (row) => row.reached.modality === inline.modality,
    );

    if (sameModality !== undefined) {
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
        .where(eq(connection.id, sameModality.reached.id))
        .returning(CONNECTION_COLUMNS);

      if (rotated === undefined) {
        throw new Error("the connection was not rotated");
      }
      return {
        result: "reused",
        agent: agentFromRow(sameModality.identity),
        connection: connectionFromRow(
          rotated,
          sameModality.identity.agentPlatform as AgentPlatform | null,
        ),
      };
    }

    // The same vendor agent reached a different way. Oldest first, so which
    // agent gains the connection is the same answer every time.
    const known = living[0];
    if (known !== undefined) {
      const home = agentFromRow(known.identity);
      return {
        result: "connection_added",
        agent: home,
        connection: await insertConnection(
          tx,
          auth,
          { id: home.id, projectId, agentPlatform: home.agentPlatform },
          inline,
        ),
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

  const [row] = await db()
    .select(COLUMNS)
    .from(agent)
    .where(theAgentEvenArchived(auth, id))
    .limit(1);
  return row === undefined ? undefined : agentFromRow(row);
}

const DEFAULT_PAGE_SIZE = 50;
const LARGEST_PAGE_SIZE = 200;

/**
 * The living connections of every agent on one page, fetched together.
 *
 * **One query for the page, never one per row.** Asking for each agent's
 * connections as each agent is read is the shape that turns a list of fifty
 * agents into fifty-one round trips, and it degrades exactly where it hurts —
 * on the biggest projects. So the whole page's ids go down in a single `in`
 * and the answer is grouped back up here.
 *
 * The tenancy predicate is the same one every other read of a connection
 * carries. The agents were already narrowed to what this context may see, but
 * a second query is a second chance to read somebody else's row, and a filter
 * that is only implied by an earlier query is one that a later refactor drops
 * with nothing saying so.
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
    const one = connectionFromRow(row, platformOf.get(row.agentId) ?? null);
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
 * One page of the agents the caller can reach — the acting project's, or the
 * whole customer's for a credential acting in none — and where the next page
 * starts.
 *
 * The ids are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by
 * id *is* ordering by mint time and the last id of a page is the whole cursor
 * — no second sort column, no offset to drift when rows arrive mid-scroll.
 * Newest first, because the agent somebody is looking for is usually the one
 * they just registered.
 *
 * **Every agent comes back with its living connections on it.** That costs one
 * more query for the whole page and saves one per row, and it is what lets a
 * list say which agents egma can reach without opening every one of them.
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
 * The name, in place.
 *
 * There is no content version to move — the agent is deliberately unversioned,
 * because its real content lives at the provider where egma cannot freeze it —
 * so a rename is just a rename and the run history stays the change record.
 *
 * There is no revision either: the column was dropped pre-launch (ADR-0015),
 * so two people editing one agent from two browsers is silent
 * last-writer-wins. Accepted with eyes open — it is the exact failure the
 * column existed to stop.
 *
 * A change that changes nothing is still not an edit: nothing is written, not
 * even `updated_at`. Editing what the caller cannot see returns what reading it
 * would have: `undefined`.
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

  if (name === undefined) {
    return getAgent(auth, id);
  }

  const [updated] = await db()
    .update(agent)
    .set({ name, updatedAt: new Date() })
    .where(theAgent(auth, id))
    .returning(COLUMNS)
    .catch(refusingHeldAgentName(name));

  if (updated !== undefined) return agentFromRow(updated);
  return undefined;
}

/**
 * The rule this family holds an organization-wide credential to, and where it
 * is held.
 *
 * **Deciding whether an agent appears in a project is an act taken from inside
 * that project**, and a credential minted for the whole customer is acting in
 * none — the stance `createAgent` takes, and the one the grader, persona and
 * mock-tool factories take for their own project-scoped writes. Archive and
 * Restore are the two halves of that one decision, so both are held to it.
 *
 * A connection is deliberately not: it lands in the project its agent already
 * names, so archiving one decides nothing about which project anything belongs
 * to. That asymmetry is the rule rather than an oversight, and it matches
 * `addConnection`, which has never asked either.
 *
 * **Nothing reaches this from HTTP.** The API resolves an acting project for
 * every write in the group before it calls, exactly as it does for graders and
 * personas, so this is the invariant stated where a direct caller — the CLI, a
 * test, a script — will meet it.
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
 * Archive an agent, and every active way of reaching it, and every piece of
 * work that was going to use one.
 *
 * **Archive is always allowed, and it is not deletion.** Past runs name this
 * agent and stay readable. Tests belong only to suites and do not link to an
 * agent. The whole of what Archive does is stop it entering anything new — and stop what had
 * already been started over it, because a queued simulation whose connection
 * has been archived would sit in the claim queue for a target no simulator can
 * resolve a credential for and would eventually fail, putting an operational
 * failure on the record dressed up as something the agent did.
 *
 * **The children go with it, in the same transaction.** An agent whose
 * connections stayed active would be an archived thing that egma could still
 * reach, and — the reason this is not merely tidy — restoring the agent later
 * would silently bring an old provider credential back into use. So Archive
 * takes them, and Restore deliberately does not give them back: each
 * connection comes back one at a time, through the credential rule its own
 * access variant declares.
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
      .set({ archivedAt: now, updatedAt: now })
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
 * Restore an agent, and only the agent.
 *
 * Its connections stay archived, every one of them, and that is the decision
 * rather than an omission: a connection carries a credential, and a Restore
 * that reactivated them in a batch would put old provider keys back into use
 * without anybody choosing to. Each comes back through its own Restore, which
 * asks for whatever its access variant's credential rule requires.
 *
 * A name another active agent has taken since is refused unless the Restore
 * brings a replacement. It cannot be silently renamed: an agent is identified
 * by its name in every list and every run builder, and a Restore that quietly
 * produced "Front desk (2)" would be egma deciding which of two agents the
 * history belongs to.
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
 * The refusal a Restore gets when the name it wants is somebody else's now.
 *
 * **The name is always the one that collided**, which is the row's own whenever
 * the Restore brought no replacement — a Restore that names nothing is asking
 * for the name it had. Falling back to a phrase produced "The name this
 * resource already has is already used by an active connection", a sentence
 * that fills the template's slot without telling anybody which name to avoid.
 *
 * It names the resource rather than the row it collided with, because that row
 * may be one the reader is not entitled to see, and because the move is the
 * same either way: pick another name in the Restore.
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
 * What kind one connection is, by its id alone — or `undefined` where this
 * caller has no such connection.
 *
 * **The one connection read that does not name an agent, and it exists for one
 * caller: the deployment gate in front of run creation.** A run's body names a
 * connection and need not name the agent it is on, and the API has to know
 * whether that connection is a phone before it will let a run over it be
 * written on a platform whose phone half was never set up. Asking through
 * `getConnection` would mean the caller first guessing an agent id it was never
 * given.
 *
 * It answers a connection type and nothing else, deliberately. A gate needs to know what
 * kind of thing this is; it has no business with the config, and a shape that
 * cannot carry a credential cannot leak one.
 *
 * Scoped exactly as `startRun` scopes the same row — alive, in the acting
 * project, under a living agent, inside the caller's tenancy — so a gate can
 * never refuse over a connection the run itself would have said it could not
 * see. Whichever way that disagreement fell it would be wrong: a refusal
 * naming somebody else's connection is a leak, and a gate that skipped
 * because it looked in the wrong project is no gate.
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
 * The agent's connections, oldest first — the ids are time-sortable, so this is
 * the order they were attached in. A whole page, deliberately: an agent holds a
 * handful of connections, not thousands, and `undefined` for an unreachable
 * agent is a different answer than `[]` for an unwired one.
 *
 * `archived` asks for the other half. It is a separate list rather than a
 * column on one, because "how egma can reach this agent" and "how it used to"
 * are two questions, and a run builder that had to filter one list would sooner
 * or later forget to.
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
 * One door for every change. Name, environment and config write in place —
 * config checked whole against the row's stored access variant — and
 * credentials replace whole or stay untouched, resealed under a fresh IV with
 * the hint moved along. Editing what the caller cannot see returns what
 * reading it would have: `undefined`, with nothing disturbed.
 *
 * **Agent platform, connection type, access variant, and modality are
 * immutable.** Changing any axis creates a new connection. Config is validated
 * against the stored access variant and never selects another one.
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
 * Archive one way of reaching an agent, and stop the work that was going over
 * it.
 *
 * **Always allowed, including for an agent's last connection.** An agent with
 * no connections is a legal thing — it is an agent nobody can reach yet, which
 * is what every agent is for the minute between registering it and wiring it —
 * so refusing the last one would be egma insisting a team keep a target they
 * have decided to stop using.
 *
 * What it does is block new claims, settle the queue, and ask whatever is
 * already talking to stop at its next heartbeat. What it deliberately does not
 * do is erase anything: transcripts, verdicts and run headers stay exactly as
 * they are, because evidence that was true stays true after the target is
 * retired.
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
 * Bring one connection back, on the terms its own access variant sets.
 *
 * Two rules, and neither is negotiable:
 *
 * - **The parent agent has to be active.** Restoring a connection under an
 *   archived agent would produce a reachable way into something nobody can
 *   run, and it would undo half of what agent Archive did without saying so.
 * - **The archived credential is never what comes back.** An access variant
 *   that requires one demands a new one; one that forbids it refuses to be
 *   handed one; an optional variant makes the author say `replace` or
 *   `clear`, because leaving it out cannot be told from meaning to drop it and
 *   the sealed envelope is sitting right there for the wrong reading to reuse.
 *
 * `clear` removes the envelope outright rather than leaving it unreferenced.
 * The rule is not "the old secret is unlikely to be used"; it is that it
 * cannot be.
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
