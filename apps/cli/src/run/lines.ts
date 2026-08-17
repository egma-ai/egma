/**
 * What a run looks like to something that reads lines rather than screens.
 *
 * Two surfaces print these — the `egma run` verb, and the wizard when it is
 * running with nobody watching — so the shapes live in one place. Two copies
 * would be two contracts, and the one that drifted would be the one a coding
 * agent had already been written against.
 *
 * One fact per line, `key: value`, the same shape every other verb prints. The
 * four verdicts are printed as four counts, always all four, always by their
 * own names: a suite with nothing skipped still prints `skipped: 0`, because a
 * reader that has to infer a zero from a missing line is a reader that will
 * one day infer the wrong thing.
 */

import type { RunChange, RunTally, SimulationRow } from "./follow.ts";

/** One simulation's state, named by the test and the persona that make it. */
export function simulationLine(row: SimulationRow): string {
  return `simulation: ${row.name} ${row.persona} ${row.status}`;
}

/**
 * Every line one change is worth: what happened, the verdict when one landed,
 * the platform's own reason when it gave one, and the mark on the first
 * verdict of the run.
 *
 * The first verdict gets a line of its own rather than a flag on another line,
 * so the moment the wizard is timed against is one a reader can wait for
 * without parsing anything.
 */
export function changeLines(change: RunChange): readonly string[] {
  const lines = change.statusChanged ? [simulationLine(change.row)] : [];
  if (change.verdictLanded && change.row.verdict !== null) {
    lines.push(`verdict: ${change.row.name} ${change.row.persona} ${change.row.verdict}`);
    if (change.row.reason !== null) lines.push(`reason: ${change.row.reason}`);
    if (change.first) {
      lines.push(`first-verdict: ${change.row.name} ${change.row.persona} ${change.row.verdict}`);
    }
  }
  return lines;
}

/**
 * The summary, in the order a reader wants it: the four verdicts, what has not
 * been judged yet, and how many simulations there were altogether.
 */
export function tallyLines(tally: RunTally): readonly string[] {
  return [
    `passed: ${tally.passed}`,
    `failed: ${tally.failed}`,
    `skipped: ${tally.skipped}`,
    `errored: ${tally.errored}`,
    `pending: ${tally.pending}`,
    `simulations: ${tally.total}`,
  ];
}
