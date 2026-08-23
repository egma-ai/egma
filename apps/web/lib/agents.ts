import type {
  GetAgentResponse,
  ListAgentsResponse,
} from "@egma/platform-api/client";

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
 * How a connection's environment reads when it has none.
 *
 * An empty label is a fact — this connection is not marked staging or
 * production — and it is written out rather than left blank so that a row with
 * no label reads as deliberate rather than as a cell that failed to render.
 */
export const NO_ENVIRONMENT = "Unlabelled";

/**
 * Which platform an agent is on, as this application can honestly answer it.
 *
 * **The agent's own `agentPlatform` is null until Start monitoring binds it.**
 * `registerAgent` cannot set it — the contract has no field for it — so an
 * agent registered today and given a Retell connection this afternoon still
 * reads `null` on itself. Its connections do know: every connection carries the
 * platform it was written against.
 *
 * So the answer is read from the connections first and from the agent second,
 * and it is `null` when neither has one. That order is the truthful one: a
 * connection is a fact about a live way in, and the agent's own column is the
 * monitoring binding, which is a different question that happens to share a
 * word.
 */
export function agentPlatformOf(agent: ListedAgentWithConnections): string | null {
  for (const connection of agent.connections) {
    if (connection.agentPlatform !== null) return connection.agentPlatform;
  }
  return agent.agentPlatform;
}

/**
 * What a cell says when nothing has named a platform.
 *
 * An em dash rather than a sentence: the column is one word wide, and "not
 * bound" would be a claim about monitoring rather than about this agent's
 * connections.
 */
export const NO_PLATFORM = "—";

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
