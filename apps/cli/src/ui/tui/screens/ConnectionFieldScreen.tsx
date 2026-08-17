/** A platform-described connection field. The typed value stays in this component. */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { ConnectionAsk } from "../../wizard-ui.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type ConnectionFieldScreenProps = {
  readonly ask: ConnectionAsk;
  readonly onAnswer: (answer: string | null) => void;
};

const DOT = "●";
const MOST_DOTS = 40;

function typeable(chunk: string): string {
  return chunk.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
}

export function ConnectionFieldScreen({ ask, onAnswer }: ConnectionFieldScreenProps) {
  const choices = ask.choices ?? [];
  const [typed, setTyped] = useState(ask.defaultValue ?? "");
  const [replaceDefault, setReplaceDefault] = useState(ask.defaultValue !== undefined);
  const defaultChoice = choices.findIndex((choice) => choice.value === ask.defaultValue);
  const [at, setAt] = useState(defaultChoice < 0 ? 0 : defaultChoice);

  const submit = () => {
    if (ask.kind === "choice") {
      onAnswer(choices[at]?.value ?? null);
      return;
    }
    const answer = typed.trim();
    onAnswer(answer === "" ? null : answer);
  };

  const bindings: KeyBinding[] = [
    { match: "return", label: "enter", action: "continue", priority: 0, handler: submit },
    { match: "escape", label: "esc", action: "stop", priority: 2, handler: () => onAnswer(null) },
  ];
  if (ask.kind === "choice") {
    bindings.splice(1, 0, {
      match: "arrows",
      label: "↑/↓",
      action: "choose",
      priority: 1,
      handler: () => undefined,
    });
  }

  useInput((input, key) => {
    if (ask.kind === "choice") {
      if (key.upArrow || input === "k") {
        setAt((held) => Math.max(held - 1, 0));
        return;
      }
      if (key.downArrow || input === "j") {
        setAt((held) => Math.min(held + 1, Math.max(choices.length - 1, 0)));
        return;
      }
      dispatchKey(bindings, input, key);
      return;
    }

    if (key.backspace || key.delete) {
      setReplaceDefault(false);
      setTyped((held) => held.slice(0, -1));
      return;
    }
    const breakAt = input.search(/[\r\n]/u);
    if (breakAt >= 0) {
      const whole = `${typed}${typeable(input.slice(0, breakAt))}`.trim();
      onAnswer(whole === "" ? null : whole);
      return;
    }
    if (dispatchKey(bindings, input, key) || key.ctrl || key.meta) return;
    const chunk = typeable(input);
    if (chunk !== "") {
      setTyped((held) => (replaceDefault ? chunk : held + chunk));
      setReplaceDefault(false);
    }
  });

  const shown =
    ask.kind === "secret" ? DOT.repeat(Math.min(typed.length, MOST_DOTS)) : typed;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      {ask.problem == null ? null : <Text>{ask.problem}</Text>}
      <Text>{`${ask.label}${ask.required ? "" : " (optional)"}`}</Text>
      <Text dimColor>{ask.help}</Text>
      {ask.custody === undefined ? null : <Text dimColor>{ask.custody}</Text>}
      <Box height={1} />
      {ask.kind === "choice" ? (
        <Box flexDirection="column">
          {choices.map((choice, index) => (
            <Text key={choice.value}>
              {`${index === at ? "›" : " "} ${choice.label}`}
            </Text>
          ))}
        </Box>
      ) : (
        <Text>{`  › ${shown}`}</Text>
      )}
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
