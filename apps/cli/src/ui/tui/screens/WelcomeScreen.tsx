/** The first screen: what Egma does and the authorization step that comes next. */

import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type WelcomeScreenProps = {
  readonly onContinue: () => void;
  readonly onQuit: () => void;
};

export function WelcomeScreen({ onContinue, onQuit }: WelcomeScreenProps) {
  const bindings: KeyBinding[] = [
    {
      match: "return",
      label: "enter",
      action: "authenticate",
      priority: 0,
      handler: onContinue,
      hidden: true,
    },
    { match: "q", label: "q", action: "quit", priority: 1, handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>
        Welcome to egma, the platform to test, monitor, and self-improve your voice agents.
      </Text>
      <Box height={1} />
      <Text>
        Through this wizard we will set up your egma in your repo for monitoring and/or simulations.
      </Text>
      <Box height={1} />
      <Text>&gt; Next step.</Text>
      <Text>- Press Enter to authenticate the CLI with your egma account.</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
