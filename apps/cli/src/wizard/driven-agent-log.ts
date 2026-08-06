/**
 * Where the driven agent's own output is kept.
 *
 * A coding agent writes whatever its own authors decided to its standard error:
 * progress, warnings, the stack trace behind a failure. None of that is the
 * stream of actions the wizard shows a developer, and none of it can be thrown
 * away either — when a run fails, it is the only account of why. So it is
 * appended to one file per run, in the folder the operating system keeps for
 * such things, and the path is handed to the UI so the developer can be sent to
 * it.
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export type DrivenAgentLog = {
  /** The file every chunk is appended to. */
  readonly file: string;
  write(chunk: string): void;
};

/** A stamp that sorts, reads as a date, and is legal in a file name. */
function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/** A fresh log for one run. Nothing is written until the agent says something. */
export function openDrivenAgentLog(now: Date = new Date()): DrivenAgentLog {
  const file = path.join(tmpdir(), `egma-${stampOf(now)}-${process.pid}.log`);
  return {
    file,
    write(chunk: string): void {
      try {
        appendFileSync(file, chunk, "utf8");
      } catch {
        // A log egma cannot write is not a reason to stop a run that works.
      }
    },
  };
}
