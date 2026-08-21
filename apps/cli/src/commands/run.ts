/** `egma run <suite-directory>`: run one exact current-set precondition. */

import {
  RepositoryValidationError,
  folderPathsIn,
  readConfig,
  type FolderConfig,
} from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { hydrateRun, startRun } from "../platform/runs.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";
import { followRun, RunFollower } from "../run/follow.ts";
import { changeLines, tallyLines } from "../run/lines.ts";
import {
  RunSelectionError,
  selectSuiteForRun,
  type Selection,
} from "../run/selection.ts";
import type { FolderCommandOptions } from "./folder-verbs.ts";

export const RUN_EXIT = {
  done: 0,
  nothing: 1,
  notSignedIn: 2,
  failed: 3,
  unreachable: 4,
  refused: 5,
  errored: 6,
  interrupted: 130,
} as const;

export type RunCommandOptions = FolderCommandOptions & {
  readonly suiteDirectory: string;
  readonly name?: string;
  readonly noFollow?: boolean;
  readonly signal?: AbortSignal;
  readonly everyMs?: number;
};

function targetIn(config: FolderConfig): { readonly agentId: string; readonly connectionId: string } | string {
  const agentId = config.agent?.id ?? "";
  const connectionId = config.connection?.id ?? "";
  return agentId === "" || connectionId === ""
    ? "This folder does not say which voice agent to run against, or how Egma reaches it. Run egma connect here first."
    : { agentId, connectionId };
}

function reportSelection(options: RunCommandOptions, selection: Selection): void {
  options.out(`suite: ${selection.suiteId}`);
  options.out(`suite-name: ${selection.suiteName}`);
  options.out(`directory: egma/tests/${selection.suiteDirectory}`);
  for (const one of selection.pinned) options.out(`pin: ${one.name} ${one.versionId}`);
}

export async function runRunCommand(options: RunCommandOptions): Promise<number> {
  options.out(`url: ${options.access.url}`);
  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch {
    options.out("status: no-folder");
    options.fail(`There is no valid egma folder in ${options.cwd}. Run egma init here first.`);
    return RUN_EXIT.nothing;
  }
  options.out(`folder: ${paths.root}`);

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return RUN_EXIT.notSignedIn;
  }
  const target = targetIn(config);
  if (typeof target === "string") {
    options.out("status: not-connected");
    options.fail(target);
    return RUN_EXIT.nothing;
  }
  options.out(`agent: ${target.agentId}`);
  options.out(`connection: ${target.connectionId}`);

  let selection: Selection;
  try {
    selection = await selectSuiteForRun({
      signedIn,
      paths,
      directory: options.suiteDirectory,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (cause) {
    if (cause instanceof RunSelectionError || cause instanceof RepositoryValidationError) {
      options.out("status: not-matched");
      const issues = cause instanceof RunSelectionError ? cause.issues : cause.issues;
      for (const issue of issues) options.out(`reason: ${issue}`);
      options.fail(cause.message);
      return RUN_EXIT.nothing;
    }
    return unreachable(options, cause);
  }
  reportSelection(options, selection);

  let answer;
  try {
    answer = await startRun(
      signedIn,
      {
        suiteId: selection.suiteId,
        agentId: target.agentId,
        connectionId: target.connectionId,
        expectedTestVersions: selection.pinned.map((one) => ({
          testId: one.testId,
          versionId: one.versionId,
        })),
        ...(options.name === undefined ? {} : { name: options.name }),
      },
      options.fetchImpl,
    );
  } catch (cause) {
    return unreachable(options, cause);
  }
  if (answer.kind === "refused") {
    options.out("status: refused");
    options.out(`reason: ${answer.reason}`);
    options.fail(answer.reason);
    return RUN_EXIT.refused;
  }

  const header = answer.run;
  options.out(`run: ${header.id}`);
  options.out(`tests: ${selection.pinned.length}`);
  options.out(`simulations: ${header.expectedSimulationCount}`);
  options.out(`results: ${header.resultsUrl}`);
  if (options.noFollow === true) {
    options.out("status: started");
    return RUN_EXIT.done;
  }

  let run;
  try {
    run = await hydrateRun(signedIn, header, options.fetchImpl);
  } catch (cause) {
    // The POST succeeded. Keep that fact visible even when the first bounded
    // simulation page cannot be read and this terminal cannot follow it.
    options.out("run-status: started");
    return unreachable(options, cause);
  }
  const follower = new RunFollower(run);
  for (const row of follower.rows) {
    options.out(`simulation: ${row.name} ${row.persona} ${row.status}`);
  }

  let ending;
  try {
    ending = await followRun({
      signedIn,
      follower,
      onChange: (change) => {
        for (const line of changeLines(change)) options.out(line);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.everyMs === undefined ? {} : { everyMs: options.everyMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (cause) {
    return unreachable(options, cause);
  }
  const tally = follower.tally;
  for (const line of tallyLines(tally)) options.out(line);
  if (ending === "interrupted") {
    options.out("status: left-running");
    return RUN_EXIT.interrupted;
  }
  options.out(`status: ${follower.runStatus}`);
  if (tally.failed > 0) return RUN_EXIT.failed;
  if (tally.errored > 0) return RUN_EXIT.errored;
  return RUN_EXIT.done;
}

function unreachable(options: RunCommandOptions, cause: unknown): number {
  if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
    options.out("status: unreachable");
    options.out(`reason: ${cause.message}`);
    options.fail(cause.message);
    return RUN_EXIT.unreachable;
  }
  throw cause;
}
