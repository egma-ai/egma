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
import { PushMaterializationError, pushTests, type PushedTest } from "../sync/push.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import type { FolderCommandOptions } from "./folder-verbs.ts";

export const RUN_EXIT = {
  done: 0,
  nothing: 1,
  notSignedIn: 1,
  unreachable: 1,
  refused: 1,
  operational: 1,
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
  if (refusal.agents.length > 0) {
    options.out("Available Agents:");
  }
  for (const agent of refusal.agents) {
    options.out(
      `- ${oneLineFactText(agent.name, "Unnamed")} (${oneLineFactText(agent.id, "unknown Agent ID")})`,
    );
  }
  if (refusal.connections.length > 0) {
    options.out("Available Connections:");
  }
  for (const connection of refusal.connections) {
    options.out(
      `- ${oneLineFactText(connection.name, "Unnamed")} (${oneLineFactText(connection.id, "unknown Connection ID")})`,
    );
  }
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
  options.fail(
    "The command was interrupted before it received a complete answer. Check the Runs page before you try again.",
  );
  return RUN_EXIT.interrupted;
}

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sayAppliedTest(test: PushedTest, out: (line: string) => void): void {
  out(
    `Applied Test ${oneLineFactText(test.name, "Unnamed")} (${oneLineFactText(test.testId, "unknown Test ID")}).`,
  );
  out(`  File: ${oneLineFactText(test.shown, "unknown local file")}`);
  out(`  Version ID: ${oneLineFactText(test.versionId, "unknown Test version ID")}`);
}

function sayStartedRun(
  options: Pick<FolderCommandOptions, "out">,
  config: FolderConfig,
  runId: string,
): void {
  options.out(`Started Run ${oneLineFactText(runId, "unknown Run ID")}.`);
  options.out(
    `View its progress in Egma: ${runResultsUrl(config.platform!.origin, config.project!.id, runId)}`,
  );
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
    if (options.signal.aborted) {
      for (const test of report.tests) sayAppliedTest(test, options.out);
      options.fail(
        "Run creation was interrupted after Egma applied the pre-run push. Returned Test version IDs were saved locally. No Run was created. Run egma run create again when you are ready.",
      );
      return RUN_EXIT.interrupted;
    }
    if (report.turnedAway.length === 0) return null;

    for (const refused of report.turnedAway) {
      options.out(
        `Could not push ${oneLineFactText(refused.name, "Unnamed")}.`,
      );
      options.out(`  File: ${oneLineFactText(refused.shown, "unknown local file")}`);
      options.out(`  ${refused.reason}`);
    }
    options.fail(
      "The complete repository could not be pushed, so no Run was created.",
    );
    return RUN_EXIT.refused;
  } catch (cause) {
    if (cause instanceof PushMaterializationError) {
      for (const test of cause.tests) sayAppliedTest(test, options.out);
      options.fail(
        `Egma applied the pre-run push, but could not refresh ${oneLineFactText(cause.shown, "the local Test file")}. Run egma pull. No Run was created.`,
      );
      if (options.signal.aborted) {
        options.fail("Run creation was interrupted after the pre-run push completed.");
        return RUN_EXIT.interrupted;
      }
      return RUN_EXIT.nothing;
    }
    if (options.signal.aborted) {
      options.fail(
        "Run creation was interrupted during the pre-run push. No Run was created. Run egma pull before you try again.",
      );
      return RUN_EXIT.interrupted;
    }
    if (cause instanceof RepositoryValidationError) {
      options.fail(cause.message);
      return RUN_EXIT.nothing;
    }
    if (cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      options.fail("No Run was created.");
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
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      options.fail(
        `There is no egma/config.yaml in ${oneLineFactText(options.cwd, "this directory")}. Run egma init here first.`,
      );
    } else {
      options.fail(
        cause instanceof Error
          ? cause.message
          : "Egma could not read egma/config.yaml. Fix the file and run this again.",
      );
    }
    return RUN_EXIT.nothing;
  }

  if (config.platform === null || config.project === null) {
    options.fail(
      "egma/config.yaml does not name an Egma platform and Project. Run egma init here first.",
    );
    return RUN_EXIT.nothing;
  }

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
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
        projectId: config.project.id,
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
    options.fail(answer.reason);
    return RUN_EXIT.refused;
  }

  sayStartedRun(options, config, answer.run.id);
  if (options.signal.aborted) {
    options.fail(
      "The command was interrupted after Egma started this Run. The Run is continuing. Use the printed Egma URL to view it, and do not start another Run for the same work.",
    );
    return RUN_EXIT.interrupted;
  }
  return RUN_EXIT.done;
}

/** Cancel one Run in the Project bound in `egma/config.yaml`. */
export async function runCancelCommand(
  options: RunCancelCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) return interrupted(options);

  const runId = options.runId.trim();
  if (runId === "") {
    options.fail("Name one Run ID. Nothing was changed.");
    return RUN_EXIT.nothing;
  }

  let config: FolderConfig;
  try {
    config = await readConfig(folderPathsIn(options.cwd).config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      options.fail(
        `There is no egma/config.yaml in ${oneLineFactText(options.cwd, "this directory")}. Run egma init here first.`,
      );
    } else {
      options.fail(
        cause instanceof Error
          ? cause.message
          : "Egma could not read egma/config.yaml. Fix the file and run this again.",
      );
    }
    return RUN_EXIT.nothing;
  }
  if (config.project === null) {
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init here first.");
    return RUN_EXIT.nothing;
  }

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
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
      options.fail(answer.reason);
      options.fail(
        `Egma has no Run ${oneLineFactText(runId, "with that ID")} in this Project. Nothing was changed.`,
      );
      return RUN_EXIT.nothing;
    case "refused":
      options.fail(answer.reason);
      return RUN_EXIT.refused;
    case "canceled":
      options.out(
        `Canceled Run ${oneLineFactText(answer.run.id, "unknown Run ID")}.`,
      );
      if (wasInterrupted(options.signal)) {
        options.fail(
          "The command was interrupted after Egma canceled this Run. The cancellation is complete. Nothing needs to be retried.",
        );
        return RUN_EXIT.interrupted;
      }
      return RUN_EXIT.done;
  }
}

function unreachable(
  options: Pick<FolderCommandOptions, "out" | "fail">,
  cause: unknown,
): number {
  if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
    options.fail(cause.message);
    return RUN_EXIT.unreachable;
  }
  throw cause;
}
