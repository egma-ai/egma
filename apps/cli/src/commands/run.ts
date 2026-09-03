/** `egma run create | cancel`: explicit Run resource commands. */

import {
  RepositoryValidationError,
  folderPathsIn,
  readConfig,
  type FolderConfig,
} from "../folder/egma-folder.ts";
import { selectTarget, type RefusedTarget } from "../folder/target-selection.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { cancelRun, startRun } from "../platform/runs.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";
import {
  RunSelectionError,
  selectSuiteForRun,
  type Selection,
} from "../run/selection.ts";
import { pushTests } from "../sync/push.ts";
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

/** Inputs to `egma run create`, with every resource identity named. */
export type RunCreateCommandOptions = FolderCommandOptions & {
  readonly suiteDirectory: string;
  readonly agent: string;
  readonly connection: string;
  readonly name?: string;
  readonly signal: AbortSignal;
};

/** Inputs to `egma run cancel`. */
export type RunCancelCommandOptions = FolderCommandOptions & {
  readonly runId: string;
  readonly signal?: AbortSignal;
};

function reportTargetRefusal(
  options: Pick<FolderCommandOptions, "out" | "fail">,
  refusal: RefusedTarget,
): void {
  for (const agent of refusal.agents) {
    options.out(`agent-option: ${agent.id} ${agent.name}`);
  }
  for (const connection of refusal.connections) {
    options.out(`connection-option: ${connection.id} ${connection.name}`);
  }
  options.out(`status: ${refusal.status}`);
  options.fail(refusal.message);
}

/** The browser route for one Run, rooted at the repository's committed platform. */
function runResultsUrl(
  origin: string,
  projectId: string,
  runId: string,
): string {
  return new URL(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    origin,
  ).toString();
}

function interrupted(
  options: Pick<FolderCommandOptions, "out" | "fail">,
): number {
  options.out("status: interrupted");
  options.fail(
    "The command was interrupted before it received a complete answer. Check the Runs page before you try again.",
  );
  return RUN_EXIT.interrupted;
}

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Push the complete local repository before a Run is created. */
async function pushBeforeRun(
  options: RunCreateCommandOptions,
  input: {
    readonly signedIn: NonNullable<Awaited<ReturnType<typeof signedInAt>>>;
    readonly paths: ReturnType<typeof folderPathsIn>;
  },
): Promise<number | null> {
  try {
    const report = await pushTests({
      signedIn: input.signedIn,
      paths: input.paths,
      signal: options.signal,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    if (options.signal.aborted) return interrupted(options);
    if (report.turnedAway.length === 0) return null;

    for (const refused of report.turnedAway) {
      options.out(`turned-away: ${refused.name}`);
      options.out(`file: ${refused.shown}`);
      options.out(`reason: ${refused.reason}`);
    }
    options.out("status: push-refused");
    options.fail(
      "The complete repository could not be pushed, so no Run was created.",
    );
    return RUN_EXIT.refused;
  } catch (cause) {
    if (options.signal.aborted) return interrupted(options);
    if (cause instanceof RepositoryValidationError) {
      options.out("status: invalid-folder");
      for (const reason of cause.issues) options.out(`reason: ${reason}`);
      options.fail(cause.message);
      return RUN_EXIT.nothing;
    }
    if (cause instanceof PlatformRefusedError) {
      options.out("status: push-refused");
      options.out(`reason: ${cause.message}`);
      options.fail(`${cause.message} No Run was created.`);
      return RUN_EXIT.refused;
    }
    if (cause instanceof PlatformUnreachableError) {
      return unreachable(options, cause);
    }
    throw cause;
  }
}

/**
 * Push the complete repository, create one Run, print its durable handles, and
 * return. Run progress belongs in the web product, not in this command.
 */
export async function runCreateCommand(
  options: RunCreateCommandOptions,
): Promise<number> {
  if (options.signal.aborted) return interrupted(options);

  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch {
    options.out("status: no-folder");
    options.fail(`There is no valid egma folder in ${options.cwd}. Run egma init here first.`);
    return RUN_EXIT.nothing;
  }

  if (config.platform === null || config.project === null) {
    options.out("status: not-bound");
    options.fail(
      "egma/config.yaml does not name an Egma platform and Project. Run egma init here first.",
    );
    return RUN_EXIT.nothing;
  }

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return RUN_EXIT.notSignedIn;
  }

  const target = selectTarget(config, {
    agent: options.agent,
    connection: options.connection,
  });
  if (target.kind === "refused") {
    reportTargetRefusal(options, target);
    return RUN_EXIT.nothing;
  }

  const pushFailure = await pushBeforeRun(options, { signedIn, paths });
  if (pushFailure !== null) return pushFailure;

  let selection: Selection;
  try {
    selection = await selectSuiteForRun({
      signedIn,
      paths,
      directory: options.suiteDirectory,
      signal: options.signal,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (cause) {
    if (options.signal.aborted) return interrupted(options);
    if (cause instanceof RunSelectionError || cause instanceof RepositoryValidationError) {
      options.out("status: not-matched");
      for (const issue of cause.issues) options.out(`reason: ${issue}`);
      options.fail(cause.message);
      return RUN_EXIT.nothing;
    }
    return unreachable(options, cause);
  }

  let answer;
  try {
    // `startRun` mints the per-request idempotency value required by the
    // existing API. It is deliberately not part of this public command.
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
      options.signal,
    );
  } catch (cause) {
    if (options.signal.aborted) return interrupted(options);
    return unreachable(options, cause);
  }

  if (answer.kind === "refused") {
    options.out("status: refused");
    options.out(`reason: ${answer.reason}`);
    options.fail(answer.reason);
    return RUN_EXIT.refused;
  }

  options.out(`run: ${answer.run.id}`);
  options.out(
    `results: ${runResultsUrl(config.platform.origin, config.project.id, answer.run.id)}`,
  );
  options.out("status: started");
  return RUN_EXIT.done;
}

/** Cancel one Run in the Project bound in `egma/config.yaml`. */
export async function runCancelCommand(
  options: RunCancelCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) return interrupted(options);

  const runId = options.runId.trim();
  if (runId === "") {
    options.out("status: invalid-run");
    options.fail("Name one Run ID. Nothing was changed.");
    return RUN_EXIT.nothing;
  }

  let config: FolderConfig;
  try {
    config = await readConfig(folderPathsIn(options.cwd).config);
  } catch {
    options.out("status: no-folder");
    options.fail(`There is no valid egma folder in ${options.cwd}. Run egma init here first.`);
    return RUN_EXIT.nothing;
  }
  if (config.project === null) {
    options.out("status: not-bound");
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init here first.");
    return RUN_EXIT.nothing;
  }

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return RUN_EXIT.notSignedIn;
  }

  let answer;
  try {
    answer = await cancelRun(
      signedIn,
      { runId, projectId: config.project.id },
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (wasInterrupted(options.signal)) return interrupted(options);
    return unreachable(options, cause);
  }

  switch (answer.kind) {
    case "not-found":
      options.out("status: no-run");
      options.fail(`Egma has no Run ${runId} in this Project. Nothing was changed.`);
      return RUN_EXIT.nothing;
    case "refused":
      options.out("status: refused");
      options.out(`reason: ${answer.reason}`);
      options.fail(answer.reason);
      return RUN_EXIT.refused;
    case "canceled":
      options.out(`run: ${answer.run.id}`);
      options.out("status: canceled");
      return RUN_EXIT.done;
  }
}

function unreachable(
  options: Pick<FolderCommandOptions, "out" | "fail">,
  cause: unknown,
): number {
  if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
    options.out("status: unreachable");
    options.out(`reason: ${cause.message}`);
    options.fail(cause.message);
    return RUN_EXIT.unreachable;
  }
  throw cause;
}
