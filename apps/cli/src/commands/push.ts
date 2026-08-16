/**
 * `egma push`: upload what the folder says, or refuse and say what moved.
 *
 * The refusal is the reason this verb exists in this shape. It names every test
 * the platform has moved on, one per line, so that whoever reads it — a person
 * or a coding agent — knows exactly what to look at and that nothing was
 * uploaded while they look.
 */

import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { pushMockTools, type PushMockToolsReport } from "../sync/mock-tools.ts";
import { pushTests, type PushConflict } from "../sync/push.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

/** The one sentence a refusal ends on, naming what to do about it. */
export function movedRefusal(conflicts: readonly PushConflict[]): string {
  const names = conflicts.map((conflict) => conflict.name).join(", ");
  const moved = conflicts.filter((conflict) => conflict.reason === "moved").length;
  const opening =
    moved === conflicts.length
      ? `Egma has a newer version of ${conflicts.length === 1 ? "this test" : "these tests"}: ${names}.`
      : `Egma cannot match ${conflicts.length === 1 ? "this test" : "these tests"} to what it holds: ${names}.`;
  return `${opening} Run egma pull to bring ${conflicts.length === 1 ? "it" : "them"} down, look at what changed, then push again. Nothing was uploaded.`;
}

export async function runPushCommand(options: FolderCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`folder: ${ready.paths.root}`);

  let report;
  let mocked: PushMockToolsReport = { mockTools: [], turnedAway: [] };
  try {
    report = await pushTests({ signedIn: ready.signedIn, paths: ready.paths });
    // A push that is going to be refused stops where it is. The refusal ends on
    // "run egma pull, look at what changed, then push again", and a push that
    // had gone on to land the mocked world would have made that sentence a lie
    // about half the folder — including in the race where the platform's own
    // door caught the conflict after some tests had already landed.
    const refused = report.conflicts.length > 0;
    if (!refused) {
      mocked = await pushMockTools({ signedIn: ready.signedIn, paths: ready.paths });
    }
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

  // Under keys of their own, never under the tests': a mock tool has no version
  // to print beside it, and something reading these lines has to be able to
  // tell one kind of thing from the other.
  for (const tool of mocked.mockTools) {
    options.out(`mock-tool-${tool.state}: ${tool.tool}`);
  }

  // Turned away, in egma's own words. The refusal egma can see coming — no
  // expected behaviors, a file it cannot read — is said before anything
  // uploads; a refusal only the platform can make arrives in the platform's
  // words, which is where every rule about what a mock tool may say is held.
  const turnedAway = [...report.turnedAway, ...mocked.turnedAway];
  for (const turned of turnedAway) {
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
  options.out(`mock-tools: ${mocked.mockTools.length}`);
  if (turnedAway.length > 0) {
    options.out("status: turned-away");
    options.fail(
      `Egma would not take ${turnedAway.length === 1 ? "one of these" : `${turnedAway.length} of these`}. The reason above is Egma's own; fix the ${turnedAway.length === 1 ? "file" : "files"} and push again.`,
    );
    return FOLDER_EXIT.turnedAway;
  }

  options.out("status: pushed");
  return FOLDER_EXIT.done;
}
