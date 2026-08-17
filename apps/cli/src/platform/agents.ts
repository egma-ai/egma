/**
 * Registering a voice agent and a way to reach it, on egma.
 *
 * One request writes both, because an agent nothing can reach is not a thing
 * anybody wants: the platform writes the two together or neither, and this asks
 * for them together so that it can.
 *
 * Provider credentials travel inside that one request body and are read out of
 * their masked object exactly here, on the way to being sealed. Nothing in
 * this module writes a file, prints a line, or puts the body into an error.
 *
 * **What the provider is running does not travel.** egma keeps identity,
 * credentials and what it learns; the agent's own content stays at the
 * provider, where egma reads it fresh through the sealed credential rather than
 * out of a stored copy that rots from the moment it is written. So this sends
 * no verbatim vendor payload, and a body that carried one would be refused by
 * name rather than quietly ignored.
 *
 * **Reads live here too, and they are here for one job.** Registering answers
 * `name-taken` when a living agent in the project already holds the name, and
 * what that means depends on which agent it is — the same voice agent being
 * reached a second way, or a different one that happens to be called the same
 * thing. Telling those apart takes a read, so the read is beside the write it
 * belongs to rather than in a module of its own.
 */

import type { ConnectionCredentials } from "./connection-credentials.ts";
import type { Fetch } from "./device-flow.ts";

export type NewConnection = {
  /** Omit and the platform chooses the next `<type>-<number>` name. */
  readonly name?: string | undefined;
  /**
   * What kind of reach this is.
   *
   * `phone` carries no credential at all, and the platform refuses one on it by
   * name: a destination number is public, and egma dials it with the telephony
   * configuration its own deployment holds. That is what makes a phone
   * connection provider-blind — nothing in it says who answers.
   */
  /** The platform's connection-type registry is the source of truth. */
  readonly type: string;
  readonly modality: "voice" | "chat";
  readonly environment?: string | undefined;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed by the platform. Never answered back and never stored here. */
  readonly credentials?: ConnectionCredentials | undefined;
};

export type Registration = {
  readonly name: string;
  readonly description?: string | undefined;
  /** Which project the agent lands in. Omit and the key's own project applies. */
  readonly project?: string | undefined;
  readonly connection: NewConnection;
};

export type RegisteredAgent = {
  readonly id: string;
  readonly name: string;
};

export type RegisteredConnection = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly modality: string;
  /** The last characters of the sealed secret, which is all that comes back. */
  readonly credentialsHint: string | null;
  /**
   * What to reach, as the platform stores it — a number, provider agent id,
   * server URL, or endpoint. Never a secret: config is the public half of a
   * connection by construction.
   */
  readonly config: Readonly<Record<string, string>>;
};

/**
 * Which of the three things a registration did.
 *
 * Registering the same vendor agent twice is safe by construction — a retry
 * after an uncertain network failure never mints a second identity — and this
 * is how egma is told which of the three happened rather than left to guess.
 * `reused` answered the registration already there, with the credential
 * rotated; `connection_added` reached the same agent a new way.
 */
export type RegisterOutcome = "created" | "reused" | "connection_added";

const OUTCOMES: readonly string[] = ["created", "reused", "connection_added"];

export type Registered = {
  /** What egma did, in egma's own word for it. */
  readonly result: RegisterOutcome;
  readonly agent: RegisteredAgent;
  readonly connection: RegisteredConnection;
};

export type RegisterResult =
  | { readonly kind: "registered"; readonly registered: Registered }
  /** A living agent in this project already holds the name. */
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export type RegisterOptions = {
  /** The egma being written to, already resolved. */
  readonly url: string;
  /** This machine's egma key, as login stored it. */
  readonly key: string;
  readonly fetchImpl?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

/** A string off the wire with nothing in it a terminal would obey. */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

function refusalIn(status: number, body: Record<string, unknown>): string {
  const said = plain(body["message"]);
  return said === "" ? `Egma answered ${status}` : said;
}

function agentIn(body: Record<string, unknown>): RegisteredAgent | null {
  const held = body["agent"];
  if (typeof held !== "object" || held === null) return null;
  const agent = held as Record<string, unknown>;
  const id = plain(agent["id"]);
  return id === "" ? null : { id, name: plain(agent["name"]) };
}

/** The config a read answers with, as text values and nothing else. */
function configIn(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const held: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") held[key] = entry;
  }
  return held;
}

/** One connection out of whatever object holds it, or `null` when it is not one. */
function connectionFrom(value: unknown): RegisteredConnection | null {
  if (typeof value !== "object" || value === null) return null;
  const connection = value as Record<string, unknown>;
  const id = plain(connection["id"]);
  if (id === "") return null;
  const hint = plain(connection["credentials_hint"]);
  return {
    id,
    name: plain(connection["name"]),
    type: plain(connection["type"]),
    modality: plain(connection["modality"]),
    credentialsHint: hint === "" ? null : hint,
    config: configIn(connection["config"]),
  };
}

function connectionIn(body: Record<string, unknown>): RegisteredConnection | null {
  return connectionFrom(body["connection"]);
}

/**
 * Which of the three things egma says it did, or nothing at all when what it
 * said is not one of them.
 *
 * The two cases are different and are not folded together. **Saying nothing
 * reads as `created`**, because that is what a reply carrying an agent and a
 * connection meant before the field existed, and it is the only reading that
 * cannot describe a write egma did not make.
 *
 * **Saying a word egma has never used is a broken answer**, and it is answered
 * as one. Reading it as `created` would be this end inventing a fact: a fourth
 * outcome could only mean a platform that does something this build has never
 * heard of, and reporting that as a fresh registration is exactly how a
 * developer ends up with two identities and a terminal that said one.
 */
function outcomeIn(body: Record<string, unknown>): RegisterOutcome | null {
  const said = plain(body["result"]);
  if (said === "") return "created";
  return OUTCOMES.includes(said) ? (said as RegisterOutcome) : null;
}

/** The body a connection travels in, on both doors that take one. */
function connectionBody(connection: NewConnection): Record<string, unknown> {
  return {
    ...(connection.name === undefined ? {} : { name: connection.name }),
    type: connection.type,
    modality: connection.modality,
    ...(connection.environment === undefined
      ? {}
      : { environment: connection.environment }),
    config: connection.config,
    // The one place provider credentials are read on the way to egma. They are
    // sealed there and never answered back — only the registry-defined hint is
    // returned.
    ...(connection.credentials === undefined
      ? {}
      : { credentials: connection.credentials.reveal() }),
  };
}

/**
 * One request to egma, with this machine's key on it, answered as a value.
 *
 * Every door here answers the same three ways when it is not the door's own
 * business — the machine is not signed in, egma refused, egma never answered —
 * so the shape is written once and each door reads its own success out of it.
 */
type Answered =
  | { readonly kind: "ok"; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: "unreachable"; readonly reason: string };

async function askPlatform(
  options: RegisterOptions,
  request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  },
): Promise<Answered> {
  const url = `${options.url.replace(/\/+$/u, "")}${request.path}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${options.key}`,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      kind: "unreachable",
      reason: `Egma at ${options.url} did not answer. Check the address, and that the instance is running.`,
    };
  }

  const held = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) return { kind: "not-authenticated" };
  if (response.status < 200 || response.status >= 300) {
    return {
      kind: "refused",
      reason: refusalIn(response.status, held),
      status: response.status,
      body: held,
    };
  }
  return { kind: "ok", status: response.status, body: held };
}

/** An agent on the platform, as a listing or a read names it. */
export type PlatformAgent = {
  readonly id: string;
  readonly name: string;
};

export type FoundAgent =
  | { readonly kind: "found"; readonly agent: PlatformAgent }
  /** No living agent of this credential's holds that name. */
  | { readonly kind: "not-found" }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** How many pages of agents are walked before giving up on finding a name. */
const MOST_PAGES = 20;

/**
 * The living agent holding one name, or the word that there is none.
 *
 * This exists for exactly one moment: egma asked the platform to register an
 * agent, and the platform said a living agent already holds the name. What
 * happens next depends on *which* agent that is — the same vendor agent being
 * connected a second way, or a different one that happens to be called the same
 * thing — and the only way to tell is to read it.
 *
 * Names are unique among a project's living agents, so at most one row can
 * match and the walk stops at the first.
 */
export async function agentNamed(
  name: string,
  options: RegisterOptions,
): Promise<FoundAgent> {
  const wanted = name.trim();
  let cursor: string | undefined;

  for (let page = 0; page < MOST_PAGES; page += 1) {
    const answer = await askPlatform(options, {
      method: "GET",
      path:
        cursor === undefined
          ? "/api/agents"
          : `/api/agents?cursor=${encodeURIComponent(cursor)}`,
    });
    if (answer.kind !== "ok") return answer;

    const items = Array.isArray(answer.body["items"])
      ? (answer.body["items"] as unknown[])
      : [];
    for (const row of items) {
      if (typeof row !== "object" || row === null) continue;
      const held = row as Record<string, unknown>;
      const id = plain(held["id"]);
      if (id !== "" && plain(held["name"]) === wanted) {
        return { kind: "found", agent: { id, name: wanted } };
      }
    }

    const next = plain(answer.body["next_cursor"]);
    if (next === "") break;
    cursor = next;
  }

  return { kind: "not-found" };
}

export type ReadAgent =
  | {
      readonly kind: "agent";
      readonly agent: PlatformAgent;
      /** Every living way of reaching it, oldest first. */
      readonly connections: readonly RegisteredConnection[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** One agent and every living way of reaching it. */
export async function readAgent(
  agentId: string,
  options: RegisterOptions,
): Promise<ReadAgent> {
  const answer = await askPlatform(options, {
    method: "GET",
    path: `/api/agents/${encodeURIComponent(agentId)}`,
  });
  if (answer.kind === "refused" && answer.status === 404) return { kind: "not-found" };
  if (answer.kind !== "ok") return answer;

  const held = answer.body["agent"];
  if (typeof held !== "object" || held === null) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it holds. Check that this Egma instance is up to date.",
    };
  }
  const agent = held as Record<string, unknown>;
  const id = plain(agent["id"]);
  if (id === "") return { kind: "not-found" };

  const rows = Array.isArray(answer.body["connections"])
    ? (answer.body["connections"] as unknown[])
    : [];
  const connections: RegisteredConnection[] = [];
  for (const row of rows) {
    const connection = connectionFrom(row);
    if (connection !== null) connections.push(connection);
  }

  return {
    kind: "agent",
    agent: { id, name: plain(agent["name"]) },
    connections,
  };
}

export type AddedConnection =
  | { readonly kind: "added"; readonly connection: RegisteredConnection }
  /** A living connection on this agent already holds the name. */
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * Another way of reaching an agent that already exists.
 *
 * The same body an inline connection travels in, at the platform's own second
 * door. It is what a developer who connected over text and came back for the
 * phone goes through: one voice agent, two ways to reach it, and one results
 * history.
 */
export async function addConnection(
  agentId: string,
  connection: NewConnection,
  options: RegisterOptions,
): Promise<AddedConnection> {
  const answer = await askPlatform(options, {
    method: "POST",
    path: `/api/agents/${encodeURIComponent(agentId)}/connections`,
    body: connectionBody(connection),
  });

  if (answer.kind === "refused") {
    if (answer.status === 404) return { kind: "not-found" };
    if (answer.status === 409 && plain(answer.body["error"]) === "name_taken") {
      return { kind: "name-taken", name: connection.name ?? "" };
    }
    return { kind: "refused", reason: answer.reason };
  }
  if (answer.kind !== "ok") return answer;

  const written = connectionFrom(answer.body["connection"]);
  if (written === null) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma instance is up to date.",
    };
  }
  return { kind: "added", connection: written };
}

/**
 * Writes the agent and its first connection, and answers what happened.
 *
 * Every ending is a value: a name already held is not a fault, and a machine
 * that is not signed in is neither. Neither is registering the same vendor
 * agent twice — egma answers what is already there, says so in `result`, and
 * that travels up as an ordinary success rather than as an error.
 */
export async function registerAgent(
  registration: Registration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const answer = await askPlatform(options, {
    method: "POST",
    path: "/api/agents",
    body: {
      name: registration.name,
      ...(registration.description === undefined
        ? {}
        : { description: registration.description }),
      ...(registration.project === undefined ? {} : { project: registration.project }),
      connection: connectionBody(registration.connection),
    },
  });

  if (answer.kind === "refused") {
    if (answer.status === 409 && plain(answer.body["error"]) === "name_taken") {
      return { kind: "name-taken", name: registration.name };
    }
    return { kind: "refused", reason: answer.reason };
  }
  if (answer.kind !== "ok") return answer;
  const held = answer.body;

  const agent = agentIn(held);
  const connection = connectionIn(held);
  const result = outcomeIn(held);
  // Three ways a success can be an answer this end cannot read, and all three
  // are the same thing to whoever is waiting: egma wrote something and this
  // build cannot say what. Guessing at any of them would put a sentence on a
  // terminal that nothing checked.
  if (agent === null || connection === null || result === null) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma instance is up to date.",
    };
  }

  return { kind: "registered", registered: { result, agent, connection } };
}
