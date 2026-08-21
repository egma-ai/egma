/** `egma pull`: stage and apply one complete non-destructive repository pull. */

import { RepositoryValidationError } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { pullRepository } from "../sync/pull.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export async function runPullCommand(options: FolderCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`folder: ${ready.paths.root}`);

  try {
    const report = await pullRepository({
      signedIn: ready.signedIn,
      paths: ready.paths,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    for (const suite of report.suites) {
      options.out(`suite-${suite.state}: ${suite.name}`);
      options.out(`directory: egma/tests/${suite.directory}`);
    }
    for (const test of report.tests) {
      options.out(`${test.state}: ${test.name}`);
      options.out(`file: ${test.shown}`);
      options.out(`version: ${test.versionId}`);
    }
    for (const draft of report.kept) {
      options.out(`kept: ${draft.name}`);
      options.out(`file: ${draft.shown}`);
      options.out(`reason: ${draft.reason}`);
    }
    for (const tool of report.mockTools) options.out(`mock-tool: ${tool}`);
    options.out(`suites: ${report.suites.length}`);
    options.out(`tests: ${report.tests.length}`);
    options.out(`mock-tools: ${report.mockTools.length}`);
    options.out("status: pulled");
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof RepositoryValidationError) {
      options.out("status: invalid-folder");
      for (const reason of cause.issues) options.out(`reason: ${reason}`);
      options.fail(cause.message);
      return FOLDER_EXIT.nothing;
    }
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.out("status: unreachable");
      options.out(`reason: ${cause.message}`);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }
}
