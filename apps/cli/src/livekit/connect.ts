/**
 * Register a LiveKit agent through Egma's platform API.
 *
 * LiveKit has two connection shapes. A project key pair lets Egma mint room
 * tokens. A token endpoint keeps the signing secret on the customer's side.
 * This module only builds and registers those shapes. It never contacts a
 * LiveKit server or a token endpoint during setup.
 */

import {
  registerAgent,
  type NewConnection,
  type RegisterOptions,
  type RegisterResult,
  type Registration,
} from "../platform/agents.ts";
import { ConnectionCredentials } from "../platform/connection-credentials.ts";

export const LIVEKIT_KEY_PAIR_VARIANT = "livekit_room.project_credentials";
export const LIVEKIT_TOKEN_ENDPOINT_VARIANT =
  "livekit_room.customer_token_endpoint";

type CommonRegistration = {
  /** The agent's name in Egma. */
  readonly name: string;
  readonly project?: string | undefined;
  /** Omit and the platform chooses `livekit-1`. */
  readonly connectionName?: string | undefined;
  readonly environment?: string | undefined;
  /** The customer's LiveKit Cloud project or self-hosted server. */
  readonly url: string;
};

export type LiveKitKeyPairRegistration = CommonRegistration & {
  readonly variant: typeof LIVEKIT_KEY_PAIR_VARIANT;
  /** Omit for automatic dispatch. */
  readonly agentName?: string | undefined;
  /** JSON object text handed to the worker as room metadata. */
  readonly metadata?: string | undefined;
  readonly credentials: ConnectionCredentials;
};

export type LiveKitTokenEndpointRegistration = CommonRegistration & {
  readonly variant: typeof LIVEKIT_TOKEN_ENDPOINT_VARIANT;
  /** Egma asks this endpoint for a room token once per simulation. */
  readonly tokenEndpoint: string;
  /** Auth headers for the public token endpoint. */
  readonly credentials: ConnectionCredentials;
};

export type LiveKitRegistration =
  | LiveKitKeyPairRegistration
  | LiveKitTokenEndpointRegistration;

/** Hold the project key pair without making it printable. */
export function liveKitKeyPair(
  apiKey: string,
  apiSecret: string,
): ConnectionCredentials {
  return ConnectionCredentials.hold({
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim(),
  });
}

/** Hold token-endpoint auth headers without making their values printable. */
export function liveKitTokenHeaders(headers: string): ConnectionCredentials {
  return ConnectionCredentials.hold({ headers: headers.trim() });
}

function optionalText(value: string | undefined): string | undefined {
  const held = value?.trim() ?? "";
  return held === "" ? undefined : held;
}

/**
 * The connection payload one LiveKit registration means.
 *
 * Pulled out because it is wanted twice: written under a new agent, and added
 * to an agent this sitting already created. Two copies of it would be two
 * shapes for one connection, and the second one would drift.
 */
export function liveKitConnection(input: LiveKitRegistration): NewConnection {
  const config: Record<string, string> = { url: input.url.trim() };
  if (input.variant === LIVEKIT_KEY_PAIR_VARIANT) {
    const agentName = optionalText(input.agentName);
    const metadata = optionalText(input.metadata);
    if (agentName !== undefined) config.agentName = agentName;
    if (metadata !== undefined) config.metadata = metadata;
  } else {
    config.tokenEndpoint = input.tokenEndpoint.trim();
  }

  return {
    ...(input.connectionName === undefined
      ? {}
      : { name: input.connectionName.trim() }),
    agentPlatform: "livekit_agents",
    connectionType: "livekit_room",
    accessVariant: input.variant,
    modality: "voice",
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment.trim() }),
    config,
    credentials: input.credentials,
  };
}

/**
 * Register one LiveKit agent and its first connection.
 *
 * All ordinary platform endings remain values. In particular, `name-taken`
 * is returned to the wizard instead of silently joining a new LiveKit target
 * to an agent with the same name: a LiveKit URL names a server, not one agent,
 * so there is no safe automatic reuse key.
 */
export function connectLiveKit(
  input: LiveKitRegistration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const registration: Registration = {
    name: input.name.trim(),
    ...(input.project === undefined ? {} : { project: input.project }),
    connection: liveKitConnection(input),
  };

  return registerAgent(registration, options);
}
