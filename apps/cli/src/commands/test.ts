/** `egma test delete`: delete one Test named by its local Markdown file. */

import { unlink } from "node:fs/promises";
import path from "node:path";

import {
  RepositoryValidationError,
  readRepository,
  type FolderPaths,
  type FolderTest,
  type RepositoryContents,
} from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { deleteTest, getProjectTestVersion } from "../platform/tests.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type TestDeleteCommandOptions = FolderCommandOptions & {
  /** An absolute, repository-relative, or `egma/tests`-relative Markdown path. */
  readonly file: string;
  readonly signal: AbortSignal;
  /** Filesystem boundary, replaced only by command-level recovery tests. */
  readonly removeFile?: (file: string) => Promise<void>;
};

function interrupted(options: TestDeleteCommandOptions): number {
  options.fail(
    "The command was interrupted before it received a complete answer. The local Test was left unchanged. Check Egma before you try again.",
  );
  return FOLDER_EXIT.interrupted;
}

function localTestNamed(
  repository: RepositoryContents,
  paths: FolderPaths,
  cwd: string,
  written: string,
): FolderTest | null {
  const candidates = new Set([
    path.resolve(cwd, written),
    path.resolve(paths.tests, written),
  ]);
  return (
    repository.suites
      .flatMap((suite) => suite.tests)
      .find((test) => candidates.has(path.resolve(test.file))) ?? null
  );
}

/** Delete one Test remotely, then remove only its exact local Markdown file. */
export async function runTestDeleteCommand(
  options: TestDeleteCommandOptions,
): Promise<number> {
  if (options.signal.aborted) return interrupted(options);

  const written = options.file.trim();
  if (written === "") {
    options.fail("Name one local Test Markdown file. Nothing was changed.");
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return FOLDER_EXIT.nothing;

  let repository: RepositoryContents;
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

  const local = localTestNamed(repository, ready.paths, options.cwd, written);
  if (local === null) {
    options.fail(
      `There is no local Test Markdown file at ${JSON.stringify(written)} under this repository's egma/tests folder. Nothing was changed.`,
    );
    return FOLDER_EXIT.nothing;
  }

  const versionId = local.test.version?.trim() ?? "";
  if (versionId === "") {
    options.fail(
      `${oneLineFactText(local.shown, "This local Test")} has not been pushed, so it has no remote Test to delete. The local file was left unchanged. Remove the draft directly.`,
    );
    return FOLDER_EXIT.nothing;
  }
  const identityRevision = local.test.identityRevision?.trim() ?? "";
  if (identityRevision === "") {
    options.fail(
      `${oneLineFactText(local.shown, "This local Test")} has a remote version but no identity_revision. The local file was left unchanged. Pull before deciding what to delete.`,
    );
    return FOLDER_EXIT.nothing;
  }

  let remote;
  try {
    remote = await getProjectTestVersion(
      ready.signedIn,
      { projectId, versionId },
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (options.signal.aborted) return interrupted(options);
    if (cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      options.fail("The local Test was left unchanged.");
      if (cause.status === 409) {
        options.fail("Pull before deciding what to delete.");
      }
      return FOLDER_EXIT.nothing;
    }
    if (cause instanceof PlatformUnreachableError) {
      options.fail(cause.message);
      options.fail("The local Test was left unchanged.");
      return FOLDER_EXIT.nothing;
    }
    throw cause;
  }

  if (remote.kind === "not-found") {
    options.fail(remote.reason);
    options.fail(
      `Egma could not find Test version ${oneLineFactText(versionId, "with an unknown ID")}. The local Test was left unchanged. Pull before deciding what to delete.`,
    );
    return FOLDER_EXIT.nothing;
  }
  const remoteVersion = remote.version;
  if (
    remoteVersion.id !== versionId ||
    remoteVersion.suiteId !== local.suiteId ||
    !remoteVersion.current
  ) {
    options.fail(
      `Egma did not resolve ${oneLineFactText(versionId, "that Test version")} to the current Test in the Suite recorded beside ${oneLineFactText(local.shown, "the local Test")}. The local Test was left unchanged. Pull before deciding what to delete.`,
    );
    return FOLDER_EXIT.nothing;
  }

  try {
    await deleteTest(
      ready.signedIn,
      {
        projectId,
        testId: remoteVersion.testId,
        expectedVersionId: versionId,
        expectedRevision: identityRevision,
      },
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (options.signal.aborted) return interrupted(options);
    if (cause instanceof PlatformRefusedError || cause instanceof PlatformUnreachableError) {
      options.fail(cause.message);
      options.fail("The local Test was left unchanged.");
      if (cause instanceof PlatformRefusedError && cause.status === 409) {
        options.fail("Pull before deciding what to delete.");
      }
      return FOLDER_EXIT.nothing;
    }
    throw cause;
  }

  try {
    await (options.removeFile ?? unlink)(local.file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      options.out(
        `Egma deleted remote Test ${oneLineFactText(local.test.name, "Unnamed")} (${oneLineFactText(remoteVersion.testId, "unknown Test ID")}).`,
      );
      options.fail(
        `Egma deleted Test ${oneLineFactText(remoteVersion.testId, "with an unknown ID")}, but the local file ${oneLineFactText(local.file, "with an unreadable path")} remains: ${oneLineFactText(cause instanceof Error ? cause.message : String(cause), "unknown local cleanup error")} Remove that exact file before the next push.`,
      );
      if (options.signal.aborted) {
        options.fail("The command was interrupted after Egma deleted this Test.");
        return FOLDER_EXIT.interrupted;
      }
      return FOLDER_EXIT.nothing;
    }
  }

  options.out(
    `Deleted Test ${oneLineFactText(local.test.name, "Unnamed")} (${oneLineFactText(remoteVersion.testId, "unknown Test ID")}).`,
  );
  options.out(
    `Removed local file ${oneLineFactText(local.shown, "with an unreadable path")}.`,
  );
  if (options.signal.aborted) {
    options.fail(
      "The command was interrupted after Egma deleted this Test. The exact local Markdown file was also removed. Nothing needs to be retried.",
    );
    return FOLDER_EXIT.interrupted;
  }
  return FOLDER_EXIT.done;
}
