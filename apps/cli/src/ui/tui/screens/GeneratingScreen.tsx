/**
 * The files arriving, one at a time, while they arrive.
 *
 * Writing a suite takes a coding agent a couple of minutes, which is a long
 * time to look at a spinner. So the wait is the work: every test is on screen
 * from the moment the agent says it means to write one, and it changes state
 * where the developer can see it. By the time the list stops moving they have
 * read every name in it, which is what makes the one keystroke after this a
 * decision rather than a shrug.
 */

import { Box, Text } from "ink";

import type { GenerationProgress, WritingState } from "../../../wizard/test-generation.ts";

export type GeneratingScreenProps = { readonly progress: GenerationProgress };

/** How many rows are on screen at once, newest work always among them. */
const VISIBLE_ROWS = 14;

const MARK: Readonly<Record<WritingState, string>> = {
  written: "◼",
  writing: "▶",
  queued: "◻",
};

const SAID: Readonly<Record<WritingState, string>> = {
  written: "written",
  writing: "writing…",
  queued: "",
};

/** The widest name, so the second column starts in the same place on every row. */
function columnWidth(names: readonly string[]): number {
  return names.reduce((widest, name) => Math.max(widest, name.length), 0);
}

export function GeneratingScreen({ progress }: GeneratingScreenProps) {
  const written = progress.tests.filter((test) => test.state === "written").length;
  const width = columnWidth(progress.tests.map((test) => test.name));

  // The window follows the work: whatever is being written now stays on
  // screen, and rows already done scroll off the top rather than pushing the
  // live one out of sight.
  const writing = progress.tests.findIndex((test) => test.state === "writing");
  const throughTo = writing === -1 ? progress.tests.length : writing + 1;
  const from = Math.max(0, throughTo - VISIBLE_ROWS);
  const shown = progress.tests.slice(from, from + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>
        {progress.what === "converting"
          ? "Turning what you already had into test files."
          : "Writing tests for your voice agent."}
      </Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.length === 0 ? (
          <Text dimColor>Waiting for the first file.</Text>
        ) : (
          shown.map((test) => (
            <Text key={test.name} dimColor={test.state === "queued"}>
              {`${MARK[test.state]} ${test.name.padEnd(width)}  ${SAID[test.state]}`.trimEnd()}
            </Text>
          ))
        )}
      </Box>
      <Box height={1} />
      <Text dimColor>{`Progress: ${written}/${progress.total}`}</Text>
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
