/**
 * Text or phone: how egma should reach the agent under test.
 *
 * The one question in the walk whose answer decides what egma writes. Both ways
 * are real and both are supported, and **egma creates the one that is chosen and
 * never both** — a second connection nobody asked for is a second thing in
 * somebody's project that they would find later and have to work out.
 *
 * **The highlight starts on text, and the keystroke is still required.** One of
 * the two dials a real telephone and costs real money, so the row the cursor
 * rests on before anybody has touched it is the one that does not — but resting
 * there is not choosing, and nothing at all is created until enter is pressed.
 * A developer who closes the wizard here has answered too, and nothing is
 * created then either.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { REACH_ASK_LINE, REACH_LINES, type Reach } from "../../../retell/connect.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type ReachScreenProps = {
  /** The ways the selected Retell agent supports. */
  readonly ways: readonly Reach[];
  /** The chosen way, or `null` when the developer chose neither. */
  readonly onAnswer: (reach: Reach | null) => void;
};

export function ReachScreen({ ways, onAnswer }: ReachScreenProps) {
  const [at, setAt] = useState(0);

  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held === 0 ? ways.length - 1 : held - 1)),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose",
      handler: () => setAt((held) => (held + 1) % ways.length),
    },
    {
      match: "return",
      label: "enter",
      action: "reach it this way",
      handler: () => onAnswer(ways[at] ?? null),
    },
    {
      match: "escape",
      label: "esc",
      action: "neither",
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>{REACH_ASK_LINE}</Text>
      <Box height={1} />
      <Box flexDirection="column">
        {ways.map((way, index) => {
          const chosen = index === at;
          return (
            <Text key={way} bold={chosen}>
              {`${chosen ? "›" : " "} ${REACH_LINES[way]}`}
            </Text>
          );
        })}
      </Box>
      <Box height={1} />
      <Text dimColor>Egma creates this connection only after you confirm it.</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
