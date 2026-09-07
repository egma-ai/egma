import type {
  GetAgentResponse,
  ListAgentsResponse,
} from "@egma/platform-api/client";

import { agentPlatformLabel } from "./transcripts.ts";

/**
 * API response types for a project's agents under test and their connections.
 * Provider configuration stays on the agent platform; reads expose credential
 * status and hints, not secrets.
 */

export type ListedAgentWithConnections = ListAgentsResponse["agents"][number];
export type ListedAgent = Omit<ListedAgentWithConnections, "connections">;

/** A page of agents with their active connections and the API pagination token. */
export type AgentPage = ListAgentsResponse;

export type ListedConnection = ListedAgentWithConnections["connections"][number];

/** One stored modality in the words a person reads. */
export function modalityLabel(modality: string): string {
  return modality === "voice" ? "Voice" : "Chat";
}

/** A compact connection identity that never asks the editable name to imply modality. */
export function connectionLabel(
  connection: Pick<ListedConnection, "name" | "modality">,
): string {
  return `${connection.name} · ${modalityLabel(connection.modality)}`;
}

/** Agent detail using the generated response shape, including connections. */
export type AgentDetail = GetAgentResponse;

/** Which half of the project a list is asking for. */
export type ArchiveFilter = "active" | "archived";

/**
 * List distinct platforms from active connections in display order. Fall back
 * to the agent's declared platform when it has no active connections.
 */
export function agentPlatformText(
  agent: ListedAgentWithConnections,
): string {
  const named = new Set<string>();
  for (const connection of agent.connections) {
    named.add(connection.agentPlatform);
  }
  if (named.size === 0) named.add(agent.agentPlatform);
  return [...named]
    .sort((one, other) => platformRank(one) - platformRank(other))
    .map(agentPlatformLabel)
    .join(PLATFORM_JOIN);
}

/**
 * The order two platforms are named in: the vocabulary's, not the
 * connections'.
 *
 * Connections come back in the order they were made, so ordering by them would
 * let one agent read `Retell · LiveKit` and the next agent read the
 * reverse for the same two platforms. A platform this list does not hold is
 * named after the ones it does, in the order the connections named it.
 */
const PLATFORM_ORDER: readonly string[] = ["retell", "livekit"];

function platformRank(platform: string): number {
  const at = PLATFORM_ORDER.indexOf(platform);
  return at === -1 ? PLATFORM_ORDER.length : at;
}

/** What stands between two platforms in one cell. */
const PLATFORM_JOIN = " · ";

/**
 * How many connections a row draws before it counts the rest.
 *
 * Two, which is what the board draws (`6ZJ-0`: two links then "+3" on an agent
 * with five). A row is a line of reading, and a fifth link on it would make the
 * row taller than every other row for no fact anybody scans for.
 */
export const CONNECTIONS_ON_ROW = 2;

/** The connections one row names, and the number it could not fit. */
export function connectionsOnRow(
  connections: readonly ListedConnection[],
  limit: number = CONNECTIONS_ON_ROW,
): {
  readonly shown: readonly ListedConnection[];
  readonly overflow: number;
} {
  return {
    shown: connections.slice(0, limit),
    overflow: Math.max(0, connections.length - limit),
  };
}
