/**
 * Registering a voice agent and a way to reach it, on egma.
 *
 * One request writes both, because an agent nothing can reach is not a thing
 * anybody wants: the platform writes the two together or neither, and this asks
 * for them together so that it can.
 *
 * The Retell key travels inside that one request body and is read out of the
 * key object exactly here, on the way to being sealed. Nothing in this module
 * writes a file, prints a line, or puts the body into an error.
 *
 * **What the provider is running does not travel.** egma keeps identity,
 * credentials and what it learns; the agent's own content stays at the
 * provider, where egma reads it fresh through the sealed credential rather than
 * out of a stored copy that rots from the moment it is written. So this sends
 * no verbatim vendor payload, and a body that carried one would be refused by
 * name rather than quietly ignored.
 */

import type { RetellKey } from "../retell/key.ts";
import type { Fetch } from "./device-flow.ts";

export type NewConnection = {
  /** Omit and the platform names it: `retell-1`, then `retell-2`. */
  readonly name?: string | undefined;
  readonly type: "retell";
  readonly modality: "voice" | "chat";
  readonly environment?: string | undefined;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed by the platform. Never answered back and never stored here. */
  readonly credentials?: RetellKey | undefined;
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
  return said === "" ? `egma answered ${status}` : said;
}

function agentIn(body: Record<string, unknown>): RegisteredAgent | null {
  const held = body["agent"];
  if (typeof held !== "object" || held === null) return null;
  const agent = held as Record<string, unknown>;
  const id = plain(agent["id"]);
  return id === "" ? null : { id, name: plain(agent["name"]) };
}

function connectionIn(body: Record<string, unknown>): RegisteredConnection | null {
  const held = body["connection"];
  if (typeof held !== "object" || held === null) return null;
  const connection = held as Record<string, unknown>;
  const id = plain(connection["id"]);
  if (id === "") return null;
  const hint = plain(connection["credentials_hint"]);
  return {
    id,
    name: plain(connection["name"]),
    type: plain(connection["type"]),
    modality: plain(connection["modality"]),
    credentialsHint: hint === "" ? null : hint,
  };
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
  const url = `${options.url.replace(/\/+$/u, "")}/api/agents`;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body = {
    name: registration.name,
    ...(registration.description === undefined ? {} : { description: registration.description }),
    ...(registration.project === undefined ? {} : { project: registration.project }),
    connection: {
      ...(registration.connection.name === undefined ? {} : { name: registration.connection.name }),
      type: registration.connection.type,
      modality: registration.connection.modality,
      ...(registration.connection.environment === undefined
        ? {}
        : { environment: registration.connection.environment }),
      config: registration.connection.config,
      // The one place the key is read on the way to egma. It is sealed there
      // and never answered back — what comes back is its last characters.
      ...(registration.connection.credentials === undefined
        ? {}
        : { credentials: { apiKey: registration.connection.credentials.reveal() } }),
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      kind: "unreachable",
      reason: `egma at ${options.url} did not answer. Check the address, and that the instance is running.`,
    };
  }

  const held = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.status === 401) return { kind: "not-authenticated" };
  if (response.status === 409 && plain(held["error"]) === "name_taken") {
    return { kind: "name-taken", name: registration.name };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "refused", reason: refusalIn(response.status, held) };
  }

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
      reason: "egma answered without saying what it wrote. Check that this egma is up to date.",
    };
  }

  return { kind: "registered", registered: { result, agent, connection } };
}
