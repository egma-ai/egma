/** The first screen: what the wizard is and why it asks for a coding agent. */

import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type WelcomeScreenProps = {
  readonly onContinue: () => void;
  readonly onQuit: () => void;
};

export function WelcomeScreen({ onContinue, onQuit }: WelcomeScreenProps) {
  const bindings: KeyBinding[] = [
    { match: "return", label: "enter", action: "continue", priority: 0, handler: onContinue },
    { match: "q", label: "q", action: "quit", priority: 1, handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Welcome to Egma</Text>
      <Box height={1} />
      <Text>This wizard uses a coding agent on this machine to set up Egma for your voice agent.</Text>
      <Text>Next, sign in and authorize this CLI. Egma looks for a coding agent after that.</Text>
      <Text>If you do not have an Egma account, you can create one in the browser.</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
