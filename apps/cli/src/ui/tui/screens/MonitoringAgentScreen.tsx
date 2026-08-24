/**
 * Which agent on the account Egma should watch.
 *
 * The list is Egma's own, not the platform vendor's: it is the only one that
 * knows which of these agents this project already registers and which of those
 * are already being watched. Both facts are drawn beside the name, because they
 * change what pressing enter does — picking an agent Egma already knows starts
 * watching the row that exists, and picking one it does not brings a new row
 * into the roster in the same commit.
 *
 * This screen exists only when there is a real choice. One agent on the account
 * is not a choice, so the flow never opens the question and the router never
 * reaches here.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type MonitoringAgentScreenProps = {
  readonly state: WizardState;
  /** The chosen platform agent's id, or `null` when the developer chose none. */
  readonly onAnswer: (platformAgentId: string | null) => void;
};

/** How many rows are on screen at once, so a long account still fits. */
const VISIBLE = 8;

export function MonitoringAgentScreen({ state, onAnswer }: MonitoringAgentScreenProps) {
  const agents = state.monitoringAgentChoices ?? [];
  const [at, setAt] = useState(0);

  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held === 0 ? agents.length - 1 : held - 1)),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held + 1) % Math.max(agents.length, 1)),
    },
    {
      match: "return",
      label: "enter",
      action: "watch this one",
      handler: () => onAnswer(agents[at]?.platformAgentId ?? null),
    },
    {
      match: "escape",
      label: "esc",
      action: "none of these",
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  // The window follows the cursor rather than the cursor following the window,
  // so the chosen row is always on screen however long the account is.
  const from = Math.min(
    Math.max(0, at - Math.floor(VISIBLE / 2)),
    Math.max(0, agents.length - VISIBLE),
  );
  const shown = agents.slice(from, from + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        {`That key reaches ${agents.length} voice agents. Which one should Egma watch?`}
      </Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((agent, index) => {
          const chosen = from + index === at;
          const known =
            agent.pullProductionCalls
              ? `already watched as ${agent.registeredAgentName ?? "an Egma agent"}`
              : agent.registeredAgentName === null
                ? "new to Egma"
                : `on Egma as ${agent.registeredAgentName}`;
          return (
            <Text key={agent.platformAgentId} bold={chosen}>
              {`${chosen ? "›" : " "} ${agent.name === "" ? agent.platformAgentId : agent.name}`}
              <Text dimColor>{`  ${known}`}</Text>
            </Text>
          );
        })}
      </Box>
      {agents.length > VISIBLE ? (
        <Box marginTop={1}>
          <Text dimColor>{`${agents.length - shown.length} more`}</Text>
        </Box>
      ) : null}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
