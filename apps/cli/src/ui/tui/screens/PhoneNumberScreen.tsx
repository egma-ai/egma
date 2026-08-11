/**
 * Which number egma should dial, when Retell routes more than one to the agent.
 *
 * This screen exists only when there is a real choice. One number is not a
 * choice, so the flow never opens the question and the router never reaches
 * here — the same rule the choice of agent follows.
 *
 * Every number on it is one Retell already routes to the agent the developer
 * picked, so there is no way through this screen to a telephone that somebody
 * else answers. The customer's own nickname for each is shown beside it,
 * because two numbers on a real account are very often nearly the same digits.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { NUMBER_ASK_LINE } from "../../../retell/connect.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type PhoneNumberScreenProps = {
  readonly state: WizardState;
  /** The chosen number in E.164, or `null` when the developer chose none. */
  readonly onAnswer: (number: string | null) => void;
};

/** How many rows are on screen at once, so a long account still fits. */
const VISIBLE = 8;

export function PhoneNumberScreen({ state, onAnswer }: PhoneNumberScreenProps) {
  const numbers = state.numberChoices ?? [];
  const [at, setAt] = useState(0);

  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held === 0 ? numbers.length - 1 : held - 1)),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held + 1) % Math.max(numbers.length, 1)),
    },
    {
      match: "return",
      label: "enter",
      action: "dial this one",
      handler: () => onAnswer(numbers[at]?.number ?? null),
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
  // so the chosen row is always on screen however many numbers there are.
  const from = Math.min(
    Math.max(0, at - Math.floor(VISIBLE / 2)),
    Math.max(0, numbers.length - VISIBLE),
  );
  const shown = numbers.slice(from, from + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>{NUMBER_ASK_LINE}</Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((number, index) => {
          const chosen = from + index === at;
          return (
            <Text key={number.number} bold={chosen}>
              {`${chosen ? "›" : " "} ${number.number}`}
              {number.label === "" ? "" : <Text dimColor>{`  ${number.label}`}</Text>}
            </Text>
          );
        })}
      </Box>
      {numbers.length > VISIBLE ? (
        <Box marginTop={1}>
          <Text dimColor>{`${numbers.length - shown.length} more`}</Text>
        </Box>
      ) : null}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
