/**
 * Register a LiveKit agent through Egma's platform API.
 *
 * LiveKit has two connection shapes. A project key pair lets Egma mint room
 * tokens, and is the shape that can speak chat as well as voice, because it is
 * the shape where Egma dispatches the worker itself and can tell it which of
 * the two this simulation is. A token endpoint keeps the signing secret on the
 * customer's side, and speaks voice alone for the same reason.
 *
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
  /** Omit and the platform chooses `livekit_chat-1` or `livekit_voice-1`. */
  readonly connectionName?: string | undefined;
  readonly environment?: string | undefined;
  /** The customer's LiveKit Cloud project or self-hosted server. */
  readonly url: string;
};

export type LiveKitKeyPairRegistration = CommonRegistration & {
  readonly variant: typeof LIVEKIT_KEY_PAIR_VARIANT;
  /** The name the customer's worker registers under, and Egma dispatches. */
  readonly agentName: string;
  /** Which of the two the simulator conducts over this connection. */
  readonly modality: "chat" | "voice";
  /**
   * JSON object text handed to the worker on the room's metadata and on the
   * dispatch's both — `agentName` above always names a worker to dispatch.
   */
  readonly metadata?: string | undefined;
  readonly credentials: ConnectionCredentials;
};

export type LiveKitTokenEndpointRegistration = CommonRegistration & {
  readonly variant: typeof LIVEKIT_TOKEN_ENDPOINT_VARIANT;
  /** Egma asks this endpoint for a room token once per simulation. */
  readonly tokenEndpoint: string;
  /**
   * Voice, and only voice.
   *
   * Egma never dispatches the worker on this variant, so it has no channel to
   * tell the agent that this simulation is typed. The field stays here so the
   * two shapes read the same way, and its type is what refuses chat before a
   * request is built.
   */
  readonly modality: "voice";
  /** Auth headers for the public token endpoint. */
  readonly credentials: ConnectionCredentials;
};

export type LiveKitRegistration =
  LiveKitKeyPairRegistration | LiveKitTokenEndpointRegistration;

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
    const metadata = optionalText(input.metadata);
    config.agentName = input.agentName.trim();
    if (metadata !== undefined) config.metadata = metadata;
  } else {
    config.tokenEndpoint = input.tokenEndpoint.trim();
  }

  return {
    ...(input.connectionName === undefined
      ? {}
      : { name: input.connectionName.trim() }),
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: input.variant,
    modality: input.modality,
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
 * A LiveKit target now has a safe reuse key — the server's normalized origin
 * and the worker's registered name — so registering the same worker again
 * lands on the agent that already holds it, and its chat and voice results
 * accumulate in one place. The platform owns that rule; this module only sends
 * a connection complete enough for it to be applied.
 *
 * All ordinary platform endings remain values. `name-taken` now means what it
 * says and nothing more: the Egma agent name asked for is held by a different
 * vendor agent. Renaming this one is the answer, and the wizard says so rather
 * than joining two targets under one row.
 */
export function connectLiveKit(
  input: LiveKitRegistration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const registration: Registration = {
    name: input.name.trim(),
    agentPlatform: "livekit",
    ...(input.project === undefined ? {} : { project: input.project }),
    connection: liveKitConnection(input),
  };

  return registerAgent(registration, options);
}
