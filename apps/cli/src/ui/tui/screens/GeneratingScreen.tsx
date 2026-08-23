/**
 * The files arriving, one at a time, while they arrive — and the words egma
 * uses, taught beside them.
 *
 * Writing a suite takes a coding agent a couple of minutes, which is a long
 * time to look at a spinner. So the wait is the work: every test is on screen
 * from the moment the agent says it means to write one, and it changes state
 * where the developer can see it. By the time the list stops moving they have
 * read every name in it, which is what makes the one keystroke after this a
 * decision rather than a shrug.
 *
 * The left pane turns the rest of that time into the one thing the developer
 * still needs and nobody has told them: what egma means by a test, a run, a
 * simulation, a metric and a grader. It is drawn from a deck of plain cards and
 * it turns on a timer of its own. **Nothing waits on it.** The flow never reads
 * it, never awaits it and never learns whether it turned, so a suite that is
 * written before the first card changes is written exactly as it would have
 * been with no pane at all.
 */

import { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";

import { cardAt, CARD_WIDTH } from "../../../wizard/teaching.ts";
import type { GenerationProgress, WritingState } from "../../../wizard/test-generation.ts";

export type GeneratingScreenProps = { readonly progress: GenerationProgress };

/** How many rows are on screen at once, newest work always among them. */
const VISIBLE_ROWS = 14;

/**
 * How long one card stays up.
 *
 * Long enough to read twice without hurrying, and long enough that a fast run
 * finishes on the first card — which is the shape this has to have, because the
 * pane exists to fill a wait and must never be a reason for one.
 */
export const TEACHING_ROTATE_MS = 8_000;

/** The narrowest terminal that holds both panes with either still readable. */
const BOTH_PANES_NEED = 76;

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

/**
 * The card that is up, and the timer that changes it.
 *
 * The timer lives here and reaches nothing outside this component. A screen
 * that is never drawn never starts it, and a run that ends before it fires ends
 * exactly as it would have without it.
 */
function LearnPane() {
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTurn((held) => held + 1), TEACHING_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);

  const card = cardAt(turn);

  return (
    <Box flexDirection="column" width={CARD_WIDTH} marginRight={3}>
      <Text bold>{card.heading}</Text>
      <Box height={1} />
      {card.lines.map((line, index) => (
        <Text key={`${index}-${line}`} dimColor>
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

export function GeneratingScreen({ progress }: GeneratingScreenProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
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
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        {progress.what === "converting"
          ? "Turning what you already had into test files."
          : progress.what === "mocking"
            ? "Writing what Egma answers your agent's tools with."
            : "Writing tests for your voice agent."}
      </Text>
      <Box height={1} />
      <Box flexDirection="row">
        {/* A terminal too narrow for both keeps the one that is the work. */}
        {columns >= BOTH_PANES_NEED ? <LearnPane /> : null}
        <Box flexDirection="column" flexGrow={1}>
          {shown.length === 0 ? (
            <Text dimColor>Waiting for the first file.</Text>
          ) : (
            shown.map((test) => (
              <Text key={test.name} dimColor={test.state === "queued"}>
                {`${MARK[test.state]} ${test.name.padEnd(width)}  ${SAID[test.state]}`.trimEnd()}
              </Text>
            ))
          )}
          <Box height={1} />
          <Text dimColor>{`Progress: ${written}/${progress.total}`}</Text>
        </Box>
      </Box>
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
