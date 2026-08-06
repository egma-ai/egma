/**
 * The one secret a developer types into egma's terminal.
 *
 * Two things are true at once here and the screen has to hold both: the key is
 * needed, and the developer is entitled to know what happens to it before they
 * hand it over. So the sentence about where it goes is on screen at the moment
 * they paste, not in a document they would have to go and find.
 *
 * What is typed is drawn as dots. Not for looks: this screen is the one place
 * in the wizard where a shoulder, a screen share or a recording could take a
 * live credential, and a terminal keeps every frame it has drawn.
 *
 * The characters live in this component and nowhere else. They are handed
 * straight to the flow when Enter is pressed, so nothing a screen reads from
 * and nothing a check can snapshot ever holds them.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";

export type RetellKeyScreenProps = {
  readonly state: WizardState;
  /** The key as typed, or `null` when the developer has none to give. */
  readonly onAnswer: (key: string | null) => void;
};

/** What one typed character looks like. */
const DOT = "●";

/** Past this the row of dots says nothing more, so it stops growing. */
const MOST_DOTS = 40;

/**
 * A pasted chunk with nothing in it that is not part of a key.
 *
 * A terminal hands a paste over as text, and text off a clipboard can carry
 * control characters. None of them belongs in a credential, and one of them
 * drawn on a screen is an instruction rather than a character.
 */
function typeable(chunk: string): string {
  return chunk.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
}

export function RetellKeyScreen({ state, onAnswer }: RetellKeyScreenProps) {
  const [typed, setTyped] = useState("");
  const ask = state.keyAsk;

  const bindings: KeyBinding[] = [
    {
      match: "return",
      label: "enter",
      action: "connect",
      priority: 0,
      handler: () => onAnswer(typed.trim() === "" ? null : typed),
    },
    {
      match: "escape",
      label: "esc",
      action: "skip",
      priority: 1,
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    if (key.backspace || key.delete) {
      setTyped((held) => held.slice(0, -1));
      return;
    }

    // A key copied out of a password manager or a file comes with the newline
    // that ended the line, and a terminal hands the whole of it over in one
    // chunk. Everything before that break belongs to the key and the break
    // itself is Enter — so a paste that ends in a newline connects, instead of
    // sitting there with an invisible character on the end of it.
    const breakAt = input.search(/[\r\n]/u);
    if (breakAt > 0) {
      const whole = `${typed}${typeable(input.slice(0, breakAt))}`.trim();
      onAnswer(whole === "" ? null : whole);
      return;
    }

    if (dispatchKey(bindings, input, key)) return;
    // Control keys are not key characters, and a paste arrives as plain text.
    if (key.ctrl || key.meta) return;
    const chunk = typeable(input);
    if (chunk !== "") setTyped((held) => held + chunk);
  });

  const dots = DOT.repeat(Math.min(typed.length, MOST_DOTS));

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      {ask?.problem == null ? null : (
        <Box flexDirection="column">
          <Text>{ask.problem}</Text>
          <Box height={1} />
        </Box>
      )}
      <Text>{ask?.asking ?? ""}</Text>
      <Text dimColor>{ask?.custody ?? ""}</Text>
      <Box height={1} />
      <Text>{`  › ${dots}`}</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
