/** Resolve one committed agent and connection without guessing between choices. */

import type {
  FolderAgent,
  FolderConfig,
  FolderConnection,
} from "./egma-folder.ts";

export type TargetSelectionStatus =
  | "not-connected"
  | "unchosen-agent"
  | "unknown-agent"
  | "ambiguous-agent"
  | "unchosen-connection"
  | "unknown-connection"
  | "ambiguous-connection";

export type SelectedTarget = {
  readonly kind: "selected";
  readonly agent: FolderAgent;
  readonly connection: FolderConnection;
};

export type RefusedTarget = {
  readonly kind: "refused";
  readonly status: TargetSelectionStatus;
  readonly message: string;
  /** The agents a caller can name after this refusal. */
  readonly agents: readonly FolderAgent[];
  /** The selected agent's connections, when the refusal reached that choice. */
  readonly connections: readonly FolderConnection[];
};

export type TargetSelection = SelectedTarget | RefusedTarget;

export type TargetSelectors = {
  readonly agent?: string | null;
  readonly connection?: string | null;
};

export type FolderAgentSelection =
  | { readonly kind: "selected"; readonly agent: FolderAgent }
  | {
      readonly kind: "none" | "unknown" | "ambiguous" | "unchosen";
      readonly choices: readonly FolderAgent[];
    };

function selector(value: string | null | undefined): string | null {
  const selected = (value ?? "").trim();
  return selected === "" ? null : selected;
}

function matching<T extends { readonly id: string; readonly name: string }>(
  choices: readonly T[],
  selected: string,
): readonly T[] {
  return choices.filter((choice) => choice.id === selected || choice.name === selected);
}

/**
 * Resolve one agent by exact name or id, without applying command-specific
 * eligibility rules or writing command-specific refusal copy.
 */
export function selectFolderAgent(
  agents: readonly FolderAgent[],
  selected?: string | null,
): FolderAgentSelection {
  const wanted = selector(selected);
  if (wanted !== null) {
    const matches = matching(agents, wanted);
    if (matches.length === 1) return { kind: "selected", agent: matches[0]! };
    if (matches.length > 1) return { kind: "ambiguous", choices: matches };
    return { kind: "unknown", choices: agents };
  }

  if (agents.length === 1) return { kind: "selected", agent: agents[0]! };
  if (agents.length > 1) return { kind: "unchosen", choices: agents };
  return { kind: "none", choices: [] };
}

function refused(
  status: TargetSelectionStatus,
  message: string,
  agents: readonly FolderAgent[],
  connections: readonly FolderConnection[] = [],
): RefusedTarget {
  return { kind: "refused", status, message, agents, connections };
}

function chooseAgent(
  agents: readonly FolderAgent[],
  selected: string | null,
): FolderAgent | RefusedTarget {
  // A monitoring-only agent has no simulation connection and is not a run
  // target. It must not turn one runnable agent into an unnecessary choice.
  const runnable = agents.filter((agent) => agent.connections.length > 0);
  if (selected === null && runnable.length === 0 && agents.length !== 1) {
    return refused(
      "not-connected",
      "This folder does not name any voice agent with a connection. Run egma connect here first. Nothing was started.",
      agents,
    );
  }
  const choices = selected === null && runnable.length > 0 ? runnable : agents;
  const choice = selectFolderAgent(choices, selected);
  switch (choice.kind) {
    case "selected":
      return choice.agent;
    case "ambiguous":
      return refused(
        "ambiguous-agent",
        `${JSON.stringify(selected)} exactly matches more than one configured voice agent. Use its stable agent id with --agent. Nothing was started.`,
        choice.choices,
      );
    case "unknown":
      return refused(
        "unknown-agent",
        `No configured voice agent exactly matches ${JSON.stringify(selected)}. Choose one with --agent <name-or-id>. Nothing was started.`,
        choice.choices,
      );
    case "unchosen":
      return refused(
        "unchosen-agent",
        `This folder names ${String(choice.choices.length)} voice agents that can run. Choose one with --agent <name-or-id>. Nothing was started.`,
        choice.choices,
      );
    case "none":
      return refused(
        "not-connected",
        "This folder does not name any voice agent with a connection. Run egma connect here first. Nothing was started.",
        agents,
      );
  }
}

function chooseConnection(
  agent: FolderAgent,
  selected: string | null,
): FolderConnection | RefusedTarget {
  const connections = agent.connections;
  if (selected !== null) {
    const matches = matching(connections, selected);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      return refused(
        "ambiguous-connection",
        `${JSON.stringify(selected)} exactly matches more than one connection under agent ${JSON.stringify(agent.name)}. Use its stable connection id with --connection. Nothing was started.`,
        [agent],
        matches,
      );
    }
    return refused(
      "unknown-connection",
      `No connection under agent ${JSON.stringify(agent.name)} exactly matches ${JSON.stringify(selected)}. Choose one with --connection <name-or-id>. Nothing was started.`,
      [agent],
      connections,
    );
  }

  if (connections.length === 1) return connections[0]!;
  if (connections.length > 1) {
    return refused(
      "unchosen-connection",
      `Agent ${JSON.stringify(agent.name)} has ${String(connections.length)} connections. Choose one with --connection <name-or-id>. Nothing was started.`,
      [agent],
      connections,
    );
  }
  return refused(
    "not-connected",
    `Agent ${JSON.stringify(agent.name)} has no configured connection. Run egma connect to add one. Nothing was started.`,
    [agent],
  );
}

/**
 * Select a run target from the committed repository catalog.
 *
 * Names and stable ids are both exact selectors. Absence is accepted only when
 * one runnable choice remains, so a non-interactive command never picks between
 * two customer agents or two ways of reaching one.
 */
export function selectTarget(
  config: Pick<FolderConfig, "agents">,
  selectors: TargetSelectors = {},
): TargetSelection {
  const agent = chooseAgent(config.agents, selector(selectors.agent));
  if ("kind" in agent) return agent;

  const connection = chooseConnection(agent, selector(selectors.connection));
  if ("kind" in connection) return connection;
  return { kind: "selected", agent, connection };
}
