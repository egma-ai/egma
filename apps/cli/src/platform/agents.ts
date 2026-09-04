/**
 * Register an Agent identity and read the Connections that reach it.
 *
 * The generated platform client owns the HTTP contract. This module keeps the
 * CLI workflow: Agent identity and Connection creation are separate operations,
 * name conflicts are ordinary answers, and provider credentials are opened only
 * while a Connection request is built.
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
  /** The CLI supplies the selected catalog option's product label by default. */
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
  readonly agentId: string;
  readonly projectId: string;
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
  const agentId = opaqueIdAtom(connection["agentId"]);
  const projectId = opaqueIdAtom(connection["projectId"]);
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
    agentId === "" ||
    projectId === "" ||
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
    agentId,
    projectId,
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

function sameConfig(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function confirmsConnection(
  receipt: RegisteredConnection,
  input: {
    readonly agentId: string;
    readonly projectId: string;
    readonly connection: NewConnection;
  },
): boolean {
  return (
    receipt.agentId === input.agentId &&
    receipt.projectId === input.projectId &&
    (input.connection.name === undefined ||
      receipt.name === input.connection.name) &&
    receipt.agentPlatform === input.connection.agentPlatform &&
    receipt.connectionType === input.connection.connectionType &&
    receipt.accessVariant === input.connection.accessVariant &&
    receipt.modality === input.connection.modality &&
    sameConfig(receipt.config, input.connection.config)
  );
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
  | { readonly kind: "not-authenticated"; readonly reason: string }
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
  if (answer.response.status === 401) {
    return {
      kind: "not-authenticated",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
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

/** How many pages of Agents are read before the CLI refuses a partial roster. */
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
      if (
        agent === null ||
        agent.projectId !== projectId ||
        !Array.isArray(row.connections)
      ) {
        return {
          kind: "refused",
          reason:
            "Egma answered with an incomplete Agent. Check that this Egma platform is up to date.",
        };
      }
      const connections: RegisteredConnection[] = [];
      for (const raw of row.connections) {
        const connection = connectionReceipt(raw);
        if (
          connection === null ||
          connection.projectId !== projectId ||
          connection.agentId !== agent.id
        ) {
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

export type ReadAgent =
  | {
      readonly kind: "agent";
      readonly agent: PlatformAgent;
      readonly connections: readonly RegisteredConnection[];
    }
  | { readonly kind: "not-found"; readonly reason: string }
  | CommonFailure;

/** One agent and every living way of reaching it. */
export async function readAgent(
  agentId: string,
  projectId: string,
  options: RegisterOptions,
): Promise<ReadAgent> {
  const answer = await getAgentRequest(
    { agentId, projectId },
    requestOptions(options),
  );
  if (answer.response?.status === 404) {
    return {
      kind: "not-found",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
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
  if (agent.id !== agentId || agent.projectId !== projectId) {
    return {
      kind: "refused",
      reason:
        "Egma answered with a receipt for a different Agent or Project. Check that this Egma platform is up to date.",
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
    if (
      connection === null ||
      connection.agentId !== agentId ||
      connection.projectId !== projectId
    ) {
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
  | {
      readonly kind: "name-taken";
      readonly name: string;
      readonly reason: string;
    }
  | { readonly kind: "not-found"; readonly reason: string }
  | CommonFailure;

/** Add another way of reaching an agent that already exists. */
export async function addConnection(
  agentId: string,
  projectId: string,
  connection: NewConnection,
  options: RegisterOptions,
): Promise<AddedConnection> {
  const answer = await addConnectionRequest(
    { agentId, projectId, ...connectionParameters(connection) },
    requestOptions(options),
  );

  if (answer.response?.status === 404) {
    return {
      kind: "not-found",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
  if (answer.response?.status === 409 && errorCode(answer.error) === "name_taken") {
    return {
      kind: "name-taken",
      name: connection.name ?? "",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  const receipt = connectionReceipt(answer.data?.connection);
  if (
    receipt === null ||
    !confirmsConnection(receipt, { agentId, projectId, connection })
  ) {
    return {
      kind: "refused",
      reason:
        "Egma answered without a complete matching Connection receipt. The Connection may still have been added. Run egma pull before retrying.",
    };
  }
  return { kind: "added", connection: receipt };
}

/**
 * Write an agent's identity alone, bound to the platform that runs it.
 *
 * Connections are written later through `addConnection`. The binding is the
 * Agent's own fact, so an Agent can exist in the roster before the simulator has
 * a way to reach it.
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
    return {
      kind: "name-taken",
      name: registration.name,
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
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
  if (receipt.result !== "created") {
    return {
      kind: "refused",
      reason:
        "Egma answered identity-only Agent registration with a legacy result. " +
        "Update the Egma platform before trying again.",
    };
  }
  if (
    receipt.agent.name !== registration.name ||
    receipt.agent.agentPlatform !== registration.agentPlatform ||
    (registration.project !== undefined &&
      receipt.agent.projectId !== registration.project) ||
    receipt.agent.platformAgentId !== null ||
    (answer.data !== undefined && answer.data.connection !== undefined)
  ) {
    return {
      kind: "uncertain",
      reason:
        "Egma answered without a complete matching identity-only Agent receipt. Agent registration may still have completed. Run egma pull before retrying.",
    };
  }
  return {
    kind: "registered",
    result: "created",
    agent: receipt.agent,
  };
}

export type RegisterIdentityResult =
  | {
      readonly kind: "registered";
      readonly result: "created";
      readonly agent: RegisteredAgent;
    }
  | {
      readonly kind: "name-taken";
      readonly name: string;
      readonly reason: string;
    }
  | { readonly kind: "uncertain"; readonly reason: string }
  | CommonFailure;
