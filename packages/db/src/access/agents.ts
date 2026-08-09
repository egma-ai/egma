import { isId, newId } from "@egma/ids";
import { and, asc, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  agent,
  connection,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { sealCredentials } from "../sealing.ts";
import {
  descriptorOf,
  shapeOf,
  validConfig,
  validCredentials,
  validModality,
} from "./connection-registry.ts";
import type { AuthContext } from "./context.ts";
import {
  AgentWriteRefusedError,
  ProjectOutsideOrganizationError,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
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
  /** Defaults from the type (`retell-1`), so onboarding never stalls. */
  readonly name?: string | undefined;
  readonly type: ConnectionType;
  readonly modality: Modality;
  /** A label (`staging`, `production`), never a level in the hierarchy. */
  readonly environment?: string | undefined;
  /** Validated per type at the door: what to reach, never how to prove. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Required or refused per type; sealed before it touches the row. */
  readonly credentials?: Readonly<Record<string, unknown>> | undefined;
};

export type Connection = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: ConnectionType;
  readonly modality: Modality;
  /** Derived from the type, never caller-supplied. */
  readonly topology: Topology;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  /** The last characters of the sealed secret, or null where none belongs. */
  readonly credentialsHint: string | null;
  /** Runtime-discovered, never caller-declared; null until discovery exists. */
  readonly capabilities: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Type and modality are deliberately absent: changing
 * what a connection *is* is a new connection, and mutating it in place would
 * attribute yesterday's chat results to something that is now a phone number.
 * Credentials replace whole or stay untouched — never a merge, so plaintext
 * never round-trips out for editing. Absent means keep.
 */
export type ConnectionChanges = {
  readonly name?: string | undefined;
  readonly environment?: string | null | undefined;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly credentials?: Readonly<Record<string, unknown>> | undefined;
};

export type RemovedConnection = {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

export type NewAgent = {
  readonly name: string;
  readonly description?: string | undefined;
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
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** What `createAgent` answers: the agent, wired if the create asked for it. */
export type CreatedAgent = Agent & {
  readonly connection?: Connection;
};

/**
 * What an edit may touch: the two identity fields, in place. There is no
 * version to move — the agent is deliberately unversioned, because its real
 * content lives on the provider's side where egma cannot freeze it. Absent
 * means keep; a null description clears it.
 */
export type AgentChanges = {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
};

export type AgentPage = {
  readonly items: readonly Agent[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export type DeletedAgent = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

const notDeleted: SQL = isNull(agent.deletedAt);
const connectionNotDeleted: SQL = isNull(connection.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: agent.id,
  projectId: agent.projectId,
  name: agent.name,
  description: agent.description,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
} as const;

/** A connection as any read answers it. The sealed envelope has no row here. */
const CONNECTION_COLUMNS = {
  id: connection.id,
  agentId: connection.agentId,
  projectId: connection.projectId,
  name: connection.name,
  type: connection.type,
  modality: connection.modality,
  topology: connection.topology,
  environment: connection.environment,
  config: connection.config,
  credentialsHint: connection.credentialsHint,
  capabilities: connection.capabilities,
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
 */
function lostToConstraint(error: unknown, constraint: string): boolean {
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

/** The named agent, alive, within the caller's tenancy and scope. */
function theAgent(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    agent,
    and(eq(agent.id, id), notDeleted, inActingProject(auth)),
  );
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
    and(
      eq(connection.id, connectionId),
      eq(connection.agentId, agentId),
      connectionNotDeleted,
    ),
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
): Promise<{ id: string; projectId: string } | undefined> {
  const [row] = await db()
    .select({ id: agent.id, projectId: agent.projectId })
    .from(agent)
    .where(theAgent(auth, agentId))
    .limit(1);
  return row;
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
        `connection ${connectionId} holds config in a shape egma never ` +
          `writes; the row needs repairing before anybody can read it`,
      ),
  );
}

type ConnectionRow = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: string;
  readonly modality: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: unknown;
  readonly credentialsHint: string | null;
  readonly capabilities: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * A selected row as the caller sees it. The three enumerated columns are
 * narrowed by assertion because the schema's CHECK constraints already refuse
 * anything outside the lists — a value the assertion would get wrong cannot be
 * in the table.
 */
function connectionFromRow(row: ConnectionRow): Connection {
  return {
    ...row,
    type: row.type as ConnectionType,
    modality: row.modality as Modality,
    topology: row.topology as Topology,
    config: configFromRow(row.config, row.id),
    capabilities: row.capabilities ?? null,
  };
}

/**
 * A new connection once the registry has had its say: modality checked
 * against the type, config gated key by key, credentials sealed or refused,
 * topology derived. The name may still be absent — defaulting it takes a
 * read, and this shape exists so that read can wait for the insert's own
 * transaction.
 */
type AdmittedConnection = {
  readonly name: string | undefined;
  readonly type: ConnectionType;
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
  const descriptor = descriptorOf(input.type);
  const modality = validModality(input.type, input.modality);
  const config = validConfig(input.type, input.config);
  // The config comes in beside the credentials because a type can come in more
  // than one shape, and the config is what says which shape this is.
  const sealed = validCredentials(input.type, input.config, input.credentials);

  return {
    name:
      input.name === undefined
        ? undefined
        : validName(input.name, "a connection"),
    type: input.type,
    modality,
    topology: descriptor.topology,
    environment: input.environment ?? null,
    config,
    credentials: sealed === null ? null : sealCredentials(sealed.sealed),
    credentialsHint: sealed === null ? null : sealed.hint,
  };
}

/**
 * The smallest free `<type>-<n>` among the agent's living names, so an unnamed
 * add always lands — a removed connection's number comes back into play the
 * same way its name does.
 */
async function freeDefaultName(
  on: Queryable,
  agentId: string,
  type: ConnectionType,
): Promise<string> {
  const taken = new Set(
    (
      await on
        .select({ name: connection.name })
        .from(connection)
        .where(and(eq(connection.agentId, agentId), connectionNotDeleted))
    ).map((row) => row.name),
  );

  for (let n = 1; ; n += 1) {
    const candidate = `${type}-${n}`;
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
  home: { readonly id: string; readonly projectId: string },
  admitted: AdmittedConnection,
): Promise<Connection> {
  const name =
    admitted.name ?? (await freeDefaultName(on, home.id, admitted.type));

  const [inserted] = await on
    .insert(connection)
    .values({
      id: newId("con"),
      organizationId: auth.organizationId,
      projectId: home.projectId,
      agentId: home.id,
      name,
      type: admitted.type,
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
  return connectionFromRow(inserted);
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
  identity: { readonly name: string; readonly description: string | null },
): Promise<Agent> {
  const [inserted] = await on
    .insert(agent)
    .values({
      id: newId("agt"),
      organizationId: auth.organizationId,
      projectId,
      name: identity.name,
      description: identity.description,
      createdBy: auth.userId,
    })
    .returning(COLUMNS)
    .catch(refusingHeldAgentName(identity.name));

  if (inserted === undefined) throw new Error("the agent was not written");
  return inserted;
}

/**
 * Everything a write to this factory settles before it touches the database:
 * where the rows land, what the agent is called, and the inline connection
 * once its type's registry entry has had its say.
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
  readonly description: string | null;
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

  return { projectId, name, description: input.description ?? null, inline };
}

export async function createAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<CreatedAgent> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId, name, description, inline } = await settled(auth, input);
  const identity = { name, description };

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
      { id: written.id, projectId },
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
 * So the type's own reuse key decides (`connection-registry.ts`), and a living
 * connection in the project naming the same vendor agent decides the outcome:
 *
 * - **same modality** → that agent and that connection answer, with the
 *   supplied credential replacing the stored one **whole**. Rotation never
 *   asks for the old secret and never merges into it, so plaintext has no
 *   reason to travel back out. `reused`.
 * - **a different modality** → the same agent gains a new connection, because
 *   a chat endpoint and a voice endpoint on one vendor agent are two ways to
 *   reach one thing. `connection_added`.
 * - **no match, or a type with no reuse key at all** → both rows, exactly as
 *   `createAgent` writes them. `created`.
 *
 * The reused and extended paths answer the agent as it stands and leave its
 * name and description alone: the registration named an identity that already
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

  const { projectId, name, description, inline } = await settled(auth, input);
  const identity = { name, description };

  if (inline === undefined) {
    return {
      result: "created",
      agent: await insertAgent(db(), auth, projectId, identity),
    };
  }

  const reuseKey = descriptorOf(inline.type).reuseKey;
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
        { id: written.id, projectId },
        inline,
      ),
    };
  };

  // A type with no reuse key has nothing to match on, so this is `createAgent`
  // with a word for what it did.
  if (reuseKey === undefined || vendorAgent === undefined) {
    return db().transaction(bothRows);
  }

  // What the lock is taken on: this one vendor agent, in this one project, of
  // this one customer. Nothing else waits behind it.
  const racing = `${auth.organizationId}:${projectId}:${inline.type}:${vendorAgent}`;

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
            eq(connection.type, inline.type),
            sql`${connection.config}->>${reuseKey} = ${vendorAgent}`,
            connectionNotDeleted,
            notDeleted,
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
          // type that takes no secret clears both columns together, which is
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
        agent: sameModality.identity,
        connection: connectionFromRow(rotated),
      };
    }

    // The same vendor agent reached a different way. Oldest first, so which
    // agent gains the connection is the same answer every time.
    const known = living[0];
    if (known !== undefined) {
      return {
        result: "connection_added",
        agent: known.identity,
        connection: await insertConnection(
          tx,
          auth,
          { id: known.identity.id, projectId },
          inline,
        ),
      };
    }

    return bothRows(tx);
  });
}

export async function getAgent(
  auth: AuthContext,
  id: string,
): Promise<Agent | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(COLUMNS)
    .from(agent)
    .where(theAgent(auth, id))
    .limit(1);
  return row;
}

const DEFAULT_PAGE_SIZE = 50;
const LARGEST_PAGE_SIZE = 200;

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
 */
export async function listAgents(
  auth: AuthContext,
  page?: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
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

  // One row beyond the page answers "is there more?" without a second query.
  const rows = await db()
    .select(COLUMNS)
    .from(agent)
    .where(
      within(
        auth,
        agent,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(agent.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * Name and description, in place — there is no version to move, because the
 * agent is deliberately unversioned, so a rename is just a rename and the
 * run history stays the change record. A change that changes nothing is not
 * an edit at all: nothing is written, not even `updated_at`, and the current
 * row comes back — anything watching the timestamp hears only real changes.
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed. An organization-scoped credential may
 * edit, as the persona factory allows: the row names its own project,
 * so the write has somewhere to land.
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

  if (name === undefined && changes.description === undefined) {
    return getAgent(auth, id);
  }

  const [updated] = await db()
    .update(agent)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(changes.description === undefined
        ? {}
        : { description: changes.description }),
      updatedAt: new Date(),
    })
    .where(theAgent(auth, id))
    .returning(COLUMNS)
    .catch(
      // Only a name change can lose to the name constraint.
      name === undefined
        ? (error: unknown) => {
            throw error;
          }
        : refusingHeldAgentName(name),
    );

  return updated;
}

/**
 * The soft-delete marker, and only the marker — on the agent alone. Every
 * connection verb walks through `visibleAgent` first, so marking the agent is
 * what makes its connections answer nothing through every read at once; their
 * own rows stay exactly as they were, for the deletion worker to sweep. The
 * agent's name returns to the living, per the partial unique index.
 *
 * Like create, this refuses a credential acting in no project. An edit lands
 * on a row that already names its own project; a delete decides the agent
 * should stop appearing in one, and emptying a project is an act taken from
 * inside it — the persona factory's stance, held here.
 */
export async function deleteAgent(
  auth: AuthContext,
  id: string,
): Promise<DeletedAgent | undefined> {
  authorize(auth, "configure_agents", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting an agent happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  const [row] = await db()
    .update(agent)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theAgent(auth, id))
    .returning({
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
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

  return insertConnection(db(), auth, home, admitted);
}

export async function getConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): Promise<Connection | undefined> {
  authorize(auth, "read", here(auth));

  if ((await visibleAgent(auth, agentId)) === undefined) return undefined;

  const [row] = await db()
    .select(CONNECTION_COLUMNS)
    .from(connection)
    .where(theConnection(auth, agentId, connectionId))
    .limit(1);

  return row === undefined ? undefined : connectionFromRow(row);
}

/**
 * The agent's living connections, oldest first — the ids are time-sortable,
 * so this is the order they were attached in. A whole page, deliberately: an
 * agent holds a handful of connections, not thousands, and `undefined` for an
 * unreachable agent is a different answer than `[]` for an unwired one.
 */
export async function listConnections(
  auth: AuthContext,
  agentId: string,
): Promise<readonly Connection[] | undefined> {
  authorize(auth, "read", here(auth));

  if ((await visibleAgent(auth, agentId)) === undefined) return undefined;

  const rows = await db()
    .select(CONNECTION_COLUMNS)
    .from(connection)
    .where(
      within(
        auth,
        connection,
        and(eq(connection.agentId, agentId), connectionNotDeleted),
      ),
    )
    .orderBy(asc(connection.id));

  return rows.map(connectionFromRow);
}

/**
 * One door for every change. Name, environment and config write in place —
 * config checked whole against the registry entry for the row's own type — and
 * credentials replace whole or stay untouched, resealed under a fresh IV with
 * the hint moved along. Editing what the caller cannot see returns what
 * reading it would have: `undefined`, with nothing disturbed.
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
  for (const immutable of ["type", "modality", "topology"] as const) {
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

  if ((await visibleAgent(auth, agentId)) === undefined) return undefined;

  const [current] = await db()
    .select({
      id: connection.id,
      type: connection.type,
      config: connection.config,
    })
    .from(connection)
    .where(theConnection(auth, agentId, connectionId))
    .limit(1);
  if (current === undefined) return undefined;

  // The registry rules are the row's own type's — which cannot have changed
  // since the read above, because nothing can change it at all.
  const type = current.type as ConnectionType;
  const config =
    changes.config === undefined
      ? undefined
      : validConfig(type, changes.config);

  /**
   * A credential belongs to the shape its config is in, so an edit that moves
   * a connection from one shape to the other has to bring the credential the
   * new shape needs. Left to itself it would write a row that is half of each:
   * a config asking egma to fetch a token, over a sealed key pair nothing will
   * ever open again — readable, unrefusable, and dead at the next run.
   *
   * The sealed half cannot be read here to check it, and does not need to be:
   * what shape a connection is in is written in its config, in the clear.
   */
  const before = shapeOf(type, current.config);
  const after = config === undefined ? before : shapeOf(type, config);
  if (before !== after && changes.credentials === undefined) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `a connection's credentials belong to the shape its config is in, and ` +
        `this change moves it from ${before.named ?? `a ${type} connection`} ` +
        `to ${after.named ?? `a ${type} connection`}. Send the credentials ` +
        `the new shape needs in the same change.`,
    );
  }

  const sealed =
    changes.credentials === undefined
      ? undefined
      : validCredentials(
          type,
          config ?? current.config,
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
    .where(theConnection(auth, agentId, connectionId))
    .returning(CONNECTION_COLUMNS)
    .catch(
      // Only a name change can lose to the name constraint.
      name === undefined
        ? (error: unknown) => {
            throw error;
          }
        : refusingHeldConnectionName(name),
    );

  return updated === undefined ? undefined : connectionFromRow(updated);
}

/**
 * The soft-delete marker, and only the marker. The connection vanishes from
 * fetch and list at once and its name returns to the living; the row stays
 * for the deletion worker. The agent is untouched — an agent with no
 * connections is legal, so removing the last one is never refused for being
 * the last.
 */
export async function removeConnection(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): Promise<RemovedConnection | undefined> {
  authorize(auth, "configure_agents", here(auth));

  if ((await visibleAgent(auth, agentId)) === undefined) return undefined;

  const deletedAt = new Date();
  const [row] = await db()
    .update(connection)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theConnection(auth, agentId, connectionId))
    .returning({
      id: connection.id,
      agentId: connection.agentId,
      name: connection.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}

