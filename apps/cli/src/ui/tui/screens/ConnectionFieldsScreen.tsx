/** Required LiveKit provider fields, with every typed value kept in this component. */

import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import type {
  ConnectionFieldsAnswer,
  ConnectionFieldsAsk,
} from "../../wizard-ui.ts";
import { connectionFieldIssue } from "../../connection-field-validation.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type ConnectionFieldsScreenProps = {
  readonly ask: ConnectionFieldsAsk;
  readonly onAnswer: (answer: ConnectionFieldsAnswer | null) => void;
};

const DOT = "●";
const MOST_DOTS = 40;

function typeable(chunk: string): string {
  return chunk.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
}

export function ConnectionFieldsScreen({ ask, onAnswer }: ConnectionFieldsScreenProps) {
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const [typed, setTyped] = useState<readonly string[]>(() =>
    ask.fields.map((field) => field.defaultValue ?? ""),
  );
  const typedRef = useRef(typed);
  const [problem, setProblem] = useState<string | null>(null);

  const moveTo = (next: number): void => {
    if (ask.fields.length === 0) return;
    const wrapped = (next + ask.fields.length) % ask.fields.length;
    atRef.current = wrapped;
    setAt(wrapped);
    setProblem(null);
  };

  const replaceAt = (next: string): void => {
    const values = [...typedRef.current];
    values[atRef.current] = next;
    typedRef.current = values;
    setTyped(values);
    setProblem(null);
  };

  const submit = (): void => {
    if (atRef.current < ask.fields.length - 1) {
      moveTo(atRef.current + 1);
      return;
    }

    const values: Partial<Record<(typeof ask.fields)[number]["id"], string>> = {};
    for (const [index, field] of ask.fields.entries()) {
      const value = (typedRef.current[index] ?? "").trim();
      const issue = connectionFieldIssue(field, value);
      if (issue === "missing") {
        moveTo(index);
        setProblem(`${field.label} is required.`);
        return;
      }
      if (issue === "invalid-json") {
        moveTo(index);
        setProblem(`${field.label} must be one JSON object.`);
        return;
      }
      if (value !== "") values[field.id] = value;
    }
    onAnswer({ values });
  };

  const bindings: KeyBinding[] = [
    {
      match: "upArrow",
      label: "↑↓",
      action: "choose field",
      priority: 0,
      handler: () => moveTo(atRef.current - 1),
    },
    {
      match: "downArrow",
      label: "↑↓",
      action: "choose field",
      priority: 0,
      handler: () => moveTo(atRef.current + 1),
    },
    {
      match: "return",
      label: "enter",
      action: at === ask.fields.length - 1 ? "connect" : "next field",
      priority: 1,
      handler: submit,
    },
    {
      match: "escape",
      label: "esc",
      action: "stop",
      priority: 2,
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    if (key.backspace || key.delete) {
      replaceAt((typedRef.current[atRef.current] ?? "").slice(0, -1));
      return;
    }
    // A fast paste can deliver the value and Enter in one chunk. Keep the
    // printable part, then apply Enter to that updated value.
    const breakAt = input.search(/[\r\n]/u);
    if (breakAt >= 0) {
      const chunk = typeable(input.slice(0, breakAt));
      if (chunk !== "") replaceAt((typedRef.current[atRef.current] ?? "") + chunk);
      submit();
      return;
    }
    if (dispatchKey(bindings, input, key) || key.ctrl || key.meta) return;
    const chunk = typeable(input);
    if (chunk !== "") replaceAt((typedRef.current[atRef.current] ?? "") + chunk);
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>{ask.title}</Text>
      <Text dimColor>{ask.help}</Text>
      {ask.notice === undefined ? null : <Text>{ask.notice}</Text>}
      <Box height={1} />
      {ask.fields.map((field, index) => {
        const value = typed[index] ?? "";
        const shown =
          field.kind === "secret" ? DOT.repeat(Math.min(value.length, MOST_DOTS)) : value;
        return (
          <Box key={field.id} flexDirection="column" marginBottom={1}>
            <Text bold={index === at}>
              {`${index === at ? "›" : " "} ${field.label}${field.required ? " *" : " [optional]"}`}
            </Text>
            <Text>{`    ${shown}`}</Text>
            <Text dimColor>{field.help}</Text>
          </Box>
        );
      })}
      {problem === null ? null : <Text>{problem}</Text>}
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
