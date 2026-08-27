/**
 * What the coding agent is doing, line by line, while it does it.
 *
 * egma approves everything the agent asks for, so this screen is the
 * developer's protection: nothing happens off-screen.
 */

import { Box, Text } from "ink";

import type { WizardState } from "../state.ts";
import { AgentActivity } from "./AgentActivity.tsx";

export type TaskScreenProps = { readonly state: WizardState };

export function TaskScreen({ state }: TaskScreenProps) {
  const drivenAgentName = state.drivenAgent?.name ?? "not named yet";

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>Starting your coding agent and setting up egma</Text>
      <Text>{`Coding agent: ${drivenAgentName}`}</Text>
      <Text>This may take a couple of minutes.</Text>
      <Box height={1} />
      <AgentActivity state={state} visibleLines={12} />
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
