/** A short receipt for the tests and mock tools written before the first run. */

import { Box, Text, useInput } from "ink";

import type { TestGate } from "../../../wizard/gate.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type GateScreenProps = {
  readonly gate: TestGate;
  readonly onRun: () => void;
  readonly onQuit: () => void;
};

export function GateScreen({ gate, onRun, onQuit }: GateScreenProps) {
  const bindings: KeyBinding[] = [
    {
      match: "return",
      label: "enter",
      action: "run",
      priority: 0,
      handler: onRun,
      hidden: true,
    },
    { match: "q", label: "q", action: "quit", priority: 1, handler: onQuit },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>{`${gate.rows.length} ${gate.rows.length === 1 ? "test" : "tests"}`}</Text>
      <Box flexDirection="column">
        {gate.rows.map((row) => (
          <Text key={row.shown}>{`  ${row.name}`}</Text>
        ))}
      </Box>
      {gate.heldBack.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{`${gate.heldBack.length} ${gate.heldBack.length === 1 ? "test is" : "tests are"} not ready`}</Text>
          {gate.heldBack.map((held) => (
            <Text key={held.shown}>{`  ${held.shown} — ${held.reason}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box height={1} />
      <Text bold>
        {`${gate.mocks.length} ${gate.mocks.length === 1 ? "mock tool" : "mock tools"} written`}
      </Text>
      {gate.mocks.map((mock) => (
        <Text key={mock.tool}>{`  ${mock.tool}`}</Text>
      ))}
      <Box height={1} />
      <Text>Press Enter to run.</Text>
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
