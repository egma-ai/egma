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
  return choices.filter((choice) => choice.id === selected);
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
      "This folder does not name any Agent with a Connection. Run egma agent register first. Nothing was started.",
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
        `${JSON.stringify(selected)} matches more than one configured Agent ID. Nothing was started.`,
        choice.choices,
      );
    case "unknown":
      return refused(
        "unknown-agent",
        `No configured Agent has ID ${JSON.stringify(selected)}. Choose one with --agent <Agent ID>. Nothing was started.`,
        choice.choices,
      );
    case "unchosen":
      return refused(
        "unchosen-agent",
        `This folder names ${String(choice.choices.length)} Agents that can run. Choose one with --agent <Agent ID>. Nothing was started.`,
        choice.choices,
      );
    case "none":
      return refused(
        "not-connected",
        "This folder does not name any Agent with a Connection. Run egma agent register first. Nothing was started.",
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
        `${JSON.stringify(selected)} matches more than one Connection ID under Agent ${agent.id}. Nothing was started.`,
        [agent],
        matches,
      );
    }
    return refused(
      "unknown-connection",
      `No Connection under Agent ${agent.id} has ID ${JSON.stringify(selected)}. Choose one with --connection <Connection ID>. Nothing was started.`,
      [agent],
      connections,
    );
  }

  if (connections.length === 1) return connections[0]!;
  if (connections.length > 1) {
    return refused(
      "unchosen-connection",
      `Agent ${agent.id} has ${String(connections.length)} Connections. Choose one with --connection <Connection ID>. Nothing was started.`,
      [agent],
      connections,
    );
  }
  return refused(
    "not-connected",
    `Agent ${JSON.stringify(agent.name)} has no configured Connection. Run egma agent connection add to add one. Nothing was started.`,
    [agent],
  );
}

/**
 * Select a run target from the committed repository catalog.
 *
 * Stable ids are explicit selectors. A command never chooses an Agent or a
 * Connection because only one happens to exist today.
 */
export function selectTarget(
  config: Pick<FolderConfig, "agents">,
  selectors: TargetSelectors = {},
): TargetSelection {
  if (selector(selectors.agent) === null) {
    return refused(
      "unchosen-agent",
      "Choose an Egma Agent with --agent <Agent ID>. Nothing was started.",
      config.agents,
    );
  }
  const agent = chooseAgent(config.agents, selector(selectors.agent));
  if ("kind" in agent) return agent;

  if (selector(selectors.connection) === null) {
    return refused(
      "unchosen-connection",
      `Choose a Connection under Agent ${agent.id} with --connection <Connection ID>. Nothing was started.`,
      [agent],
      agent.connections,
    );
  }

  const connection = chooseConnection(agent, selector(selectors.connection));
  if ("kind" in connection) return connection;
  return { kind: "selected", agent, connection };
}
