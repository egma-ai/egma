/**
 * What the coding agent is doing, line by line, while it does it.
 *
 * egma approves everything the agent asks for, so this screen is the
 * developer's protection: nothing happens off-screen.
 */

import { Box, Text } from "ink";

import { ACTION_MARK } from "../../../wizard/status.ts";
import type { WizardState } from "../state.ts";

export type TaskScreenProps = { readonly state: WizardState };

/** Kept short so the newest work is always the thing being read. */
const VISIBLE_STATUS_LINES = 12;

export function TaskScreen({ state }: TaskScreenProps) {
  const drivenAgentName = state.drivenAgent?.name ?? "not named yet";
  const shown = state.statuses.slice(-VISIBLE_STATUS_LINES);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>{`Coding agent: ${drivenAgentName}`}</Text>
      <Text>
        {state.finished
          ? "Your coding agent has finished."
          : "Your coding agent is working."}
      </Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.length === 0 ? (
          <Text dimColor>Waiting for the first action.</Text>
        ) : (
          shown.map((line, index) => (
            <Text key={`${index}-${line}`} dimColor={!line.startsWith(ACTION_MARK)}>
              {line}
            </Text>
          ))
        )}
      </Box>
      {state.summary === "" ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text>{state.summary}</Text>
        </Box>
      )}
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
