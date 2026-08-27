/** Honest progress plus the live ACP activity while the coding agent writes. */

import { Box, Text } from "ink";

import type { GenerationProgress } from "../../../wizard/test-generation.ts";
import type { WizardState } from "../state.ts";
import { AgentActivity } from "./AgentActivity.tsx";

export type GeneratingScreenProps = {
  readonly progress: GenerationProgress;
  readonly state: WizardState;
};

export function GeneratingScreen({ progress, state }: GeneratingScreenProps) {
  const written = progress.tests.filter((test) => test.state === "written").length;
  const headline =
    progress.what === "converting"
      ? "Turning your existing cases into tests."
      : progress.what === "mocking"
        ? "Setting up mock tools for your voice agent."
        : "Writing tests for your voice agent.";

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text bold>{headline}</Text>
      {progress.total > 0 ? <Text>{`Progress: ${written}/${progress.total}`}</Text> : null}
      <Text>This may take a couple of minutes.</Text>
      <Box height={1} />
      <Text>{`Coding agent: ${state.drivenAgent?.name ?? "starting"}`}</Text>
      <AgentActivity state={state} />
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
