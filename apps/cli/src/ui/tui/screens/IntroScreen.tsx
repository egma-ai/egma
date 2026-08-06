/**
 * The intro, and the one keystroke that is consent.
 *
 * It says what egma is about to do before it does any of it, including that the
 * developer's own coding agent will be driven and that every action it takes
 * will be shown. Consent is earned afterwards by showing everything, not by
 * asking again.
 */

import { Box, Text, useInput } from "ink";

import { dispatchKey, hintsFor, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type IntroScreenProps = {
  readonly state: WizardState;
  readonly onBegin: () => void;
  readonly onQuit: () => void;
};

export function IntroScreen({ state, onBegin, onQuit }: IntroScreenProps) {
  const bindings: KeyBinding[] = [
    { match: "return", label: "enter", action: "begin", priority: 0, handler: onBegin },
    { match: "q", label: "q", action: "quit", priority: 1, handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  const agentName = state.agent?.name ?? "your coding agent";
  const file = state.taskFile ?? "one file";

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>This is the first check that egma can drive your own coding agent.</Text>
      <Box height={1} />
      <Text>
        {`egma will ask ${agentName} to read ${file} in this folder and say what it is.`}
      </Text>
      <Text>Nothing here is changed. Your code stays on this machine.</Text>
      <Box height={1} />
      <Text>Every action the agent takes appears below as it happens.</Text>
      <Box height={1} />
      <Text dimColor>
        {hintsFor(bindings)
          .map((hint) => `[${hint.label}] ${hint.action}`)
          .join("        ")}
      </Text>
    </Box>
  );
}
