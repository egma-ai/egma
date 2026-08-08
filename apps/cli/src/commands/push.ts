/**
 * `egma push`: upload the folder's tests, or refuse and say which ones moved.
 *
 * The refusal is the reason this verb exists in this shape. It names every test
 * the platform has moved on, one per line, so that whoever reads it — a person
 * or a coding agent — knows exactly what to look at and that nothing was
 * uploaded while they look.
 */

import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/tests.ts";
import { pushTests, type PushConflict } from "../sync/push.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

/** The one sentence a refusal ends on, naming what to do about it. */
export function movedRefusal(conflicts: readonly PushConflict[]): string {
  const names = conflicts.map((conflict) => conflict.name).join(", ");
  const moved = conflicts.filter((conflict) => conflict.reason === "moved").length;
  const opening =
    moved === conflicts.length
      ? `egma has a newer version of ${conflicts.length === 1 ? "this test" : "these tests"}: ${names}.`
      : `egma cannot match ${conflicts.length === 1 ? "this test" : "these tests"} to what it holds: ${names}.`;
  return `${opening} Run egma pull to bring ${conflicts.length === 1 ? "it" : "them"} down, look at what changed, then push again. Nothing was uploaded.`;
}

export async function runPushCommand(options: FolderCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`folder: ${ready.paths.root}`);

  let report;
  try {
    report = await pushTests({ signedIn: ready.signedIn, paths: ready.paths });
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.out("status: unreachable");
      options.out(`reason: ${cause.message}`);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }

  for (const test of report.tests) {
    options.out(`${test.state}: ${test.name}`);
    options.out(`file: ${test.shown}`);
    options.out(`version: ${test.versionId}`);
  }

  // Turned away, in egma's own words. The refusal egma can see coming — no
  // expected behaviors — is said before anything uploads; a refusal only the
  // platform can make arrives in the platform's words.
  for (const turned of report.turnedAway) {
    options.out(`turned-away: ${turned.name}`);
    options.out(`file: ${turned.shown}`);
    options.out(`reason: ${turned.reason}`);
  }

  if (report.conflicts.length > 0) {
    for (const conflict of report.conflicts) {
      options.out(`conflict: ${conflict.name}`);
      options.out(`file: ${conflict.shown}`);
    }
    options.out(`uploaded: ${report.uploadedNothing ? "nothing" : String(report.tests.length)}`);
    options.out("status: refused");
    options.fail(movedRefusal(report.conflicts));
    return FOLDER_EXIT.moved;
  }

  options.out(`tests: ${report.tests.length}`);
  if (report.turnedAway.length > 0) {
    options.out("status: turned-away");
    options.fail(
      `egma would not take ${report.turnedAway.length === 1 ? "one test" : `${report.turnedAway.length} tests`}. The reason above is egma's own; fix the ${report.turnedAway.length === 1 ? "file" : "files"} and push again.`,
    );
    return FOLDER_EXIT.turnedAway;
  }

  options.out("status: pushed");
  return FOLDER_EXIT.done;
}
