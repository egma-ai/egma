/**
 * Register an agent and read the connections that reach it.
 *
 * The generated platform client owns the HTTP contract. This module keeps the
 * CLI workflow: registration is atomic, name conflicts are ordinary answers,
 * and provider credentials are opened only while the request is built.
 */

import {
  addConnection as addConnectionRequest,
  getAgent as getAgentRequest,
  listAgents as listAgentsRequest,
  registerAgent as registerAgentRequest,
  type AddConnectionData,
  type GetAgentResponse,
} from "@egma/platform-api/client";

import {
  platformClient,
  platformRefusalMessage,
  platformText,
  platformUnreachableMessage,
} from "./client.ts";
import type { ConnectionCredentials } from "./connection-credentials.ts";
import type { Fetch } from "./device-flow.ts";

type ConnectionInput = AddConnectionData["body"];

export type NewConnection = {
  /** Omit and the platform chooses a numbered product-label name. */
  readonly name?: string | undefined;
  /** Who runs the agent, or null when Egma does not know. */
  readonly agentPlatform: ConnectionInput["agentPlatform"];
  /** What Egma connects to for this simulation. */
  readonly connectionType: ConnectionInput["connectionType"];
  /** How Egma gets access to that connection. */
  readonly accessVariant: ConnectionInput["accessVariant"];
  readonly modality: ConnectionInput["modality"];
  readonly environment?: string | undefined;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed by the platform. Never answered back and never stored here. */
  readonly credentials?: ConnectionCredentials | undefined;
  /** The provider agent selected through server-side discovery. */
  readonly platformAgentId?: string | undefined;
};

export type Registration = {
  readonly name: string;
  /** Which product or framework runs the agent. */
  readonly agentPlatform: Exclude<ConnectionInput["agentPlatform"], null>;
  /** Which project the agent lands in. Omit and the key's own project applies. */
  readonly project?: string | undefined;
  readonly connection: NewConnection;
};

export type RegisteredAgent = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly agentPlatform: "retell" | "livekit";
  /** The provider's public agent id, when this agent is bound to one. */
  readonly platformAgentId: string | null;
  /** Whether the server can reuse the provider key already sealed on it. */
  readonly monitoringKeyPresent?: boolean;
};

export type RegisteredConnection = {
  readonly id: string;
  readonly name: string;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: ConnectionInput["modality"];
  readonly productLabel: string;
  /** The last characters of the sealed secret, which is all that comes back. */
  readonly credentialsHint: string | null;
  /** The public half of the connection. */
  readonly config: Readonly<Record<string, string>>;
};

export type RegisterOutcome = "created" | "reused" | "connection_added";

export type Registered = {
  readonly result: RegisterOutcome;
  readonly agent: RegisteredAgent;
  readonly connection: RegisteredConnection;
};

export type RegisterResult =
  | { readonly kind: "registered"; readonly registered: Registered }
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export type RegisterOptions = {
  readonly url: string;
  readonly key: string;
  readonly fetchImpl?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

function signedIn(options: RegisterOptions): { readonly url: string; readonly key: string } {
  return { url: options.url.replace(/\/+$/u, ""), key: options.key };
}

/**
 * The generated client and the signal, built the one way.
 *
 * Exported to the package because monitoring is the agent's own half
 * (ADR-0015) and its wrapper beside this one speaks to the same platform with
 * the same credential — a second copy of this would be a second place the
 * base URL is trimmed and the signal is attached.
 */
export function requestOptions(options: RegisterOptions) {
  return {
    client: platformClient(signedIn(options), options.fetchImpl),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "error" in error
    ? platformText(error.error)
    : "";
}

const OPAQUE_ID_ATOM = /^[A-Za-z0-9_-]+$/u;

/** A platform resource ID that can be printed as one shell argument as-is. */
function opaqueIdAtom(value: unknown): string {
  return typeof value === "string" && OPAQUE_ID_ATOM.test(value) ? value : "";
}

function cleanAgent(value: unknown): RegisteredAgent | null {
  if (typeof value !== "object" || value === null) return null;
  const agent = value as Readonly<Record<string, unknown>>;
  const id = opaqueIdAtom(agent["id"]);
  const name = platformText(agent["name"]);
  const projectId = opaqueIdAtom(agent["projectId"]);
  const agentPlatform = agent["agentPlatform"];
  const rawPlatformAgentId = agent["platformAgentId"];
  const platformAgentId =
    rawPlatformAgentId === null ? null : platformText(rawPlatformAgentId);
  const monitoringKeyPresent = agent["monitoringKeyPresent"];
  if (
    id === "" ||
    name === "" ||
    projectId === "" ||
    (agentPlatform !== "retell" && agentPlatform !== "livekit") ||
    (rawPlatformAgentId !== null && platformAgentId === "") ||
    (monitoringKeyPresent !== undefined &&
      typeof monitoringKeyPresent !== "boolean")
  ) {
    return null;
  }
  return {
    id,
    name,
    projectId,
    agentPlatform,
    platformAgentId,
    ...(typeof monitoringKeyPresent === "boolean"
      ? { monitoringKeyPresent }
      : {}),
  };
}

/** A successful registration is useful only with its complete stable receipt. */
function registrationReceipt(
  value: unknown,
): { readonly result: RegisterOutcome; readonly agent: RegisteredAgent } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result = record["result"];
  const rawAgent = record["agent"];
  if (
    (result !== "created" &&
      result !== "reused" &&
      result !== "connection_added") ||
    typeof rawAgent !== "object" ||
    rawAgent === null
  ) {
    return null;
  }
  const agent = cleanAgent(rawAgent);
  return agent === null ? null : { result, agent };
}

/** Turn one untrusted response value into a complete, safe connection receipt. */
function connectionReceipt(value: unknown): RegisteredConnection | null {
  if (typeof value !== "object" || value === null) return null;
  const connection = value as Readonly<Record<string, unknown>>;
  const id = opaqueIdAtom(connection["id"]);
  const name = platformText(connection["name"]);
  const connectionType = platformText(connection["connectionType"]);
  const accessVariant = platformText(connection["accessVariant"]);
  const productLabel = platformText(connection["productLabel"]);
  const modality = connection["modality"];
  const rawPlatform = connection["agentPlatform"];
  const rawHint = connection["credentialsHint"];
  const rawConfig = connection["config"];
  if (
    id === "" ||
    name === "" ||
    connectionType === "" ||
    accessVariant === "" ||
    productLabel === "" ||
    (modality !== "chat" && modality !== "voice") ||
    (rawPlatform !== null && typeof rawPlatform !== "string") ||
    (rawHint !== null && typeof rawHint !== "string") ||
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    return null;
  }
  const config: Record<string, string> = {};
  for (const [key, raw] of Object.entries(rawConfig)) {
    if (typeof raw !== "string") return null;
    config[key] = raw;
  }
  const agentPlatform = rawPlatform === null ? null : platformText(rawPlatform);
  const credentialsHint = rawHint === null ? null : platformText(rawHint);
  if (rawPlatform !== null && agentPlatform === "") return null;

  return {
    id,
    name,
    agentPlatform,
    connectionType,
    accessVariant,
    modality,
    productLabel,
    credentialsHint,
    config,
  };
}

function connectionParameters(connection: NewConnection): ConnectionInput {
  return {
    ...(connection.name === undefined ? {} : { name: connection.name }),
    agentPlatform: connection.agentPlatform,
    connectionType: connection.connectionType,
    accessVariant: connection.accessVariant,
    modality: connection.modality,
    ...(connection.environment === undefined
      ? {}
      : { environment: connection.environment }),
    config: { ...connection.config },
    ...(connection.credentials === undefined
      ? {}
      : { credentials: connection.credentials.reveal() }),
    ...(connection.platformAgentId === undefined
      ? {}
      : { platformAgentId: connection.platformAgentId }),
  };
}

export type CommonFailure =
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** The three ways any platform request fails, told apart, or `null` for a 200. */
export function commonFailure(
  answer: { readonly error?: unknown; readonly response?: Response },
  options: RegisterOptions,
): CommonFailure | null {
  if (answer.response === undefined) {
    return { kind: "unreachable", reason: platformUnreachableMessage(options.url) };
  }
  if (answer.response.status === 401) return { kind: "not-authenticated" };
  if (!answer.response.ok) {
    return {
      kind: "refused",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
  return null;
}

/** An agent on the platform, as a listing or a read names it. */
export type PlatformAgent = RegisteredAgent;

export type FoundAgent =
  | { readonly kind: "found"; readonly agent: PlatformAgent }
  | { readonly kind: "not-found" }
  | CommonFailure;

export type MatchedConnection = {
  readonly agent: PlatformAgent;
  readonly connection: RegisteredConnection;
};

export type MatchedConnections =
  | { readonly kind: "matches"; readonly matches: readonly MatchedConnection[] }
  | CommonFailure;

/** How many pages of agents are walked before giving up on finding a name. */
const MOST_PAGES = 20;

export type ListedAgent = {
  readonly agent: PlatformAgent;
  readonly connections: readonly RegisteredConnection[];
};

export type ListedAgents =
  | { readonly kind: "agents"; readonly agents: readonly ListedAgent[] }
  | CommonFailure;

/** Read the complete active Agent roster for one Project. */
export async function listAllAgents(
  projectId: string,
  options: RegisterOptions,
): Promise<ListedAgents> {
  let pageToken: string | undefined;
  const agents: ListedAgent[] = [];

  for (let page = 0; page < MOST_PAGES; page += 1) {
    const answer = await listAgentsRequest(
      {
        projectId,
        pageSize: 200,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      requestOptions(options),
    );
    const failed = commonFailure(answer, options);
    if (failed !== null) return failed;
    if (answer.data === undefined || !Array.isArray(answer.data.agents)) {
      return {
        kind: "refused",
        reason:
          "Egma answered without an Agent list. Check that this Egma platform is up to date.",
      };
    }
    for (const row of answer.data.agents) {
      const agent = cleanAgent(row);
      if (agent === null || !Array.isArray(row.connections)) {
        return {
          kind: "refused",
          reason:
            "Egma answered with an incomplete Agent. Check that this Egma platform is up to date.",
        };
      }
      const connections: RegisteredConnection[] = [];
      for (const raw of row.connections) {
        const connection = connectionReceipt(raw);
        if (connection === null) {
          return {
            kind: "refused",
            reason:
              "Egma answered with an incomplete Connection. Check that this Egma platform is up to date.",
          };
        }
        connections.push(connection);
      }
      agents.push({ agent, connections });
    }

    const next = answer.data.nextPageToken ?? null;
    if (next === null || next === "") return { kind: "agents", agents };
    pageToken = next;
  }

  return {
    kind: "refused",
    reason:
      "Egma has more Agent pages than this CLI can read safely. Update the CLI and try again.",
  };
}

/** The living agent holding one name, or the word that there is none. */
export async function agentNamed(
  name: string,
  options: RegisterOptions,
): Promise<FoundAgent> {
  const wanted = name.trim();
  let pageToken: string | undefined;

  for (let page = 0; page < MOST_PAGES; page += 1) {
    const answer = await listAgentsRequest(
      pageToken === undefined ? undefined : { pageToken },
      requestOptions(options),
    );
    const failed = commonFailure(answer, options);
    if (failed !== null) return failed;
    if (answer.data === undefined || !Array.isArray(answer.data.agents)) {
      return {
        kind: "refused",
        reason:
          "Egma answered without an agent list. Check that this Egma platform is up to date.",
      };
    }

    for (const agent of answer.data.agents) {
      if (platformText(agent.name) === wanted) {
        const cleaned = cleanAgent(agent);
        return cleaned === null
          ? {
              kind: "refused",
              reason:
                "Egma answered with an incomplete agent. Check that this Egma platform is up to date.",
            }
          : { kind: "found", agent: cleaned };
      }
    }

    const next = answer.data.nextPageToken ?? null;
    if (next === null || next === "") return { kind: "not-found" };
    pageToken = next;
  }

  return {
    kind: "refused",
    reason:
      "Egma has more agent pages than this CLI can inspect safely. Use the complete stable receipt IDs, or update the CLI. Nothing was recorded.",
  };
}

/**
 * Read every living connection this key can see and keep the ones that match.
 *
 * Registration recovery sometimes starts with a provider's public identity,
 * not an Egma id or name. The list endpoint supplies the bounded roster and
 * each agent read supplies its complete public connection config. This helper
 * stops at the same page ceiling as public-identity recovery instead of claiming that a
 * partial scan found nothing.
 */
export async function matchingConnections(
  matches: (agent: PlatformAgent, connection: RegisteredConnection) => boolean,
  options: RegisterOptions,
): Promise<MatchedConnections> {
  let pageToken: string | undefined;
  const visited = new Set<string>();
  const found: MatchedConnection[] = [];

  for (let page = 0; page < MOST_PAGES; page += 1) {
    const answer = await listAgentsRequest(
      pageToken === undefined ? undefined : { pageToken },
      requestOptions(options),
    );
    const failed = commonFailure(answer, options);
    if (failed !== null) return failed;
    if (answer.data === undefined || !Array.isArray(answer.data.agents)) {
      return {
        kind: "refused",
        reason:
          "Egma answered without an agent list. Check that this Egma platform is up to date.",
      };
    }

    for (const listed of answer.data.agents) {
      const agent = cleanAgent(listed);
      if (agent === null) {
        return {
          kind: "refused",
          reason:
            "Egma answered with an incomplete agent. Check that this Egma platform is up to date.",
        };
      }
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);

      const read = await readAgent(agent.id, options);
      if (read.kind !== "agent") {
        if (read.kind === "not-found") {
          return {
            kind: "refused",
            reason: `Egma listed agent ${agent.id}, then could not read it. Try recovery again.`,
          };
        }
        return read;
      }
      for (const connection of read.connections) {
        if (matches(read.agent, connection)) {
          found.push({ agent: read.agent, connection });
        }
      }
    }

    const next = answer.data.nextPageToken ?? null;
    if (next === null || next === "") return { kind: "matches", matches: found };
    pageToken = next;
  }

  return {
    kind: "refused",
    reason:
      "Egma has more agent pages than this CLI can inspect safely. Use the complete stable receipt IDs, or update the CLI. Nothing was recorded.",
  };
}

export type ReadAgent =
  | {
      readonly kind: "agent";
      readonly agent: PlatformAgent;
      readonly connections: readonly RegisteredConnection[];
    }
  | { readonly kind: "not-found" }
  | CommonFailure;

/** One agent and every living way of reaching it. */
export async function readAgent(
  agentId: string,
  options: RegisterOptions,
): Promise<ReadAgent> {
  const answer = await getAgentRequest({ agentId }, requestOptions(options));
  if (answer.response?.status === 404) return { kind: "not-found" };
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const body: GetAgentResponse | undefined = answer.data;
  if (body === undefined) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it holds. Check that this Egma platform is up to date.",
    };
  }
  const agent = cleanAgent(body.agent);
  if (agent === null) {
    return {
      kind: "refused",
      reason:
        "Egma answered without a complete agent receipt. Check that this Egma platform is up to date.",
    };
  }
  if (agent.id !== agentId) {
    return {
      kind: "refused",
      reason:
        "Egma answered with a receipt for a different agent ID. Check that this Egma platform is up to date.",
    };
  }
  if (!Array.isArray(body.connections)) {
    return {
      kind: "refused",
      reason:
        "Egma answered without a complete connection list. Check that this Egma platform is up to date.",
    };
  }
  const connections: RegisteredConnection[] = [];
  for (const raw of body.connections) {
    const connection = connectionReceipt(raw);
    if (connection === null) {
      return {
        kind: "refused",
        reason:
          "Egma answered without a complete connection receipt. Check that this Egma platform is up to date.",
      };
    }
    connections.push(connection);
  }
  return {
    kind: "agent",
    agent,
    connections,
  };
}

export type AddedConnection =
  | { readonly kind: "added"; readonly connection: RegisteredConnection }
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "not-found" }
  | CommonFailure;

/** Add another way of reaching an agent that already exists. */
export async function addConnection(
  agentId: string,
  connection: NewConnection,
  options: RegisterOptions,
): Promise<AddedConnection> {
  const answer = await addConnectionRequest(
    { agentId, ...connectionParameters(connection) },
    requestOptions(options),
  );

  if (answer.response?.status === 404) return { kind: "not-found" };
  if (answer.response?.status === 409 && errorCode(answer.error) === "name_taken") {
    return { kind: "name-taken", name: connection.name ?? "" };
  }
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  const receipt = connectionReceipt(answer.data?.connection);
  if (receipt === null) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma platform is up to date.",
    };
  }
  return { kind: "added", connection: receipt };
}

/**
 * Write an agent's identity alone, bound to the platform that runs it.
 *
 * The other registration writes an agent and the first way of reaching it,
 * because an agent nothing can reach is not worth having — on the path it
 * serves. This one is for the path where there is genuinely nothing to reach:
 * a LiveKit worker that pushes its own production evidence is a real agent in
 * the roster, and Egma's simulator dials nothing to see it. The binding is the
 * agent's own fact (ADR-0015), which is why it can be written without one.
 */
export async function registerBoundAgent(
  registration: {
    readonly name: string;
    readonly agentPlatform: "retell" | "livekit";
    readonly project?: string | undefined;
  },
  options: RegisterOptions,
): Promise<RegisterIdentityResult> {
  const answer = await registerAgentRequest(
    {
      name: registration.name,
      agentPlatform: registration.agentPlatform,
      ...(registration.project === undefined
        ? {}
        : { projectId: registration.project }),
    },
    requestOptions(options),
  );

  if (answer.response?.status === 409 && errorCode(answer.error) === "name_taken") {
    return { kind: "name-taken", name: registration.name };
  }
  if (answer.response !== undefined && answer.response.status >= 500) {
    return {
      kind: "uncertain",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const receipt = registrationReceipt(answer.data);
  if (receipt === null) {
    return {
      kind: "uncertain",
      reason:
        `Egma answered ${String(answer.response?.status ?? 0)} without a complete ` +
        "agent receipt.",
    };
  }
  return {
    kind: "registered",
    result: receipt.result,
    agent: receipt.agent,
  };
}

export type RegisterIdentityResult =
  | {
      readonly kind: "registered";
      readonly result: RegisterOutcome;
      readonly agent: RegisteredAgent;
    }
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "uncertain"; readonly reason: string }
  | CommonFailure;

/** Atomically write an agent and its first connection. */
export async function registerAgent(
  registration: Registration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const connection = connectionParameters(registration.connection);
  const answer = await registerAgentRequest(
    {
      name: registration.name,
      agentPlatform: registration.agentPlatform,
      ...(registration.project === undefined
        ? {}
        : { projectId: registration.project }),
      connection,
    },
    requestOptions(options),
  );

  if (answer.response?.status === 409 && errorCode(answer.error) === "name_taken") {
    return { kind: "name-taken", name: registration.name };
  }
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const body = answer.data;
  const receipt = registrationReceipt(body);
  const answeredConnection = connectionReceipt(body?.connection);
  if (receipt === null || answeredConnection === null) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma platform is up to date.",
    };
  }
  return {
    kind: "registered",
    registered: {
      result: receipt.result,
      agent: receipt.agent,
      connection: answeredConnection,
    },
  };
}
