/** `egma push`: send one complete repository change set. */

import { RepositoryValidationError } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import {
  PushMaterializationError,
  pushTests,
  type PushedTest,
} from "../sync/push.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type PushCommandOptions = FolderCommandOptions & {
  readonly signal?: AbortSignal;
  /** Filesystem boundary, replaced only by command-level recovery tests. */
  readonly writeTestFile?: Parameters<typeof pushTests>[0]["writeTestFile"];
};

function interrupted(options: PushCommandOptions): number {
  options.fail(
    "The command was interrupted before it received a complete answer. Run egma pull before you try again.",
  );
  return FOLDER_EXIT.interrupted;
}

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sayTestReceipt(
  test: PushedTest,
  out: (line: string) => void,
  verb: "Created" | "Updated" | "Applied",
): void {
  out(
    `${verb} Test ${JSON.stringify(test.name)} (${oneLineFactText(test.testId, "unknown Test ID")}).`,
  );
  out(`  File: ${test.shown}`);
  out(`  Version ID: ${oneLineFactText(test.versionId, "unknown Test version ID")}`);
}

export async function runPushCommand(options: PushCommandOptions): Promise<number> {
  if (wasInterrupted(options.signal)) return interrupted(options);
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  if (wasInterrupted(options.signal)) return interrupted(options);
  options.out(
    `Pushing ${oneLineFactText(ready.paths.root, "this repository")} to Egma.`,
  );

  try {
    const report = await pushTests({
      signedIn: ready.signedIn,
      paths: ready.paths,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.writeTestFile === undefined
        ? {}
        : { writeTestFile: options.writeTestFile }),
    });
    for (const test of report.tests) {
      sayTestReceipt(
        test,
        options.out,
        test.state === "created" ? "Created" : "Updated",
      );
    }
    for (const refused of report.turnedAway) {
      options.out(
        `Could not push ${oneLineFactText(refused.name, "Unnamed Test")}.`,
      );
      options.out(`  File: ${refused.shown}`);
      options.out(`  ${oneLineFactText(refused.reason, "No reason was returned.")}`);
    }
    if (report.turnedAway.length > 0) {
      options.fail("Fix the files named above, then push the whole repository again. Nothing was uploaded.");
      return FOLDER_EXIT.turnedAway;
    }
    options.out(
      `Push complete: ${report.suites} suites and ${report.tests.length} tests.`,
    );
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof PushMaterializationError) {
      for (const test of cause.tests) sayTestReceipt(test, options.out, "Applied");
      const detail = oneLineFactText(
        cause.cause instanceof Error ? cause.cause.message : String(cause.cause),
        "unknown local write error",
      );
      options.fail(
        `Egma applied the repository, but could not refresh ${cause.shown}: ${detail}`,
      );
      options.fail("Run egma pull.");
      return FOLDER_EXIT.localWriteFailed;
    }
    if (cause instanceof RepositoryValidationError) {
      options.fail(cause.message);
      return FOLDER_EXIT.nothing;
    }
    if (cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      options.fail("Nothing was uploaded.");
      return cause.status === 409 ? FOLDER_EXIT.moved : FOLDER_EXIT.turnedAway;
    }
    if (cause instanceof PlatformUnreachableError) {
      if (wasInterrupted(options.signal)) return interrupted(options);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }
}
