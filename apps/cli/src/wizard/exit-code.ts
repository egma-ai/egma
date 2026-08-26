/**
 * What number the wizard's walk answers a shell with.
 *
 * It sits beside the exit line rather than inside the entry point because it is
 * the same decision said a second way: the line is what a person reads and the
 * number is what a script reads, and the two have to agree about whether the
 * walk did what it set out to do. Keeping them apart in one file each, in one
 * folder, is what lets a check hold an ending to both at once.
 */

import type { ExitReport } from "./exit-line.ts";

/**
 * What the whole walk answers with, which is not what `egma login` answers.
 *
 * The rule that matters is not obvious from any one line of it: a monitoring
 * lane whose deliverable — watching really on — was refused answers nonzero,
 * while a testing walk that ended honestly short of a run does not.
 */
export function walkExitCode(report: ExitReport): number {
  switch (report.kind) {
    // The files are written either way, and the developer decided what happens
    // to them. Pressing `q` over the list is the run finishing; pressing Ctrl-C
    // over it leaves the same files and is still an interruption to a shell.
    case "tests-kept":
      return report.stopped ? 130 : 0;
    case "found-agent":
    case "connected":
    case "tests-pushed":
    // The run is going and the developer has what they need to watch it. That
    // the suite is not finished is the design, not an incomplete run.
    case "run-started":
    case "quit":
    // egma did everything it could here: it named what is missing and handed
    // over words that work without it. That is the run finishing, not failing.
    case "no-coding-agent":
    // Watching is really on, and an account with nothing to import yet is not
    // a failure — the ending says so in words rather than in a number.
    case "monitoring-started":
    // The worker is wired and the two lines are on the screen. Nothing waits,
    // because push is observed rather than declared.
    case "monitoring-wired":
      return 0;
    case "interrupted":
      return 130;
    // The monitoring lane's deliverable is that watching is really on, so a
    // walk that did not manage it answers a shell as the failure it is.
    case "monitoring-refused":
    case "monitoring-record-failed":
      return 1;
    case "no-agent-context":
    case "unsupported-agent-platform":
    // The coding agent stopped the work itself. Nothing was found, and the run
    // did not do what it set out to do.
    case "coding-agent-stopped":
    case "failed":
      return 1;
  }
}
