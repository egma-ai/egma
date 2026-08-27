/** Real terminal text fields for LiveKit values, kept only in this component. */

import { useLayoutEffect, useRef, useState } from "react";
import {
  Box,
  measureElement,
  Text,
  useCursor,
  useInput,
  type DOMElement,
} from "ink";

import type {
  ConnectionFieldsAnswer,
  ConnectionFieldsAsk,
} from "../../wizard-ui.ts";
import { connectionFieldIssue } from "../../connection-field-validation.ts";
import { FAILURE_MARK } from "../../../wizard/status.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import { isMouseInput, useMousePress, type MousePress } from "../mouse.ts";

export type ConnectionFieldsScreenProps = {
  readonly ask: ConnectionFieldsAsk;
  readonly onAnswer: (answer: ConnectionFieldsAnswer | null) => void;
};

const DOT = "●";

function typeable(chunk: string): string {
  return chunk.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
}

function placeholderFor(field: ConnectionFieldsAsk["fields"][number]): string {
  if (field.id.endsWith(":url")) return "wss://your-project.livekit.cloud";
  return `Enter LiveKit ${field.label}`;
}

type CursorAnchor = { readonly x: number; readonly y: number };

export function ConnectionFieldsScreen({ ask, onAnswer }: ConnectionFieldsScreenProps) {
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const [typed, setTyped] = useState<readonly string[]>(() =>
    ask.fields.map((field) => field.defaultValue ?? ""),
  );
  const typedRef = useRef(typed);
  const [carets, setCarets] = useState<readonly number[]>(() =>
    typedRef.current.map((value) => value.length),
  );
  const caretsRef = useRef(carets);
  const replaceDefaultRef = useRef(ask.fields.map((field) => field.defaultValue !== undefined));
  const fieldRefs = useRef<Array<DOMElement | null>>([]);
  const [cursorAnchor, setCursorAnchor] = useState<CursorAnchor | null>(null);
  const { setCursorPosition } = useCursor();
  const [problem, setProblem] = useState<string | null>(null);

  const moveTo = (next: number): void => {
    if (ask.fields.length === 0) return;
    const wrapped = (next + ask.fields.length) % ask.fields.length;
    atRef.current = wrapped;
    setAt(wrapped);
    setProblem(null);
  };

  const setCaretAt = (next: number): void => {
    const held = [...caretsRef.current];
    const value = typedRef.current[atRef.current] ?? "";
    held[atRef.current] = Math.min(Math.max(next, 0), value.length);
    caretsRef.current = held;
    setCarets(held);
  };

  const replaceAt = (next: string, caret: number): void => {
    const values = [...typedRef.current];
    values[atRef.current] = next;
    typedRef.current = values;
    setTyped(values);
    const held = [...caretsRef.current];
    held[atRef.current] = Math.min(Math.max(caret, 0), next.length);
    caretsRef.current = held;
    setCarets(held);
    setProblem(null);
  };

  const insert = (chunk: string): void => {
    const index = atRef.current;
    const value = typedRef.current[index] ?? "";
    if (replaceDefaultRef.current[index] === true) {
      replaceDefaultRef.current[index] = false;
      replaceAt(chunk, chunk.length);
      return;
    }
    const caret = caretsRef.current[index] ?? value.length;
    replaceAt(`${value.slice(0, caret)}${chunk}${value.slice(caret)}`, caret + chunk.length);
  };

  const backspace = (): void => {
    const index = atRef.current;
    replaceDefaultRef.current[index] = false;
    const value = typedRef.current[index] ?? "";
    const caret = caretsRef.current[index] ?? value.length;
    if (caret === 0) return;
    replaceAt(`${value.slice(0, caret - 1)}${value.slice(caret)}`, caret - 1);
  };

  const deleteAtCaret = (): void => {
    const index = atRef.current;
    replaceDefaultRef.current[index] = false;
    const value = typedRef.current[index] ?? "";
    const caret = caretsRef.current[index] ?? value.length;
    if (caret >= value.length) return;
    replaceAt(`${value.slice(0, caret)}${value.slice(caret + 1)}`, caret);
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
      match: "tab",
      label: "tab",
      action: "next field",
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
    if (isMouseInput(input)) return;
    if (key.backspace) {
      backspace();
      return;
    }
    if (key.delete) {
      deleteAtCaret();
      return;
    }
    if (key.leftArrow) {
      replaceDefaultRef.current[atRef.current] = false;
      setCaretAt((caretsRef.current[atRef.current] ?? 0) - 1);
      return;
    }
    if (key.rightArrow) {
      replaceDefaultRef.current[atRef.current] = false;
      setCaretAt((caretsRef.current[atRef.current] ?? 0) + 1);
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      replaceDefaultRef.current[atRef.current] = false;
      setCaretAt(0);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      replaceDefaultRef.current[atRef.current] = false;
      setCaretAt((typedRef.current[atRef.current] ?? "").length);
      return;
    }
    // A fast paste can deliver the value and Enter in one chunk. Keep the
    // printable part, then apply Enter to that updated value.
    const breakAt = input.search(/[\r\n]/u);
    if (breakAt >= 0) {
      const chunk = typeable(input.slice(0, breakAt));
      if (chunk !== "") insert(chunk);
      submit();
      return;
    }
    if (dispatchKey(bindings, input, key) || key.ctrl || key.meta) return;
    const chunk = typeable(input);
    if (chunk !== "") insert(chunk);
  });

  const focusClickedField = (press: MousePress): void => {
    for (const [index, ref] of fieldRefs.current.entries()) {
      if (ref === null || ref === undefined) continue;
      const box = measureElement(ref);
      const inside =
        press.x >= box.x &&
        press.x < box.x + box.width &&
        press.y >= box.y &&
        press.y < box.y + box.height;
      if (!inside) continue;
      replaceDefaultRef.current[index] = false;
      moveTo(index);
      return;
    }
  };
  useMousePress(focusClickedField);

  useLayoutEffect(() => {
    const field = fieldRefs.current[at];
    if (field === null || field === undefined) return;
    const box = measureElement(field);
    const innerWidth = Math.max(1, box.width - 4);
    const caret = carets[at] ?? 0;
    const next = {
      x: box.x + 2 + (caret % innerWidth),
      y: box.y + 1 + Math.floor(caret / innerWidth),
    };
    setCursorAnchor((held) =>
      held?.x === next.x && held.y === next.y ? held : next,
    );
  }, [at, carets, typed]);

  setCursorPosition(cursorAnchor ?? undefined);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>{ask.title}</Text>
      <Text dimColor>{ask.help}</Text>
      {ask.notice === undefined ? null : <Text>{ask.notice}</Text>}
      <Text>Get these values from your LiveKit project settings.</Text>
      <Box height={1} />
      {ask.fields.map((field, index) => {
        const value = typed[index] ?? "";
        const shown = field.kind === "secret" ? DOT.repeat(value.length) : value;
        const placeholder = placeholderFor(field);
        return (
          <Box key={field.id} flexDirection="column" marginBottom={1}>
            <Text bold={index === at}>
              {`${index === at ? "›" : " "} ${field.label}${field.required ? " *" : " [optional]"}`}
            </Text>
            <Box
              ref={(element) => {
                fieldRefs.current[index] = element;
              }}
              borderStyle="single"
              paddingX={1}
              width="100%"
            >
              {shown === "" ? <Text dimColor>{placeholder}</Text> : <Text>{shown}</Text>}
            </Box>
          </Box>
        );
      })}
      {problem === null ? null : <Text>{`${FAILURE_MARK} ${problem}`}</Text>}
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
