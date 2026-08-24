/**
 * The one keystroke before Egma writes a live credential into the working tree.
 *
 * A gate and not a question, for the same reason the intro is one: what is
 * being given is agreement, and a developer who does not want a key in their
 * `.env` closes the wizard rather than answering. Nothing is lost by saying no
 * — the same two lines are printed afterwards either way, which is what a
 * deployment needs anyway.
 *
 * The sentence above the key is the whole of what Egma promises about the
 * write: which file, which two variables, that the key is minted for this
 * project alone, and that Egma refuses outright unless Git already ignores the
 * file.
 */

import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type EnvConsentScreenProps = {
  /** What Egma is about to write, in its own words. */
  readonly line: string;
  readonly onAgree: () => void;
  readonly onQuit: () => void;
};

export function EnvConsentScreen({ line, onAgree, onQuit }: EnvConsentScreenProps) {
  const bindings: KeyBinding[] = [
    { match: "return", label: "enter", action: "write it", handler: onAgree },
    { match: "q", label: "q", action: "close Egma", handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>{line}</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
