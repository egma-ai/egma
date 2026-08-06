/**
 * The one question the find-the-agent step asks.
 *
 * Plenty of teams keep the words their voice agent runs on in a folder or a
 * repository of their own, so a folder with nothing in it is not proof that the
 * team has nothing. egma asks once, looks where it is pointed, and does not ask
 * again — a wizard that keeps asking the same question is a wizard that has
 * stopped believing the answer.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type PromptsPointerScreenProps = {
  /** The path the developer typed, or `null` when they have none to give. */
  readonly onAnswer: (pointer: string | null) => void;
};

export function PromptsPointerScreen({ onAnswer }: PromptsPointerScreenProps) {
  const [typed, setTyped] = useState("");

  const bindings: KeyBinding[] = [
    {
      match: "return",
      label: "enter",
      action: "look there",
      priority: 0,
      handler: () => onAnswer(typed.trim() === "" ? null : typed.trim()),
    },
    {
      match: "escape",
      label: "esc",
      action: "nowhere else",
      priority: 1,
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    if (dispatchKey(bindings, input, key)) return;
    if (key.backspace || key.delete) {
      setTyped((held) => held.slice(0, -1));
      return;
    }
    // Control keys are not path characters, and a paste arrives as plain text.
    if (key.ctrl || key.meta || input === "") return;
    setTyped((held) => held + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>Nothing in this folder looks like a voice agent.</Text>
      <Box height={1} />
      <Text>
        Teams often keep their prompts somewhere else. If yours are in another
        folder, type the path to it and egma will look there.
      </Text>
      <Box height={1} />
      <Text>{`  › ${typed}`}</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
