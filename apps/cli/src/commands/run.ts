/** `egma run <suite-directory>`: run one exact current-set precondition. */

import {
  RepositoryValidationError,
  folderPathsIn,
  readConfig,
  type FolderConfig,
} from "../folder/egma-folder.ts";
import { selectTarget, type RefusedTarget } from "../folder/target-selection.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { hydrateRun, startRun } from "../platform/runs.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";
import {
  laneOfConnectionType,
  LANE_NAMES,
  PHONE_RUN_REACHES_REAL_TOOLS,
} from "../retell/connect.ts";
import { followRun, RunFollower } from "../run/follow.ts";
import {
  changeLines,
  gradingLine,
  progressLines,
  simulationLine,
} from "../run/lines.ts";
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
  unreachable: 4,
  refused: 5,
  operational: 6,
  interrupted: 130,
} as const;

export type RunCommandOptions = FolderCommandOptions & {
  readonly suiteDirectory: string;
  /** Exact committed agent name or stable id. Omit only when one can run. */
  readonly agent?: string;
  /** Exact committed connection name or stable id under the selected agent. */
  readonly connection?: string;
  readonly name?: string;
  readonly noFollow?: boolean;
  readonly signal?: AbortSignal;
  readonly everyMs?: number;
};

function reportTargetRefusal(options: RunCommandOptions, refusal: RefusedTarget): void {
  for (const agent of refusal.agents) {
    options.out(`agent-option: ${agent.id} ${agent.name}`);
  }
  for (const connection of refusal.connections) {
    options.out(`connection-option: ${connection.id} ${connection.name}`);
  }
  options.out(`status: ${refusal.status}`);
  options.fail(refusal.message);
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
  const target = selectTarget(config, {
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  });
  if (target.kind === "refused") {
    reportTargetRefusal(options, target);
    return RUN_EXIT.nothing;
  }
  options.out(`agent: ${target.agent.id}`);
  options.out(`connection: ${target.connection.id}`);

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
        agentId: target.agent.id,
        connectionId: target.connection.id,
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
  // **The lane, at the start, off the answer to the start itself.** The folder
  // this run was resolved from stores a connection's id and its name, and a
  // name is what somebody chose to call it — so the lane is read from the run
  // the platform just wrote, which names the kind. A lane this build has no
  // word for falls back to the platform's own product label rather than being
  // called something it is not.
  const lane = laneOfConnectionType(header.connectionType);
  options.out(`lane: ${lane === null ? header.productLabel : LANE_NAMES[lane]}`);
  if (lane === "phone") options.out(`note: ${PHONE_RUN_REACHES_REAL_TOOLS}`);
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
    options.out(simulationLine(row));
    const grading = gradingLine(row);
    if (grading !== null) options.out(grading);
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
  const progress = follower.progress;
  for (const line of progressLines(progress)) options.out(line);
  if (ending === "interrupted") {
    options.out("status: left-running");
    return RUN_EXIT.interrupted;
  }
  options.out(`status: ${follower.runStatus}`);
  if (progress.executionFailed > 0 || progress.gradingErrors > 0) {
    return RUN_EXIT.operational;
  }
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
