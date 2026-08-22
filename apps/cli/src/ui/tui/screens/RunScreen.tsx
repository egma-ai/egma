/**
 * The run, one line per simulation, moving.
 *
 * This is the payoff, and it is the only screen in the walk whose job is to be
 * watched rather than answered. A developer who has spent nine minutes being
 * told what egma is about to do now sees it happen: twelve lines, each moving
 * through execution and then trace-level grading.
 *
 * **The first result is marked.** It is the first completed trace whose whole
 * grading work is terminal. A low grade is still a completed result. A grader
 * error is an operational error, not a quality verdict.
 *
 * **Nothing here waits for the suite.** The wizard leaves as soon as the first
 * first result is ready and the developer has answered the last question. The run
 * is on the platform; closing a terminal has never stopped one.
 */

import { Box, Text } from "ink";

import type { RunView, SimulationRow } from "../../../run/view.ts";
import type { GradingState, SimulationStatus } from "../../../platform/runs.ts";
import { isTerminalGrading } from "../../../run/follow.ts";
import {
  assertionBehavior,
  assertionLabel,
  graderLabel,
  scoreText,
} from "../../../run/lines.ts";

export type RunScreenProps = { readonly run: RunView };

/** How many rows are on screen at once, the live ones always among them. */
const VISIBLE_ROWS = 12;

/** The mark in front of a simulation that has not ended yet. */
const RUNNING_MARK = "▶";
/** The mark in front of one that has. */
const ENDED_MARK = "◼";
/** The mark in front of one that has not started. */
const QUEUED_MARK = "◻";

const STATUS_SAID: Readonly<Record<SimulationStatus, string>> = {
  queued: "queued",
  claimed: "dialing…",
  running: "in progress",
  completed: "done",
  failed: "did not run",
  canceled: "stopped",
};

const GRADING_SAID: Readonly<Record<GradingState, string>> = {
  not_requested: "not graded",
  pending: "waiting to grade",
  running: "grading…",
  complete: "grading complete",
  error: "grading error",
};

function markFor(row: SimulationRow): string {
  if (
    row.status === "failed" ||
    row.status === "canceled" ||
    isTerminalGrading(row.gradingState)
  ) {
    return ENDED_MARK;
  }
  return row.status === "queued" ? QUEUED_MARK : RUNNING_MARK;
}

/** The right-hand column: execution first, then grading for completed traces. */
function saidFor(row: SimulationRow): string {
  if (row.status === "completed") {
    return row.gradingState === null
      ? "waiting to grade"
      : GRADING_SAID[row.gradingState];
  }
  return STATUS_SAID[row.status];
}

/** The widest name, so the second column starts in the same place on every row. */
function columnWidth(names: readonly string[]): number {
  return names.reduce((widest, name) => Math.max(widest, name.length), 0);
}

export function GradeResult({ row }: { readonly row: SimulationRow }) {
  const projection = row.gradeProjection;
  if (
    projection === null ||
    (projection.combinedScore === null && projection.grades.length === 0)
  ) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {projection.combinedScore === null
          ? "Combined score unavailable"
          : `Combined score ${scoreText(projection.combinedScore)}`}
      </Text>
      {projection.grades.map((grade) => (
        <Box key={grade.projectGraderId} flexDirection="column">
          <Text>
            {`${graderLabel(grade.graderName)}  ·  score ${scoreText(grade.score)}  ·  pass threshold ${scoreText(grade.passThreshold)}  ·  ${grade.result}`}
          </Text>
          <Text dimColor>{`Graded ${grade.gradedAt}`}</Text>
          {grade.details.rationale === undefined ? null : (
            <Text dimColor>{grade.details.rationale}</Text>
          )}
          {grade.details.error === undefined ? null : (
            <Text color="red">{grade.details.error}</Text>
          )}
          {(grade.details.assertions ?? []).map((assertion, at) => {
            const parts = [`Assertion ${assertionLabel(assertion.key, at)}`];
            if (assertion.score !== undefined) {
              parts.push(`score ${scoreText(assertion.score)}`);
            }
            const behavior = assertionBehavior(
              assertion.key,
              projection.expectedBehaviors,
            );
            if (behavior !== null) parts.push(behavior);
            if (assertion.rationale !== undefined) parts.push(assertion.rationale);
            if (assertion.error !== undefined) parts.push(`error ${assertion.error}`);
            return (
              <Text key={`${grade.projectGraderId}:${assertion.key}`}>
                {parts.join("  ·  ")}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export function RunScreen({ run }: RunScreenProps) {
  const width = columnWidth(run.rows.map((row) => row.name));

  // The window follows the work: whatever is moving now stays on screen, and
  // rows already finished scroll off the top rather than pushing the live ones
  // out of sight.
  const live = run.rows.findIndex(
    (row) =>
      row.status !== "failed" &&
      row.status !== "canceled" &&
      !isTerminalGrading(row.gradingState),
  );
  const throughTo = live === -1 ? run.rows.length : Math.min(run.rows.length, live + VISIBLE_ROWS);
  const from = Math.max(0, throughTo - VISIBLE_ROWS);
  const shown = run.rows.slice(from, from + VISIBLE_ROWS);

  const { progress } = run;
  const first = run.firstResult;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        {`run ${run.runId}  ·  ${progress.total} ${progress.total === 1 ? "simulation" : "simulations"}`}
      </Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((row) => (
          <Text key={row.id} dimColor={row.status === "queued"}>
            {`${markFor(row)} ${row.name.padEnd(width)}  ${saidFor(row)}`.trimEnd()}
          </Text>
        ))}
      </Box>
      {first === null ? null : (
        <>
          <Box marginTop={1}>
            <Text bold>{`✓ First result: ${first.name} ${saidFor(first)}`}</Text>
          </Box>
          <GradeResult row={first} />
        </>
      )}
      <Box height={1} />
      <Text dimColor>
        {`execution ${progress.executionFinished}/${progress.total} finished  ·  grading ${progress.gradingTerminal}/${progress.gradingTotal} terminal  ·  errors ${progress.executionFailed + progress.gradingErrors}`}
      </Text>
      <Box height={1} />
      <Text dimColor>The run continues on Egma whether this stays open or not.</Text>
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
