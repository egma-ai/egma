/**
 * The intro, and the one keystroke that is consent.
 *
 * It says what egma is about to do before it does any of it, including that the
 * developer's own coding agent will be driven and that every action it takes
 * will be shown. Consent is earned afterwards by showing everything, not by
 * asking again.
 *
 * It also names the egma this CLI is already signed in to.
 */

import { Box, Text, useInput } from "ink";

import { FACTS } from "../../../wizard/facts.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
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

  const drivenAgentName = state.drivenAgent?.name ?? "your own coding agent";

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>Egma is about to find your voice agent.</Text>
      <Box height={1} />
      <Text>{`It reads this folder with ${drivenAgentName}, here on this machine, and reports:`}</Text>
      <Box height={1} />
      {/* The facts themselves are FACTS in wizard/facts.ts, so this promise
          cannot fall behind what the step actually brings back. */}
      {FACTS.map((fact) => (
        <Text key={fact.name}> {fact.phrase}</Text>
      ))}
      <Box height={1} />
      <Text>Egma tells it to change nothing. Your code stays on this machine.</Text>
      <Box height={1} />
      <Text>Every action your coding agent takes appears below as it happens.</Text>
      <Box height={1} />
      {state.platform === null ? null : (
        <>
          <Box height={1} />
          <Text>{`This CLI is signed in to ${state.platform.url}.`}</Text>
        </>
      )}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
