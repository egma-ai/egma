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
  type AddConnectionResponse,
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
type AnsweredConnection = AddConnectionResponse["connection"];

export type NewConnection = {
  /** Omit and the platform chooses a numbered product-label name. */
  readonly name?: string | undefined;
  /** Who runs the agent, or null when Egma does not know. */
  readonly agentPlatform: ConnectionInput["agentPlatform"];
  /** What Egma connects to for this simulation. */
  readonly connectionKind: ConnectionInput["connectionKind"];
  /** How Egma gets access to that connection. */
  readonly accessVariant: ConnectionInput["accessVariant"];
  readonly modality: ConnectionInput["modality"];
  readonly environment?: string | undefined;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed by the platform. Never answered back and never stored here. */
  readonly credentials?: ConnectionCredentials | undefined;
  /**
   * The external agent selected during provider discovery. The platform checks
   * it again inside the create request, then discards it.
   */
  readonly agentPlatformSelection?:
    | {
        readonly platformAgentId: string;
        readonly credentials: ConnectionCredentials;
      }
    | undefined;
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
  readonly agentPlatform: string | null;
  readonly connectionKind: string;
  readonly accessVariant: string;
  readonly modality: string;
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

function requestOptions(options: RegisterOptions) {
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

function cleanAgent(agent: { readonly id: string; readonly name: string }): RegisteredAgent {
  return { id: platformText(agent.id), name: platformText(agent.name) };
}

function cleanConnection(connection: AnsweredConnection): RegisteredConnection {
  return {
    id: platformText(connection.id),
    name: platformText(connection.name),
    agentPlatform:
      connection.agentPlatform === null ? null : platformText(connection.agentPlatform),
    connectionKind: platformText(connection.connectionKind),
    accessVariant: platformText(connection.accessVariant),
    modality: platformText(connection.modality),
    productLabel: platformText(connection.productLabel),
    credentialsHint:
      connection.credentialsHint === null
        ? null
        : platformText(connection.credentialsHint),
    config: { ...connection.config },
  };
}

function connectionParameters(connection: NewConnection): ConnectionInput {
  const selectionCredentials =
    connection.agentPlatformSelection?.credentials.reveal();
  return {
    ...(connection.name === undefined ? {} : { name: connection.name }),
    agentPlatform: connection.agentPlatform,
    connectionKind: connection.connectionKind,
    accessVariant: connection.accessVariant,
    modality: connection.modality,
    ...(connection.environment === undefined
      ? {}
      : { environment: connection.environment }),
    config: { ...connection.config },
    ...(connection.credentials === undefined
      ? {}
      : { credentials: connection.credentials.reveal() }),
    ...(connection.agentPlatformSelection === undefined
      ? {}
      : {
          agentPlatformSelection: {
            platformAgentId: connection.agentPlatformSelection.platformAgentId,
            credentials: { apiKey: selectionCredentials?.["apiKey"] ?? "" },
          },
        }),
  };
}

type CommonFailure =
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

function commonFailure(
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

/** How many pages of agents are walked before giving up on finding a name. */
const MOST_PAGES = 20;

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

    for (const agent of answer.data?.agents ?? []) {
      if (platformText(agent.name) === wanted) {
        return { kind: "found", agent: cleanAgent(agent) };
      }
    }

    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") break;
    pageToken = next;
  }

  return { kind: "not-found" };
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
  return {
    kind: "agent",
    agent: cleanAgent(body.agent),
    connections: body.connections.map(cleanConnection),
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
  if (answer.data === undefined) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma platform is up to date.",
    };
  }
  return { kind: "added", connection: cleanConnection(answer.data.connection) };
}

/** Atomically write an agent and its first connection. */
export async function registerAgent(
  registration: Registration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const connection = connectionParameters(registration.connection);
  const answer = await registerAgentRequest(
    {
      name: registration.name,
      ...(registration.description === undefined
        ? {}
        : { description: registration.description }),
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
  if (body === undefined || body.connection === undefined) {
    return {
      kind: "refused",
      reason: "Egma answered without saying what it wrote. Check that this Egma platform is up to date.",
    };
  }
  return {
    kind: "registered",
    registered: {
      result: body.result,
      agent: cleanAgent(body.agent),
      connection: cleanConnection(body.connection),
    },
  };
}
