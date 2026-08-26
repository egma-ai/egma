/**
 * The one question the generate step asks.
 *
 * Most teams shipping a voice agent already have a list somewhere of things it
 * ought to handle — a spreadsheet, a document, a page of notes from the last
 * time something went wrong on a Friday. That list is the most grounded
 * material egma will ever be handed, and generating its own tests over the top
 * of it without asking would throw it away.
 *
 * So it is asked once, and having none is a first-class answer with its own
 * key: most developers press it, and pressing it must cost nothing.
 */

import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type ExistingTestsScreenProps = {
  /** The path the developer typed, or `null` when they have none to give. */
  readonly onAnswer: (path: string | null) => void;
};

export function ExistingTestsScreen({ onAnswer }: ExistingTestsScreenProps) {
  const [choosing, setChoosing] = useState(true);
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const [typed, setTyped] = useState("");
  const typedRef = useRef("");
  const [problem, setProblem] = useState<string | null>(null);

  const moveTo = (next: number): void => {
    const wrapped = (next + 2) % 2;
    atRef.current = wrapped;
    setAt(wrapped);
  };

  const replaceTyped = (next: string): void => {
    typedRef.current = next;
    setTyped(next);
    setProblem(null);
  };

  const submitPath = (): void => {
    const path = typedRef.current.trim();
    if (path === "") {
      setProblem("Enter the path to your test cases before continuing.");
      return;
    }
    onAnswer(path);
  };

  const bindings: KeyBinding[] = choosing
    ? [
        {
          match: "upArrow",
          label: "↑↓",
          action: "choose",
          priority: 0,
          handler: () => moveTo(atRef.current - 1),
        },
        {
          match: "downArrow",
          label: "↑↓",
          action: "choose",
          priority: 0,
          handler: () => moveTo(atRef.current + 1),
        },
        {
          match: "return",
          label: "enter",
          action: "choose this one",
          priority: 1,
          handler: () => {
            if (atRef.current === 0) {
              onAnswer(null);
              return;
            }
            setChoosing(false);
          },
        },
      ]
    : [
        {
          match: "return",
          label: "enter",
          action: "read it",
          priority: 0,
          handler: submitPath,
        },
        {
          match: "escape",
          label: "esc",
          action: "back",
          priority: 1,
          handler: () => {
            setProblem(null);
            setChoosing(true);
          },
        },
      ];

  useInput((input, key) => {
    if (dispatchKey(bindings, input, key)) return;
    if (choosing) return;
    if (key.backspace || key.delete) {
      replaceTyped(typedRef.current.slice(0, -1));
      return;
    }
    const breakAt = input.search(/[\r\n]/u);
    if (breakAt >= 0) {
      const chunk = input.slice(0, breakAt).replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
      if (chunk !== "") replaceTyped(typedRef.current + chunk);
      submitPath();
      return;
    }
    if (key.ctrl || key.meta || input === "") return;
    replaceTyped(typedRef.current + input.replaceAll(/[\p{Cc}\p{Cf}]/gu, ""));
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        Do you already have test cases or situations written down — a
        spreadsheet, a document, notes?
      </Text>
      <Box height={1} />
      <Text dimColor>
        If you choose Yes, Egma reads a CSV or markdown file inside this folder and turns it into
        test files before it writes its own.
      </Text>
      <Box height={1} />
      <Text bold={choosing && at === 0}>{`${choosing && at === 0 ? "›" : " "} No`}</Text>
      <Text bold={choosing && at === 1}>{`${choosing && at === 1 ? "›" : " "} Yes`}</Text>
      {choosing ? null : (
        <>
          <Box height={1} />
          <Text>Path to existing tests *</Text>
          <Text>{`  › ${typed}`}</Text>
          {problem === null ? null : <Text>{problem}</Text>}
        </>
      )}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
