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
import { pushTests, type PushConflict, type PushedTest } from "../sync/push.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

/**
 * The sentence a refusal ends on, naming what to do about it.
 *
 * **A conflict that brought its own words keeps them.** Two of the six reasons
 * are fixed by one pull and one look, and summarising those together is what
 * this function is for. The other four each send somebody somewhere else — to
 * migrate a file, to relink a test in the browser, to restore one — and folding
 * those into "run egma pull" would be advice that does not work, given at the
 * one moment somebody most needs advice that does.
 *
 * It ends "Nothing was uploaded", which is the whole worth of the preflight and
 * is why it is said out loud. It is therefore **only ever the preflight's
 * sentence**: see `lateRefusal` for the race after it, where saying this would
 * be telling somebody something untrue about what had just happened.
 */
export function movedRefusal(conflicts: readonly PushConflict[]): string {
  const spoken = conflicts.filter((conflict) => conflict.said !== null);
  const summarised = conflicts.filter((conflict) => conflict.said === null);
  if (summarised.length === 0) {
    return spoken.map((conflict) => conflict.said).join(" ");
  }

  const names = summarised.map((conflict) => conflict.name).join(", ");
  const moved = summarised.filter((conflict) => conflict.reason === "moved").length;
  const opening =
    moved === summarised.length
      ? `egma has a newer version of ${summarised.length === 1 ? "this test" : "these tests"}: ${names}.`
      : `egma cannot match ${summarised.length === 1 ? "this test" : "these tests"} to what it holds: ${names}.`;
  const pull = `${opening} Run egma pull to bring ${summarised.length === 1 ? "it" : "them"} down, look at what changed, then push again. Nothing was uploaded.`;
  return [pull, ...spoken.map((conflict) => conflict.said)].join(" ");
}

/**
 * The sentence for a refusal that arrived after some of the folder had landed.
 *
 * Nothing here spans several files in one transaction, so a test edited or
 * unlinked between the preflight and one file's upload is refused at the
 * platform's own door with earlier files already written. What somebody needs
 * at that moment is the truth about the run: **which files landed, and which
 * did not.** The preflight's sentence says the opposite of that — its last
 * clause is that nothing was uploaded — and a recovery built on a false account
 * of what happened is not a recovery.
 *
 * So this one counts. It names what went up, names what did not with the reason
 * for each, and asks for the pull that makes the second push a real one. The
 * count agrees with the `uploaded:` line the caller prints beside it, because
 * both are read off the same report.
 */
export function lateRefusal(
  pushed: readonly PushedTest[],
  conflicts: readonly PushConflict[],
): string {
  const landed = pushed.map((test) => test.name).join(", ");
  const refused = conflicts.map((conflict) => conflict.name).join(", ");
  const spoken = conflicts.flatMap((conflict) =>
    conflict.said === null ? [] : [conflict.said],
  );

  return [
    pushed.length === 0
      ? `egma took none of these: it refused ${conflicts.length === 1 ? "" : "each of "}${refused} after the check that said it would not.`
      : `egma uploaded ${String(pushed.length)} of these and then refused ${refused}: somebody moved ${conflicts.length === 1 ? "it" : "them"} between the check and the write. What has landed has landed — ${landed} — and the rest has not.`,
    ...spoken,
    "Run egma pull to bring egma's answer down, look at what changed, then push again.",
  ].join(" ");
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
      // Which of the six, on its own line, so something driving this knows
      // whether the fix is a pull, a migration, or somebody's decision in the
      // browser — without reading the sentence to find out.
      options.out(`reason-code: ${conflict.reason}`);
      if (conflict.said !== null) options.out(`reason: ${conflict.said}`);
    }
    options.out(`uploaded: ${report.uploadedNothing ? "nothing" : String(report.tests.length)}`);
    options.out("status: refused");
    // Two sentences, and which one is said is decided by what actually
    // happened rather than by which check refused. "Nothing was uploaded" is
    // the preflight's promise and it is true; said over a push that had
    // already written four tests it would be a refusal lying about the run.
    options.fail(
      report.uploadedNothing
        ? movedRefusal(report.conflicts)
        : lateRefusal(report.tests, report.conflicts),
    );
    return FOLDER_EXIT.moved;
  }

  options.out(`tests: ${report.tests.length}`);
  options.out(`mock-tools: ${mocked.mockTools.length}`);
  if (turnedAway.length > 0) {
    options.out("status: turned-away");
    options.fail(
      `egma would not take ${turnedAway.length === 1 ? "one of these" : `${turnedAway.length} of these`}. The reason above is egma's own; fix the ${turnedAway.length === 1 ? "file" : "files"} and push again.`,
    );
    return FOLDER_EXIT.turnedAway;
  }

  options.out("status: pushed");
  return FOLDER_EXIT.done;
}
