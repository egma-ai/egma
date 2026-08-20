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

export type ListedAgent = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  /** What an edit has to be written against. Every read carries it. */
  readonly revision: string;
  readonly archived: boolean;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

/**
 * One page of them. Keyset, newest first: `next_cursor` is where this page
 * stopped, and asking for more means handing it back. It is `null` rather than
 * absent when there is no next page, so "there is no more" and "this answer is
 * an older shape" are different answers.
 *
 * The items are the widened shape below: the list read carries every listed
 * agent's connections, so a page of agents is a page of *reachability* rather
 * than a page of names each hiding a second request.
 */
export type AgentPage = {
  readonly items: readonly ListedAgentWithConnections[];
  readonly next_cursor: string | null;
};

/**
 * What is known about one target — or the fact that nobody has measured it.
 *
 * `unknown` and a `known` state with nothing in its list are different
 * sentences and lead somewhere different: one is a Refresh away from an answer,
 * the other is a settled fact about the target. A page must never collapse
 * them, which is why the state is its own field rather than an empty array.
 */
export type CapabilityStanding = "supported" | "unsupported" | "not_measured";

export type Capabilities = {
  readonly state: "unknown" | "known";
  /** The catalog keys the adapter looked at, or null when none has. */
  readonly measured: readonly string[] | null;
  /** The measured keys it found. Always a subset of `measured`. */
  readonly supported: readonly string[] | null;
  readonly checked_at: string | null;
  readonly source: string | null;
  /**
   * What the record says about each catalog key, worked out by the server.
   *
   * The page shows this rather than deriving anything from `supported`, because
   * the derivation is the thing that goes wrong: a key missing from `supported`
   * is only an absence when the adapter looked for it, and treating it as one
   * otherwise turns "nobody asked" into "the target cannot", which is the one
   * confusion this record exists to prevent.
   */
  readonly standing: Readonly<Record<string, CapabilityStanding>>;
};

/** The keys this record settles one way or the other, in catalog order. */
export function standingIn(
  capabilities: Capabilities,
  standing: CapabilityStanding,
): readonly string[] {
  return Object.entries(capabilities.standing)
    .filter(([, held]) => held === standing)
    .map(([key]) => key);
}

export type ListedConnection = {
  readonly id: string;
  readonly agent_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly type: string;
  /**
   * What a person is shown for that type, decided by the server's registry.
   *
   * It travels with the connection so that a list of agents can name a platform
   * without a second read, and so that no surface has to keep a label table of
   * its own — a second vocabulary here could disagree with the registry that
   * gates the connection forms.
   */
  readonly type_label: string;
  /** Which shape of its type this is, frozen when it was created. */
  readonly variant_id: string;
  readonly modality: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  /** Whether a credential is stored at all. Never the credential. */
  readonly credential_present: boolean;
  /** Enough to tell two keys apart, and never enough to be one. */
  readonly credentials_hint: string | null;
  readonly capabilities: Capabilities;
  readonly revision: string;
  readonly archived: boolean;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

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
export type ListedAgentWithConnections = ListedAgent & {
  readonly connections: readonly ListedConnection[];
};

export type AgentDetail = {
  readonly agent: ListedAgent;
  readonly connections: readonly ListedConnection[];
};

export const AGENTS_PATH = "/api/agents";

/** Which half of the project a list is asking for. */
export type ArchiveFilter = "active" | "archived";

/**
 * One page of agents, narrowed by whatever the toolbar is set to.
 *
 * The search and the filter are in the address of the request rather than
 * applied to what came back, because a filter that only reached the page
 * already fetched would answer differently depending on how far somebody had
 * scrolled.
 */
export function agentsQuery(options: {
  readonly search?: string;
  readonly filter?: ArchiveFilter;
  readonly cursor?: string;
}): string {
  const asked = new URLSearchParams();
  const wanted = options.search?.trim() ?? "";
  if (wanted !== "") asked.set("search", wanted);
  if (options.filter === "archived") asked.set("archived", "true");
  if (options.cursor !== undefined) asked.set("cursor", options.cursor);
  const written = asked.toString();
  return written === "" ? AGENTS_PATH : `${AGENTS_PATH}?${written}`;
}

export function agentPath(agentId: string): string {
  return `${AGENTS_PATH}/${encodeURIComponent(agentId)}`;
}

/** The agent, with the active connections or the archived ones. */
export function agentDetailQuery(
  agentId: string,
  filter: ArchiveFilter,
): string {
  return filter === "archived"
    ? `${agentPath(agentId)}?archived=true`
    : agentPath(agentId);
}

export function agentActionPath(
  agentId: string,
  action: "archive" | "restore",
): string {
  return `${agentPath(agentId)}/${action}`;
}

export function connectionsPath(agentId: string): string {
  return `${agentPath(agentId)}/connections`;
}

export function connectionPath(
  agentId: string,
  connectionId: string,
): string {
  return `${connectionsPath(agentId)}/${encodeURIComponent(connectionId)}`;
}

export function connectionActionPath(
  agentId: string,
  connectionId: string,
  action: "archive" | "restore" | "capabilities/refresh",
): string {
  return `${connectionPath(agentId, connectionId)}/${action}`;
}

/**
 * How a connection's environment reads when it has none.
 *
 * An empty label is a fact — this connection is not marked staging or
 * production — and it is written out rather than left blank so that a row with
 * no label reads as deliberate rather than as a cell that failed to render.
 */
export const NO_ENVIRONMENT = "Unlabelled";
