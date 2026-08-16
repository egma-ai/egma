/**
 * Which voice agent, when the account holds more than one.
 *
 * This screen exists only when there is a real choice. One agent on the account
 * is not a choice, so the flow never opens the question and the router never
 * reaches here — a wizard that asks a question with one answer is a wizard that
 * has stopped respecting the developer's time.
 *
 * The names are the customer's own, taken from their provider account, and the
 * identifier is shown beside each one because two agents in a real account are
 * very often called nearly the same thing.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type RetellAgentScreenProps = {
  readonly state: WizardState;
  /** The chosen agent's id, or `null` when the developer chose none. */
  readonly onAnswer: (agentId: string | null) => void;
};

/** How many rows are on screen at once, so a long account still fits. */
const VISIBLE = 8;

export function RetellAgentScreen({ state, onAnswer }: RetellAgentScreenProps) {
  const agents = state.agentChoices ?? [];
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
      action: "connect this one",
      handler: () => onAnswer(agents[at]?.id ?? null),
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
  const from = Math.min(Math.max(0, at - Math.floor(VISIBLE / 2)), Math.max(0, agents.length - VISIBLE));
  const shown = agents.slice(from, from + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>{`That key reaches ${agents.length} agents. Which one do you want tested?`}</Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((agent, index) => {
          const chosen = from + index === at;
          return (
            <Text key={agent.id} bold={chosen}>
              {`${chosen ? "›" : " "} ${agent.name === "" ? agent.id : agent.name}`}
              <Text dimColor>{`  ${agent.id}`}</Text>
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
