/** `egma pull`: stage and apply one complete non-destructive repository pull. */

import { RepositoryValidationError, readConfig } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { readProject } from "../platform/projects.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { pullRepository } from "../sync/pull.ts";
import { readProjectTargets } from "../sync/targets.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export async function runPullCommand(options: FolderCommandOptions): Promise<number> {
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(
    `Pulling ${oneLineFactText(ready.paths.root, "this repository")} from Egma.`,
  );

  try {
    const config = await readConfig(ready.paths.config);
    if (config.project === null) {
      throw new RepositoryValidationError([
        "egma/config.yaml does not name a Project. Run egma init again.",
      ]);
    }
    const project = await readProject(
      ready.signedIn,
      config.project.id,
      options.fetchImpl,
    );
    const targets = await readProjectTargets(project.id, {
      ...ready.signedIn,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    if (targets.kind === "not-authenticated") {
      throw new PlatformRefusedError(401, targets.reason);
    }
    if (targets.kind === "refused") {
      throw new PlatformRefusedError(400, targets.reason);
    }
    if (targets.kind === "unreachable") {
      throw new PlatformUnreachableError(options.access.url, new Error(targets.reason));
    }

    const report = await pullRepository({
      signedIn: ready.signedIn,
      paths: ready.paths,
      config: { ...config, project, agents: targets.agents },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    for (const suite of report.suites) {
      options.out(
        `${suite.state === "written" ? "Wrote" : "Kept"} suite ${oneLineFactText(suite.name, "Unnamed Suite")}.`,
      );
      options.out(`  Directory: egma/tests/${suite.directory}`);
    }
    for (const test of report.tests) {
      options.out(
        `${test.state === "written" ? "Wrote" : "Kept"} test ${oneLineFactText(test.name, "Unnamed Test")}.`,
      );
      options.out(`  File: ${test.shown}`);
      options.out(
        `  Version ID: ${oneLineFactText(test.versionId, "unknown Test version ID")}`,
      );
    }
    for (const draft of report.kept) {
      options.out(
        `Kept local draft ${oneLineFactText(draft.name, "Unnamed Test")}.`,
      );
      options.out(`  File: ${draft.shown}`);
      options.out(`  ${oneLineFactText(draft.reason, "No reason was returned.")}`);
    }
    options.out(
      `Pull complete: ${report.suites.length} suites, ${report.tests.length} tests, and ${targets.agents.length} Agents.`,
    );
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof RepositoryValidationError) {
      options.fail(cause.message);
      return FOLDER_EXIT.nothing;
    }
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }
}
