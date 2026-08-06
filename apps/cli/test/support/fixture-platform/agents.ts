/**
 * The agent and connection endpoints of the fixture platform.
 *
 * This is the contract the CLI is built against, written down as something that
 * runs: register a voice agent together with the first way of reaching it, read
 * it back, and attach another connection later.
 *
 * It answers what the real instance answers, including which refusal goes with
 * which mistake, because a fixture that is kinder than the real thing is a
 * fixture that hides bugs. Everything it refuses, the access layer behind the
 * seam refuses for the same reason: a modality the type does not speak, a
 * config key the type has no place for, a credential where none belongs or none
 * where one is required, and a name a living row already holds.
 *
 * Three shapes are load-bearing and none of them is this file's to change:
 *
 * - **No resource is rooted at a project.** An agent is `/api/agents/:agentId`
 *   and never `/api/projects/:projectId/agents/…`. A write may *name* a project
 *   in its body; a read filters by one in the query.
 * - **The organization never appears in an address.** Which customer this is
 *   comes from the key and from nowhere else, which is what stops a copied key
 *   writing into somebody else's account by asking nicely.
 * - **A sealed secret never comes back.** What a caller sends is stored sealed
 *   and answered as its last four characters and nothing more.
 */

import { randomBytes } from "node:crypto";

import type { FixtureAnswer, RouteGroup } from "./server.ts";

/** The identifier shapes the platform mints: a prefix and a fixed-width body. */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BODY_LENGTH = 26;

function newId(prefix: string): string {
  const body = [...randomBytes(ID_BODY_LENGTH)]
    .map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
    .join("");
  return `${prefix}_${body}`;
}

/** The floor under a credential field, so a last-4 hint stays a hint. */
const SHORTEST_CREDENTIAL = 8;

type ConfigGate = (key: string, value: unknown) => string;

type Descriptor = {
  readonly modalities: readonly string[];
  readonly topology: string;
  readonly config: Readonly<Record<string, ConfigGate>>;
  readonly credentials:
    | { readonly required: true; readonly fields: readonly string[]; readonly hintField: string }
    | { readonly required: false; readonly refusal: string };
};

function nonEmptyString(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Refusal(`the config's ${key} must be a non-empty string`);
  }
  return value.trim();
}

/** E.164: a plus, then up to fifteen digits with no leading zero. */
const E164 = /^\+[1-9]\d{1,14}$/u;

function e164PhoneNumber(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!E164.test(candidate)) {
    throw new Refusal(
      `the config's ${key} must be an E.164 phone number, which looks like +15551234567`,
    );
  }
  return candidate;
}

/**
 * What each connection type is made of, mirroring the registry behind the seam.
 *
 * `phone` is here although the CLI never writes one: it is what makes the
 * checks about per-type validation real rather than a single type agreeing
 * with itself.
 */
const REGISTRY: Readonly<Record<string, Descriptor>> = {
  retell: {
    modalities: ["chat", "voice"],
    topology: "hosted-broker",
    config: { retellAgentId: nonEmptyString },
    credentials: { required: true, fields: ["apiKey"], hintField: "apiKey" },
  },
  phone: {
    modalities: ["voice"],
    topology: "egma-dials-in",
    config: { phoneNumber: e164PhoneNumber },
    credentials: {
      required: false,
      refusal:
        "a phone connection takes no credential: the customer supplies a public number, " +
        "and egma dials it with its own telephony configuration",
    },
  },
};

const CONNECTION_TYPES = Object.keys(REGISTRY);

/** A refusal with a sentence in it, turned into an answer at the door. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "Refusal";
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_request";
  }
}

function descriptorOf(type: unknown): Descriptor {
  const named = typeof type === "string" ? type : "";
  const descriptor = REGISTRY[named];
  if (descriptor === undefined) {
    throw new Refusal(
      `"${named}" is not a connection type egma knows; expected one of ${CONNECTION_TYPES.join(", ")}`,
    );
  }
  return descriptor;
}

function validModality(type: string, modality: unknown): string {
  const descriptor = descriptorOf(type);
  const named = typeof modality === "string" ? modality : "";
  if (!descriptor.modalities.includes(named)) {
    throw new Refusal(
      `a ${type} connection speaks ${descriptor.modalities.join(" or ")}, and this one was asked for ${named}`,
    );
  }
  return named;
}

function validConfig(type: string, config: unknown): Record<string, string> {
  const gates = descriptorOf(type).config;
  const demanded = Object.keys(gates);

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Refusal(`a ${type} connection's config is an object holding ${demanded.join(", ")}`);
  }

  for (const key of Object.keys(config)) {
    if (!(key in gates)) {
      throw new Refusal(
        `a ${type} connection's config has no key "${key}"; it holds ${demanded.join(", ")}`,
      );
    }
  }

  const stored: Record<string, string> = {};
  for (const [key, gate] of Object.entries(gates)) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) throw new Refusal(`a ${type} connection's config needs ${key}`);
    stored[key] = gate(key, value);
  }
  return stored;
}

function validCredentials(
  type: string,
  credentials: unknown,
): { readonly sealed: Record<string, string>; readonly hint: string } | null {
  const rule = descriptorOf(type).credentials;

  if (!rule.required) {
    if (credentials !== undefined) throw new Refusal(rule.refusal);
    return null;
  }

  const shape = `{ ${rule.fields.join(", ")} }`;
  if (
    credentials === undefined ||
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    throw new Refusal(`a ${type} connection needs credentials shaped ${shape}`);
  }

  for (const key of Object.keys(credentials)) {
    if (!rule.fields.includes(key)) {
      throw new Refusal(
        `a ${type} connection's credentials have no key "${key}"; they are shaped ${shape}`,
      );
    }
  }

  const sealed: Record<string, string> = {};
  for (const field of rule.fields) {
    const value = (credentials as Record<string, unknown>)[field];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "") {
      throw new Refusal(
        `a ${type} connection's credentials need ${field} to be a non-empty string`,
      );
    }
    if (trimmed.length < SHORTEST_CREDENTIAL) {
      throw new Refusal(
        `a ${type} connection's credentials need ${field} to be at least ${SHORTEST_CREDENTIAL} characters`,
      );
    }
    sealed[field] = trimmed;
  }

  return { sealed, hint: sealed[rule.hintField]?.slice(-4) ?? "" };
}

function validName(name: unknown, what: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") throw new Refusal(`${what} needs a name`);
  return trimmed;
}

/** What was pulled from the provider, stored exactly as it was sent. */
type Pulled = {
  readonly vendor: string;
  readonly documents: readonly { readonly of: string; readonly body: string }[];
  readonly prompt: string | null;
  readonly voice: string | null;
  readonly tools: readonly unknown[];
};

/**
 * The vendor payload, checked for shape and otherwise untouched.
 *
 * Every document's body is kept as the string it arrived as. Parsing it here
 * and storing the result would make the stored copy a reading of the provider's
 * answer rather than the answer, which is the one thing the rule forbids.
 */
function validPulled(pulled: unknown): Pulled | null {
  if (pulled === undefined) return null;
  if (typeof pulled !== "object" || pulled === null || Array.isArray(pulled)) {
    throw new Refusal("what was pulled from the provider is an object, or is left out entirely");
  }
  const held = pulled as Record<string, unknown>;
  const documents = Array.isArray(held["documents"]) ? held["documents"] : [];
  const kept: { of: string; body: string }[] = [];
  for (const document of documents) {
    if (typeof document !== "object" || document === null) {
      throw new Refusal("every pulled document names what it is and carries a body");
    }
    const one = document as Record<string, unknown>;
    if (typeof one["of"] !== "string" || typeof one["body"] !== "string") {
      throw new Refusal("every pulled document names what it is and carries a body");
    }
    kept.push({ of: one["of"], body: one["body"] });
  }
  return {
    vendor: typeof held["vendor"] === "string" ? held["vendor"] : "",
    documents: kept,
    prompt: typeof held["prompt"] === "string" ? held["prompt"] : null,
    voice: typeof held["voice"] === "string" ? held["voice"] : null,
    tools: Array.isArray(held["tools"]) ? (held["tools"] as unknown[]) : [],
  };
}

type StoredConnection = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: string;
  readonly modality: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed. Nothing outside this file ever reads it back through a route. */
  readonly credentials: Readonly<Record<string, string>> | null;
  readonly credentialsHint: string | null;
  readonly createdAt: string;
};

type StoredAgent = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly pulled: Pulled | null;
  readonly createdAt: string;
};

/** What a route answers with: everything but the sealed envelope. */
function connectionOut(connection: StoredConnection): Record<string, unknown> {
  const { credentials, ...shown } = connection;
  void credentials;
  return shown;
}

/**
 * What the platform says about a connection type it cannot reach yet.
 *
 * The rule it stands for is the platform's: a connection whose adapter has not
 * shipped is refused **loudly, at creation, in the platform's own words**, and
 * the wizard prints those words rather than a summary of them. Where that
 * refusal is served from is the platform's business and it will move to run
 * creation the day the public API serves runs; what this pins is the only half
 * the CLI owns — that it swallows nothing.
 */
export function noAdapterRefusal(type: string): string {
  return (
    `egma cannot run simulations over a ${type} connection yet: no adapter for it ` +
    "has shipped. Nothing was registered, because a way of reaching your agent " +
    "that egma cannot use is not one."
  );
}

export type AgentControls = {
  /**
   * Make this connection type one egma has no adapter for, so registering one
   * is refused the way the platform refuses it.
   */
  withoutAdapterFor(type: string): void;
  /** Every agent written, oldest first. */
  readonly agents: readonly StoredAgent[];
  /** Every connection written, oldest first. */
  readonly connections: readonly StoredConnection[];
  /**
   * Every secret this fixture was handed, in the order it arrived.
   *
   * A check asserting the key reached the platform reads it here. It exists
   * because the alternative — asserting on a request body a test recorded —
   * would put the secret somewhere a failing test prints.
   */
  readonly sealed: readonly string[];
  /** The project a write named, or `null`, per write. */
  readonly projectsNamed: readonly (string | null)[];
};

export function agentRoutes(knowsKey: (key: string) => boolean): {
  readonly group: RouteGroup;
  readonly controls: AgentControls;
} {
  const agents: StoredAgent[] = [];
  const connections: StoredConnection[] = [];
  const sealed: string[] = [];
  const projectsNamed: (string | null)[] = [];
  /** Connection types this instance has no adapter for. Empty by default. */
  const unreachableTypes = new Set<string>();

  /** The project everything lands in when a write names none. */
  const HOME_PROJECT = newId("prj");

  const authorized = (headers: Record<string, string | undefined>): boolean => {
    const offered = (headers["authorization"] ?? "").replace(/^Bearer\s+/iu, "");
    return offered !== "" && knowsKey(offered);
  };

  const notAuthenticated: FixtureAnswer = {
    status: 401,
    body: { error: "not_authenticated", message: "no key, or not one of ours" },
  };

  const answering = (make: () => FixtureAnswer): FixtureAnswer => {
    try {
      return make();
    } catch (error) {
      if (error instanceof Refusal) {
        return { status: error.status, body: { error: error.code, message: error.message } };
      }
      throw error;
    }
  };

  /** The smallest free `<type>-<n>` among an agent's living connections. */
  const freeConnectionName = (agentId: string, type: string): string => {
    const taken = new Set(
      connections.filter((held) => held.agentId === agentId).map((held) => held.name),
    );
    for (let n = 1; ; n += 1) {
      const candidate = `${type}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  const writeConnection = (
    agent: StoredAgent,
    input: Record<string, unknown>,
  ): StoredConnection => {
    const descriptor = descriptorOf(input["type"]);
    const type = input["type"] as string;
    if (unreachableTypes.has(type)) {
      throw new Refusal(noAdapterRefusal(type), { status: 422, code: "no_adapter" });
    }
    const modality = validModality(type, input["modality"]);
    const config = validConfig(type, input["config"]);
    const credentials = validCredentials(type, input["credentials"]);
    const asked =
      input["name"] === undefined ? undefined : validName(input["name"], "a connection");

    const name = asked ?? freeConnectionName(agent.id, type);
    if (connections.some((held) => held.agentId === agent.id && held.name === name)) {
      throw new Refusal(`a connection named "${name}" already exists on this agent`, {
        status: 409,
        code: "name_taken",
      });
    }

    if (credentials !== null) sealed.push(...Object.values(credentials.sealed));

    const written: StoredConnection = {
      id: newId("con"),
      agentId: agent.id,
      projectId: agent.projectId,
      name,
      type,
      modality,
      // Derived from the type, never caller-supplied.
      topology: descriptor.topology,
      environment: typeof input["environment"] === "string" ? input["environment"] : null,
      config,
      credentials: credentials === null ? null : credentials.sealed,
      credentialsHint: credentials === null ? null : credentials.hint,
      createdAt: new Date().toISOString(),
    };
    connections.push(written);
    return written;
  };

  const group: RouteGroup = {
    name: "agents",
    routes: [
      {
        // Register a voice agent, with the first way of reaching it written in
        // the same request: an agent nothing can reach is not worth having, so
        // the happy path never produces one.
        method: "POST",
        path: "/api/agents",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          return answering(() => {
            const body = request.body ?? {};
            const name = validName(body["name"], "an agent");

            // A write may name a project in its body. It never names one in
            // its address, and it never names an organization anywhere.
            const named = typeof body["project"] === "string" ? body["project"] : null;
            projectsNamed.push(named);
            const projectId = named ?? HOME_PROJECT;

            if (agents.some((held) => held.projectId === projectId && held.name === name)) {
              throw new Refusal(`an agent named "${name}" already exists in this project`, {
                status: 409,
                code: "name_taken",
              });
            }

            const pulled = validPulled(body["pulled"]);

            // Both rows or neither: a bad connection payload leaves no agent
            // behind, so the write is checked before either is kept.
            const agent: StoredAgent = {
              id: newId("agt"),
              projectId,
              name,
              description: typeof body["description"] === "string" ? body["description"] : null,
              pulled,
              createdAt: new Date().toISOString(),
            };

            const inline = body["connection"];
            if (inline === undefined) {
              agents.push(agent);
              return { status: 201, body: { agent } };
            }
            if (typeof inline !== "object" || inline === null || Array.isArray(inline)) {
              throw new Refusal("a connection is an object, or is left out entirely");
            }

            const before = connections.length;
            let connection: StoredConnection;
            try {
              connection = writeConnection(agent, inline as Record<string, unknown>);
            } catch (error) {
              connections.length = before;
              throw error;
            }
            agents.push(agent);

            return { status: 201, body: { agent, connection: connectionOut(connection) } };
          });
        },
      },
      {
        // One page of the agents this key can reach. A project is a filter in
        // the query, never a level in the address.
        method: "GET",
        path: "/api/agents",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const project = request.url.searchParams.get("project");
          const items = agents.filter(
            (agent) => project === null || agent.projectId === project,
          );
          return { status: 200, body: { items } };
        },
      },
      {
        // The agent, everything pulled from the provider for it, and every way
        // of reaching it. A connection is only ever reached through its agent.
        method: "GET",
        path: "/api/agents/:agentId",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const agent = agents.find((held) => held.id === request.params["agentId"]);
          if (agent === undefined) {
            return {
              status: 404,
              body: { error: "not_found", message: "no agent of yours has that id" },
            };
          }
          return {
            status: 200,
            body: {
              agent,
              connections: connections
                .filter((held) => held.agentId === agent.id)
                .map(connectionOut),
            },
          };
        },
      },
      {
        // Another way of reaching an agent that already exists. Same rules, and
        // the same defaulted name one number further along.
        method: "POST",
        path: "/api/agents/:agentId/connections",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const agent = agents.find((held) => held.id === request.params["agentId"]);
          if (agent === undefined) {
            return {
              status: 404,
              body: { error: "not_found", message: "no agent of yours has that id" },
            };
          }
          return answering(() => ({
            status: 201,
            body: {
              connection: connectionOut(writeConnection(agent, request.body ?? {})),
            },
          }));
        },
      },
    ],
  };

  return {
    group,
    controls: {
      withoutAdapterFor(type) {
        unreachableTypes.add(type);
      },
      agents,
      connections,
      sealed,
      projectsNamed,
    },
  };
}
