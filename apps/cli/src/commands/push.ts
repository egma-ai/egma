/** `egma push`: send one complete repository change set. */

import { RepositoryValidationError } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { pushTests } from "../sync/push.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export async function runPushCommand(options: FolderCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`folder: ${ready.paths.root}`);

  try {
    const report = await pushTests({
      signedIn: ready.signedIn,
      paths: ready.paths,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    for (const test of report.tests) {
      options.out(`${test.state}: ${test.name}`);
      options.out(`file: ${test.shown}`);
      options.out(`version: ${test.versionId}`);
    }
    for (const refused of report.turnedAway) {
      options.out(`turned-away: ${refused.name}`);
      options.out(`file: ${refused.shown}`);
      options.out(`reason: ${refused.reason}`);
    }
    options.out(`suites: ${report.suites}`);
    options.out(`tests: ${report.tests.length}`);
    if (report.turnedAway.length > 0) {
      options.out("status: turned-away");
      options.fail("Fix the files named above, then push the whole repository again. Nothing was uploaded.");
      return FOLDER_EXIT.turnedAway;
    }
    options.out("status: pushed");
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof RepositoryValidationError) {
      options.out("status: invalid-folder");
      for (const reason of cause.issues) options.out(`reason: ${reason}`);
      options.fail(cause.message);
      return FOLDER_EXIT.nothing;
    }
    if (cause instanceof PlatformRefusedError) {
      options.out("status: refused");
      options.out(`reason: ${cause.message}`);
      options.fail(`${cause.message} Nothing was uploaded.`);
      return cause.status === 409 ? FOLDER_EXIT.moved : FOLDER_EXIT.turnedAway;
    }
    if (cause instanceof PlatformUnreachableError) {
      options.out("status: unreachable");
      options.out(`reason: ${cause.message}`);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }
}
