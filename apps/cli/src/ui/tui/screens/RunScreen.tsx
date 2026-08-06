/**
 * The run, one line per simulation, moving.
 *
 * This is the payoff, and it is the only screen in the walk whose job is to be
 * watched rather than answered. A developer who has spent nine minutes being
 * told what egma is about to do now sees it happen: twelve lines, each moving
 * through its own lifecycle, and then a verdict.
 *
 * **The first verdict is marked.** It is the moment the whole walk is timed
 * against — the point where the developer stops taking egma's word for it —
 * so it does not scroll past looking like every other change. It is called out
 * on its own line, once, and stays called out.
 *
 * **The four verdicts are drawn as four.** `skipped` and `errored` have their
 * own marks and their own words, and neither is ever coloured or worded like
 * `failed`. A test egma could not run is not a test the agent got wrong, and a
 * screen that suggested otherwise would be egma blaming somebody else for its
 * own outage.
 *
 * **Nothing here waits for the suite.** The wizard leaves as soon as the first
 * verdict has landed and the developer has answered the last question. The run
 * is on the platform; closing a terminal has never stopped one.
 */

import { Box, Text } from "ink";

import type { RunView, SimulationRow } from "../../../run/view.ts";
import type { SimulationStatus, Verdict } from "../../../platform/runs.ts";

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

/**
 * What each verdict is called on screen.
 *
 * Four words for four verdicts. None of them is a synonym for another and none
 * of them is left out.
 */
const VERDICT_SAID: Readonly<Record<Verdict, string>> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  errored: "errored",
};

function markFor(row: SimulationRow): string {
  if (row.verdict !== null) return ENDED_MARK;
  return row.status === "queued" ? QUEUED_MARK : RUNNING_MARK;
}

/** The right-hand column: the verdict when there is one, the state when not. */
function saidFor(row: SimulationRow): string {
  if (row.verdict !== null) return VERDICT_SAID[row.verdict];
  return STATUS_SAID[row.status];
}

/** The widest name, so the second column starts in the same place on every row. */
function columnWidth(names: readonly string[]): number {
  return names.reduce((widest, name) => Math.max(widest, name.length), 0);
}

export function RunScreen({ run }: RunScreenProps) {
  const width = columnWidth(run.rows.map((row) => row.name));

  // The window follows the work: whatever is moving now stays on screen, and
  // rows already judged scroll off the top rather than pushing the live ones
  // out of sight.
  const live = run.rows.findIndex((row) => row.verdict === null);
  const throughTo = live === -1 ? run.rows.length : Math.min(run.rows.length, live + VISIBLE_ROWS);
  const from = Math.max(0, throughTo - VISIBLE_ROWS);
  const shown = run.rows.slice(from, from + VISIBLE_ROWS);

  const { tally } = run;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>
        {`run ${run.runId}  ·  ${tally.total} ${tally.total === 1 ? "simulation" : "simulations"}`}
      </Text>
      <Box height={1} />
      <Box flexDirection="column">
        {shown.map((row) => (
          <Text key={row.id} dimColor={row.status === "queued"}>
            {`${markFor(row)} ${row.name.padEnd(width)}  ${saidFor(row)}`.trimEnd()}
          </Text>
        ))}
      </Box>
      {run.firstVerdict === null ? null : (
        <Box marginTop={1}>
          <Text bold>
            {`✓ First verdict: ${run.firstVerdict.name} ${VERDICT_SAID[run.firstVerdict.verdict ?? "passed"]}`}
          </Text>
        </Box>
      )}
      <Box height={1} />
      <Text dimColor>
        {`passed ${tally.passed}  ·  failed ${tally.failed}  ·  skipped ${tally.skipped}  ·  errored ${tally.errored}  ·  waiting ${tally.pending}`}
      </Text>
      <Box height={1} />
      <Text dimColor>The suite keeps running on egma whether this stays open or not.</Text>
      <Box height={1} />
      <Text dimColor>[ctrl-c] stop</Text>
    </Box>
  );
}
