/**
 * `egma pull`: write the platform's current versions into the folder.
 *
 * Nothing here reads standard input and nothing here draws, so a coding agent
 * can run it, read what it prints, and act on it. One fact per line, in the same
 * shape `egma login` prints: the state of a test, then the test.
 */

import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/tests.ts";
import { pullTests } from "../sync/pull.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export async function runPullCommand(options: FolderCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`folder: ${ready.paths.root}`);

  let report;
  try {
    report = await pullTests({ signedIn: ready.signedIn, paths: ready.paths });
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.out("status: unreachable");
      options.out(`reason: ${cause.message}`);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }

  // One fact per line and every line flat: what happened to a test, then the
  // file it happened to, then the version the file now pins.
  for (const test of report.tests) {
    options.out(`${test.state}: ${test.name}`);
    options.out(`file: ${test.shown}`);
    options.out(`version: ${test.versionId}`);
  }
  for (const name of report.kept) options.out(`kept: ${name}`);

  options.out(`tests: ${report.tests.length}`);
  options.out(`status: pulled`);
  return FOLDER_EXIT.done;
}
