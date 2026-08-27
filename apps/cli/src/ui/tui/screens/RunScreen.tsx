/**
 * The run, one line per simulation, moving.
 *
 * This is the payoff, and it is the only screen in the walk whose job is to be
 * watched rather than answered. A developer who has been told what egma is
 * about to do now sees it happen: one line per simulation, each moving through
 * execution and then trace-level grading.
 *
 * **The first result is marked.** It is the first completed trace whose whole
 * grading work is terminal. A low grade is still a completed result. A grader
 * error is an operational error, not a quality verdict.
 *
 * **The screen stays for the full suite.** It follows execution and grading to
 * their terminal states. The run is on the platform too; closing a terminal has
 * never stopped one.
 */

import { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { RunView, SimulationRow } from "../../../run/view.ts";
import type { GradingState, SimulationStatus } from "../../../platform/runs.ts";
import { isTerminalGrading } from "../../../run/follow.ts";
import { FAILURE_MARK } from "../../../wizard/status.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";
import {
  assertionBehavior,
  assertionLabel,
  graderLabel,
  scoreText,
} from "../../../run/lines.ts";

export type RunScreenProps = {
  readonly run: RunView;
  readonly onOpen: () => Promise<boolean>;
};

/** How many rows are on screen at once, the live ones always among them. */
const VISIBLE_ROWS = 12;

/** A clickable terminal link, using the OSC 8 sequence supported by modern terminals. */
function terminalLink(url: string): string {
  // A self-hosted platform owns this value. Keep terminal control bytes out of
  // both the visible label and the OSC payload so it cannot close the link and
  // inject another terminal command.
  const safe = url.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
  const start = `\u001B]8;;${safe}\u001B\\`;
  const end = "\u001B]8;;\u001B\\";
  return `${start}${safe}${end}`;
}

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

export function RunScreen({ run, onOpen }: RunScreenProps) {
  const [openStatus, setOpenStatus] = useState<"opened" | "failed" | null>(null);
  const bindings: KeyBinding[] = [
    {
      match: ["return", "o"],
      label: "enter",
      action: "open results in browser",
      handler: () => {
        void onOpen().then((opened) => setOpenStatus(opened ? "opened" : "failed"));
      },
    },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

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
    <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        {`run ${run.runId}  ·  ${progress.total} ${progress.total === 1 ? "simulation" : "simulations"}`}
      </Text>
      <Text>{`Results: ${terminalLink(run.resultsUrl)}`}</Text>
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
      {openStatus === "opened" ? <Text dimColor>Opened results in your browser.</Text> : null}
      {openStatus === "failed" ? (
        <Text>{`${FAILURE_MARK} Could not open a browser. Use the results link above.`}</Text>
      ) : null}
      <Box height={1} />
      <Text dimColor>{`${hintBar(bindings)}   [ctrl-c] stop`}</Text>
    </Box>
  );
}
