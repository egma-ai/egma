/**
 * The intro, and the one keystroke that is consent.
 *
 * It says what egma is about to do before it does any of it, including that the
 * developer's own coding agent will be driven and that every action it takes
 * will be shown. Consent is earned afterwards by showing everything, not by
 * asking again.
 *
 * It also names the egma this walk will use, and how to choose another. A bare
 * command in a repository that names no platform reaches egma's own, so which
 * egma this is stopped being something the developer chose and started being
 * something they have to be told — and told here, on the screen that takes the
 * keystroke, before that address has been asked anything at all.
 */

import { Box, Text, useInput } from "ink";

import { FACTS } from "../../../wizard/facts.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

/**
 * How to use a different egma, in the one way that selects one.
 *
 * `EGMA_TEST_DEFAULT_URL` is not a second way and never will be: it is a test
 * seam that stands in for the built-in address, not a way for a developer to
 * choose a platform.
 */
export const ANOTHER_PLATFORM =
  "For a different Egma instance, quit and run it again with --url <address>.";

/**
 * The same offer for a repository that has already committed a platform, where
 * the line above would be advice egma itself refuses.
 *
 * A bound repository pointed at another address is turned away, with every line
 * of the move under it — so telling somebody here to quit and re-run with a
 * flag sends them to a command that will not run. This is the screen that takes
 * the keystroke of consent, which makes it the worst place in the product to be
 * wrong about what happens next.
 */
export const BOUND_PLATFORM =
  "This repository names that Egma instance in egma/config.yaml. A different one is an edit to that file, not a flag on this command.";

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
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
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
      {state.platform === null ? null : (
        <>
          <Box height={1} />
          <Text>{`This uses ${state.platform.url}. Nothing has been sent to it yet.`}</Text>
          <Text dimColor>
            {state.platform.bound ? BOUND_PLATFORM : ANOTHER_PLATFORM}
          </Text>
        </>
      )}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
