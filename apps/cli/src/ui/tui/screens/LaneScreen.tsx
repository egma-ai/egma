/**
 * The one question: how should Egma test this agent?
 *
 * Three lanes, and **several may be picked at once** — the answer decides what
 * egma writes, and a developer testing one voice agent in text *and* over the
 * telephone gets both connections on one egma agent in one pass, which is what
 * makes one test suite run over both.
 *
 * **Nothing is picked before somebody picks it, and nothing is created until
 * enter.** One lane dials a real telephone and costs real money, so no row
 * starts ticked; the cursor rests on the fastest lane, and resting there is not
 * picking. A developer who closes the wizard here has answered too, and nothing
 * is created then either.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { LANE_ASK_LINE, LANE_LINES, type Lane } from "../../../retell/connect.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type LaneScreenProps = {
  /** The lanes this agent can be tested over, in reading order. */
  readonly options: readonly Lane[];
  /** The lanes picked, or `null` when the developer picked none. */
  readonly onAnswer: (lanes: readonly Lane[] | null) => void;
};

export function LaneScreen({ options, onAnswer }: LaneScreenProps) {
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<readonly Lane[]>([]);

  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "move",
      handler: () =>
        setAt((held) => (held === 0 ? options.length - 1 : held - 1)),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "move",
      handler: () => setAt((held) => (held + 1) % options.length),
    },
    {
      match: " ",
      label: "space",
      action: "pick",
      handler: () =>
        setPicked((held) => {
          const lane = options[at];
          if (lane === undefined) return held;
          return held.includes(lane)
            ? held.filter((one) => one !== lane)
            : [...held, lane];
        }),
    },
    {
      match: "return",
      label: "enter",
      action: "test it these ways",
      // Enter with nothing ticked is not an accident worth guessing at: it is
      // the answer "none of these", and nothing is created for it.
      handler: () => onAnswer(picked.length === 0 ? null : picked),
    },
    {
      match: "escape",
      label: "esc",
      action: "none",
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
      <Text>{LANE_ASK_LINE}</Text>
      <Text dimColor>Pick as many as you want.</Text>
      <Box height={1} />
      <Box flexDirection="column">
        {options.map((lane, index) => {
          const here = index === at;
          const on = picked.includes(lane);
          return (
            <Text key={lane} bold={here}>
              {`${here ? "›" : " "} [${on ? "x" : " "}] ${LANE_LINES[lane]}`}
            </Text>
          );
        })}
      </Box>
      <Box height={1} />
      <Text dimColor>Egma creates these connections only after you confirm them.</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
