/** `egma suite create | delete`: explicit Suite resource commands. */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  RepositoryValidationError,
  folderPathsIn,
  readRepository,
  writeSuiteManifest,
} from "../folder/egma-folder.ts";
import {
  isPortableSuiteDirectory,
  MAX_PORTABLE_COMPONENT_LENGTH,
} from "../folder/portable-path.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import {
  TestSuiteCreationReceiptError,
  createTestSuite,
  deleteTestSuite,
} from "../platform/test-suites.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type SuiteCreateCommandOptions = FolderCommandOptions & {
  /** One direct child of `egma/tests`, never product identity. */
  readonly directory: string;
  /** The mutable product display name written to `suite.yaml`. */
  readonly name: string;
  readonly signal?: AbortSignal;
  /** Filesystem boundary, replaced only by command-level recovery tests. */
  readonly writeManifest?: typeof writeSuiteManifest;
  /** Rollback boundary, replaced only by command-level recovery tests. */
  readonly removeCreatedDirectory?: (directory: string) => Promise<void>;
};

export type SuiteDeleteCommandOptions = FolderCommandOptions & {
  /** One existing direct child of `egma/tests`. */
  readonly directory: string;
  readonly signal: AbortSignal;
  /** Filesystem boundary, replaced only by command-level recovery tests. */
  readonly removeDirectory?: (directory: string) => Promise<void>;
};

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runSuiteCreateCommand(
  options: SuiteCreateCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) {
    options.fail("The command was interrupted before anything changed.");
    return FOLDER_EXIT.interrupted;
  }

  const directory = options.directory.trim();
  const name = options.name.trim();
  if (!isPortableSuiteDirectory(directory)) {
    options.fail(
      `A suite directory must use at most ${String(MAX_PORTABLE_COMPONENT_LENGTH)} lower-case letters, numbers, and hyphens, must not start or end with a hyphen, and must not be a Windows device name.`,
    );
    return FOLDER_EXIT.nothing;
  }
  if (name === "") {
    options.fail("A suite name must contain at least one non-space character.");
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;

  // The complete local repository is checked before any platform write. This
  // makes a malformed old suite a zero-write failure for a new one, while the
  // shared preflight still gives a missing config its exact init recovery.
  let repository;
  try {
    repository = await readRepository(ready.paths);
  } catch (cause) {
    options.fail(
      cause instanceof RepositoryValidationError
        ? cause.message
        : `The Egma repository could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return FOLDER_EXIT.nothing;
  }

  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    options.fail(
      "This repository does not name its Egma Project. Run egma init here first.",
    );
    return FOLDER_EXIT.nothing;
  }

  const root = path.join(ready.paths.tests, directory);
  if (await exists(root)) {
    options.fail(
      `${directory} already exists under egma/tests. Choose another local directory, or pull if the suite already exists on Egma.`,
    );
    return FOLDER_EXIT.nothing;
  }

  let suite;
  try {
    suite = await createTestSuite(
      ready.signedIn,
      { projectId, name },
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (cause instanceof TestSuiteCreationReceiptError) {
      if (cause.suiteId !== null) {
        options.out(
          `Egma may have created remote Suite ${oneLineFactText(cause.suiteId, "with an unreadable ID")}.`,
        );
      }
      options.fail(cause.message);
      options.fail("Run egma pull before you try to create this Suite again.");
      return wasInterrupted(options.signal)
        ? FOLDER_EXIT.interrupted
        : FOLDER_EXIT.localWriteFailed;
    }
    if (wasInterrupted(options.signal)) {
      options.fail(
        "The command was interrupted before Egma returned a complete Suite receipt. Run egma pull before you try again.",
      );
      return FOLDER_EXIT.interrupted;
    }
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      return cause instanceof PlatformRefusedError
        ? FOLDER_EXIT.turnedAway
        : FOLDER_EXIT.unreachable;
    }
    throw cause;
  }

  let createdRoot = false;
  try {
    await mkdir(root);
    createdRoot = true;
    await (options.writeManifest ?? writeSuiteManifest)(path.join(root, "suite.yaml"), {
      id: suite.id,
      name: suite.name,
    });
  } catch (cause) {
    let rollbackFailure: unknown;
    if (createdRoot) {
      // This exact path did not exist before the command and contains only
      // bytes this attempt could have written. Remove all of it on rollback.
      try {
        await (options.removeCreatedDirectory ?? (async (directory: string) => {
          await rm(directory, { recursive: true, force: true });
        }))(root);
      } catch (rollbackCause) {
        rollbackFailure = rollbackCause;
      }
    }
    options.out(
      `Egma created remote Suite ${oneLineFactText(suite.name, "Unnamed")} (${oneLineFactText(suite.id, "unknown Suite ID")}).`,
    );
    const manifestFailure = oneLineFactText(
      cause instanceof Error ? cause.message : String(cause),
      "unknown local write error",
    );
    if (rollbackFailure === undefined) {
      options.fail(
        `Egma created suite ${suite.id}, but could not write egma/tests/${directory}/suite.yaml: ${manifestFailure} Run egma pull to recover this remote-only Suite.`,
      );
    } else {
      const rollbackReason =
        oneLineFactText(
          rollbackFailure instanceof Error
            ? rollbackFailure.message
            : String(rollbackFailure),
          "unknown local cleanup error",
        );
      options.fail(
        `Egma created suite ${suite.id}, but could not write its manifest: ${manifestFailure} egma/tests/${directory} may remain because cleanup failed: ${rollbackReason}`,
      );
      options.fail(
        `Inspect and remove egma/tests/${directory} if it exists, then run egma pull.`,
      );
    }
    if (wasInterrupted(options.signal)) {
      options.fail("The command was interrupted after Egma created this Suite.");
      return FOLDER_EXIT.interrupted;
    }
    return FOLDER_EXIT.localWriteFailed;
  }

  options.out(
    `Created Suite ${oneLineFactText(suite.name, "Unnamed")} (${oneLineFactText(suite.id, "unknown Suite ID")}).`,
  );
  options.out(`Directory: egma/tests/${directory}`);
  if (wasInterrupted(options.signal)) {
    options.fail(
      "The command was interrupted after Egma created this Suite. Its identity is saved in the local Suite manifest. Do not create it again.",
    );
    return FOLDER_EXIT.interrupted;
  }
  return FOLDER_EXIT.done;
}

function interruptedSuiteDelete(options: SuiteDeleteCommandOptions): number {
  options.fail(
    "The command was interrupted before it received a complete answer. The local Suite was left unchanged. Check Egma before you try again.",
  );
  return FOLDER_EXIT.interrupted;
}

async function removeSuiteDirectory(root: string): Promise<void> {
  await rm(root, { recursive: true, force: false });
}

/** Delete one Suite remotely, then remove only its exact local directory. */
export async function runSuiteDeleteCommand(
  options: SuiteDeleteCommandOptions,
): Promise<number> {
  if (options.signal.aborted) return interruptedSuiteDelete(options);

  const directory = options.directory.trim();
  if (directory === "") {
    options.fail("Name one local Suite directory. Nothing was changed.");
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return FOLDER_EXIT.nothing;

  let repository;
  try {
    repository = await readRepository(ready.paths);
  } catch (cause) {
    options.fail(
      cause instanceof RepositoryValidationError
        ? cause.message
        : `The Egma repository could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return FOLDER_EXIT.nothing;
  }

  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    options.fail(
      "This repository does not name its Egma Project. Run egma init here first.",
    );
    return FOLDER_EXIT.nothing;
  }

  const suite = repository.suites.find((entry) => entry.directory === directory);
  if (suite === undefined) {
    options.fail(
      `There is no local Suite directory named ${JSON.stringify(directory)} under egma/tests. Nothing was changed.`,
    );
    return FOLDER_EXIT.nothing;
  }

  try {
    await deleteTestSuite(
      ready.signedIn,
      { projectId, suiteId: suite.manifest.id },
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (options.signal.aborted) return interruptedSuiteDelete(options);
    if (cause instanceof PlatformRefusedError || cause instanceof PlatformUnreachableError) {
      options.fail(cause.message);
      options.fail("The local Suite was left unchanged.");
      return FOLDER_EXIT.nothing;
    }
    throw cause;
  }

  try {
    await (options.removeDirectory ?? removeSuiteDirectory)(suite.root);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      options.out(
        `Egma deleted remote Suite ${oneLineFactText(suite.manifest.name, "Unnamed")} (${oneLineFactText(suite.manifest.id, "unknown Suite ID")}).`,
      );
      options.fail(
        `Egma deleted Suite ${oneLineFactText(suite.manifest.id, "with an unknown ID")}, but the local directory ${oneLineFactText(suite.root, "with an unreadable path")} remains: ${oneLineFactText(cause instanceof Error ? cause.message : String(cause), "unknown local cleanup error")} Remove that exact directory before the next push.`,
      );
      if (options.signal.aborted) {
        options.fail("The command was interrupted after Egma deleted this Suite.");
        return FOLDER_EXIT.interrupted;
      }
      return FOLDER_EXIT.nothing;
    }
  }

  options.out(
    `Deleted Suite ${oneLineFactText(suite.manifest.name, "Unnamed")} (${oneLineFactText(suite.manifest.id, "unknown Suite ID")}).`,
  );
  options.out(`Removed local directory egma/tests/${directory}.`);
  if (options.signal.aborted) {
    options.fail(
      "The command was interrupted after Egma deleted this Suite. The exact local Suite directory was also removed. Nothing needs to be retried.",
    );
    return FOLDER_EXIT.interrupted;
  }
  return FOLDER_EXIT.done;
}
