/** Choose one supported coding agent that Egma proved is installed locally. */

import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type CodingAgentScreenProps = {
  readonly state: WizardState;
  readonly onAnswer: (id: string) => void;
  readonly onQuit: () => void;
};

const VISIBLE = 8;

export function CodingAgentScreen({ state, onAnswer, onQuit }: CodingAgentScreenProps) {
  const agents = state.codingAgentChoices;
  const [at, setAt] = useState(0);
  // Ink can deliver several keys before React draws the next frame. Keep the
  // current row synchronously so a fast Arrow, Arrow, Enter sequence selects
  // the row the developer can see, not the row from the previous render.
  const atRef = useRef(0);
  const moveTo = (next: number): void => {
    if (agents.length === 0) return;
    atRef.current = next;
    setAt(next);
  };
  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose",
      handler: () => moveTo(atRef.current === 0 ? agents.length - 1 : atRef.current - 1),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose",
      handler: () => moveTo((atRef.current + 1) % agents.length),
    },
    {
      match: "return",
      label: "enter",
      action: "use this agent",
      handler: () => {
        const selected = agents[atRef.current];
        if (selected !== undefined) onAnswer(selected.id);
      },
    },
    { match: "q", label: "q", action: "quit", handler: onQuit },
  ];

  useInput((input, key) => dispatchKey(bindings, input, key));

  const from = Math.min(
    Math.max(0, at - Math.floor(VISIBLE / 2)),
    Math.max(0, agents.length - VISIBLE),
  );
  const shown = agents.slice(from, from + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>egma will use a coding agent on your machine to set everything up.</Text>
      <Text>
        We found the following coding agents on your machine. Which one should we use?
      </Text>
      <Box height={1} />
      {agents.length === 0 ? (
        <Text>Looking for Claude Code, Codex, Cursor, and OpenCode…</Text>
      ) : (
        <Box flexDirection="column">
          {shown.map((agent, index) => {
            const chosen = from + index === at;
            return (
              <Text key={agent.id} bold={chosen}>
                {`${chosen ? "›" : " "} ${agent.name}`}
                <Text dimColor>{`  ${agent.version}`}</Text>
              </Text>
            );
          })}
        </Box>
      )}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
