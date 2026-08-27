/**
 * The one question the wizard asks about itself: what is Egma here to do?
 *
 * It comes after discovery on purpose. By this point Egma has found the
 * developer's voice agent and knows which platform runs it, so the three
 * answers can name that agent rather than talk about voice agents in general —
 * and a developer who came to watch production traffic is not first walked
 * through half of a testing setup to find out there was another way.
 *
 * Three answers and no default key. Nothing here writes anything: the screen
 * answers the question and the flow takes the lane.
 */

import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { GOAL_ASK_LINE, GOAL_LINES, type GoalAsk } from "../../wizard-ui.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type GoalScreenProps = {
  readonly ask: GoalAsk;
  /** `testing`, `monitoring`, `both`, or `null` for no answer. */
  readonly onAnswer: (goal: string | null) => void;
  readonly onQuit: () => void;
};

export function GoalScreen({ ask, onAnswer, onQuit }: GoalScreenProps) {
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const moveTo = (next: number): void => {
    if (ask.goals.length === 0) return;
    atRef.current = next;
    setAt(next);
  };
  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose",
      priority: 0,
      handler: () => moveTo(atRef.current === 0 ? ask.goals.length - 1 : atRef.current - 1),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose",
      priority: 0,
      handler: () => moveTo((atRef.current + 1) % ask.goals.length),
    },
    {
      match: "return",
      label: "enter",
      action: "choose this one",
      priority: 1,
      handler: () => onAnswer(ask.goals[atRef.current] ?? null),
    },
    {
      match: ["q", "escape"],
      label: "q",
      action: "quit",
      priority: 2,
      handler: onQuit,
    },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  const named =
    ask.agentName === null
      ? `your ${ask.platformLabel} voice agent`
      : `${ask.agentName}, your ${ask.platformLabel} voice agent`;

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>{GOAL_ASK_LINE}</Text>
      <Text dimColor>{`Egma found ${named}.`}</Text>
      <Box height={1} />
      {ask.goals.map((goal, index) => (
        <Text key={goal} bold={index === at}>{`${index === at ? "›" : " "} ${GOAL_LINES[goal]}`}</Text>
      ))}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
