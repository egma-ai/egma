/**
 * The one keystroke between generated files and tests on egma.
 *
 * It is a pause to scan and not a review loop. The files are already in the
 * repository, so deep reading happens there, on code, in a pull request — what
 * this screen owes the developer is the chance to see what egma made before
 * egma acts on it, and a way into any one of them if a name looks wrong.
 *
 * Three keys, and all three are endings the developer chose: run them, open one
 * first, or close the wizard and keep the files. Only the first is the flow's
 * business. `e` never reaches the flow at all — the screen hands the terminal to
 * the editor and takes it back, and the flow is still parked exactly where it
 * was, which is what the gate pattern is for.
 */

import { Box, Text, useInput } from "ink";

import type { TestGate } from "../../../wizard/gate.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type GateScreenProps = {
  readonly gate: TestGate;
  /** Which row the keys act on. */
  readonly at: number;
  /** What went wrong last time `e` was pressed, or `null`. */
  readonly problem: string | null;
  readonly onMove: (by: number) => void;
  readonly onRun: () => void;
  readonly onEdit: (file: string) => void;
  readonly onQuit: () => void;
};

/** How many rows are on screen at once. The rest are browsed to. */
const VISIBLE_ROWS = 3;

/** The widest name, so the persona column starts in the same place on every row. */
function columnWidth(names: readonly string[]): number {
  return names.reduce((widest, name) => Math.max(widest, name.length), 0);
}

export function GateScreen({
  gate,
  at,
  problem,
  onMove,
  onRun,
  onEdit,
  onQuit,
}: GateScreenProps) {
  const on = Math.min(Math.max(at, 0), gate.rows.length - 1);
  const selected = gate.rows[on];

  const bindings: KeyBinding[] = [
    { match: "upArrow", label: "↑↓", action: "browse", hidden: true, handler: () => onMove(-1) },
    { match: "downArrow", label: "↑↓", action: "browse", hidden: true, handler: () => onMove(1) },
    { match: "return", label: "enter", action: "run", priority: 0, handler: onRun },
    {
      match: "e",
      label: "e",
      action: "edit first",
      priority: 1,
      handler: () => {
        if (selected !== undefined) onEdit(selected.file);
      },
    },
    { match: "q", label: "q", action: "quit", priority: 2, handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  const width = columnWidth(gate.rows.map((row) => row.name));

  // The window follows the selection, so browsing past the bottom row scrolls
  // rather than losing the mark.
  const from = Math.max(0, Math.min(on - VISIBLE_ROWS + 1, gate.rows.length - VISIBLE_ROWS));
  const shown = gate.rows.slice(from, from + VISIBLE_ROWS);
  const rest = gate.rows.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>{`${gate.rows.length} ${gate.rows.length === 1 ? "test" : "tests"} generated · suite "${gate.suite}"`}</Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((row, index) => {
          const isSelected = from + index === on;
          return (
            <Text key={row.shown} inverse={isSelected}>
              {`${isSelected ? "›" : " "} ${row.name.padEnd(width)}  ${row.persona}`}
            </Text>
          );
        })}
        {rest > 0 ? (
          <Text dimColor>{`  … ${rest} more (↑↓ browse · e opens in $EDITOR)`}</Text>
        ) : null}
      </Box>
      {gate.heldBack.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {gate.heldBack.map((held) => (
            <Text key={held.shown}>{`✗ ${held.shown} — ${held.reason}`}</Text>
          ))}
        </Box>
      ) : null}
      {problem === null ? null : (
        <Box marginTop={1}>
          <Text>{problem}</Text>
        </Box>
      )}
      <Box height={1} />
      <Text>
        {`Run these against ${gate.agentName} over ${gate.connectionName} (${gate.modality})?`}
      </Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
