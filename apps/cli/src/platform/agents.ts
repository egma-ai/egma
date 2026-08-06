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
 */

import type { RetellDocument } from "../retell/client.ts";
import type { RetellKey } from "../retell/key.ts";
import type { Fetch } from "./device-flow.ts";

/**
 * What was pulled from the provider, kept whole beside what egma read out of
 * it. The documents are the provider's own bytes: egma's columns are a reading
 * of them, and a reading is never allowed to be the only copy.
 */
export type PulledPayload = {
  readonly vendor: "retell";
  readonly documents: readonly RetellDocument[];
  readonly prompt: string | null;
  readonly voice: string | null;
  readonly tools: readonly unknown[];
};

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
  readonly pulled: PulledPayload;
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

export type Registered = {
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
  const hint = plain(connection["credentialsHint"]);
  return {
    id,
    name: plain(connection["name"]),
    type: plain(connection["type"]),
    modality: plain(connection["modality"]),
    credentialsHint: hint === "" ? null : hint,
  };
}

/**
 * Writes the agent and its first connection, and answers what happened.
 *
 * Every ending is a value: a name already held is not a fault, and a machine
 * that is not signed in is neither.
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
    pulled: registration.pulled,
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
  if (agent === null || connection === null) {
    return {
      kind: "refused",
      reason: "egma answered without saying what it wrote. Check that this egma is up to date.",
    };
  }

  return { kind: "registered", registered: { agent, connection } };
}
