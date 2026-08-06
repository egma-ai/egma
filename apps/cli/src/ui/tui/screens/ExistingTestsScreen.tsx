/**
 * The one question the generate step asks.
 *
 * Most teams shipping a voice agent already have a list somewhere of things it
 * ought to handle — a spreadsheet, a document, a page of notes from the last
 * time something went wrong on a Friday. That list is the most grounded
 * material egma will ever be handed, and generating twelve tests over the top
 * of it without asking would throw it away.
 *
 * So it is asked once, and having none is a first-class answer with its own
 * key: most developers press it, and pressing it must cost nothing.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type ExistingTestsScreenProps = {
  /** The path the developer typed, or `null` when they have none to give. */
  readonly onAnswer: (path: string | null) => void;
};

export function ExistingTestsScreen({ onAnswer }: ExistingTestsScreenProps) {
  const [typed, setTyped] = useState("");

  const none = (): void => onAnswer(null);

  // `n` is the answer only while nothing has been typed. Once a path is being
  // written it is a letter like any other — half the paths in a repository have
  // one in them — so the key stops answering and the hint stops offering it.
  const bindings: KeyBinding[] = [
    {
      match: "return",
      label: "enter",
      action: "read it",
      priority: 0,
      handler: () => onAnswer(typed.trim() === "" ? null : typed.trim()),
    },
    typed === ""
      ? { match: ["n", "escape"], label: "n", action: "none", priority: 1, handler: none }
      : { match: "escape", label: "esc", action: "none", priority: 1, handler: none },
  ];

  useInput((input, key) => {
    if (dispatchKey(bindings, input, key)) return;
    if (key.backspace || key.delete) {
      setTyped((held) => held.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || input === "") return;
    setTyped((held) => held + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>
        Do you already have test cases or situations written down — a
        spreadsheet, a document, notes?
      </Text>
      <Box height={1} />
      <Text dimColor>
        Drop a path and egma turns them into test files before it writes any of
        its own. CSV and markdown both read. It must be inside this folder.
      </Text>
      <Box height={1} />
      <Text>{`  › ${typed}`}</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
