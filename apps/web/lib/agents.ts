import type {
  GetAgentResponse,
  ListAgentsResponse,
} from "@egma/platform-api/client";

import { agentPlatformLabel } from "./transcripts.ts";

/**
 * The agents of one project, and every way egma can reach one, as the API
 * answers them.
 *
 * An **agent** is the customer's voice agent — the thing egma is trying to
 * establish trust in. It belongs to a project, which is why these reads are
 * never made without one. A **connection** is how egma reaches an agent, and an
 * agent has many: the same logical agent might be a process on a laptop today,
 * a hosted assistant in staging, and a phone number in production.
 *
 * The shapes are the API's own, field names included. Renaming its fields on
 * the way in would put a second vocabulary between the contract and the page,
 * and the two would drift the first time the API grew a field.
 *
 * **What is not here is as deliberate as what is.** No provider prompt, no
 * model, no tools: those live where the customer configures them, and a copy
 * in this application would be stale from the moment it was taken. And no
 * credential — a read answers whether one is present and a hint of which one it
 * is, and never the secret.
 */

export type ListedAgentWithConnections = ListAgentsResponse["agents"][number];
export type ListedAgent = Omit<ListedAgentWithConnections, "connections">;

/**
 * One page of them. Keyset, newest first: `nextCursor` is where this page
 * stopped, and asking for more means handing it back. It is `null` rather than
 * absent when there is no next page, so "there is no more" and "this answer is
 * an older shape" are different answers.
 *
 * The items are the widened shape below: the list read carries every listed
 * agent's connections, so a page of agents is a page of *reachability* rather
 * than a page of names each hiding a second request.
 */
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

/**
 * One agent as a *list* of them answers it: the identity above, and every
 * living way egma can reach it.
 *
 * The connections are the same shape the agent's own read answers, because the
 * API describes them with one function. So a row and a page never disagree
 * about what a connection is, and code that reads one reads the other.
 *
 * Archived connections are not among them. "How egma reaches this agent" and
 * "how it used to" are two questions, and the second is asked of the agent's
 * own read.
 */
export type AgentDetail = GetAgentResponse;

/** Which half of the project a list is asking for. */
export type ArchiveFilter = "active" | "archived";

/**
 * Which platforms an agent is on, in the words a person reads, as this
 * application can honestly answer it.
 *
 * Every agent declares its platform when it is registered. Connections can
 * still name another platform when their connection type pins one, so the
 * list says every platform represented by a live connection and falls back to
 * the agent's declared platform when it has no live connection.
 *
 * **An agent can be reached on two platforms at once**, so every platform its
 * live connections name is said, and not the first of them. One Retell
 * connection and one LiveKit connection on one agent is an ordinary state, and
 * naming only the first made the answer depend on which connection was made
 * first: the same agent read `Retell` today and `LiveKit` the day that
 * connection was archived, with nothing about the agent having changed.
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
