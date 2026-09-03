/** `egma suite create`: create stable suite identity before local authoring. */

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
import { createTestSuite } from "../platform/test-suites.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type SuiteCreateCommandOptions = FolderCommandOptions & {
  /** One direct child of `egma/tests`, never product identity. */
  readonly directory: string;
  /** The mutable product display name written to `suite.yaml`. */
  readonly name: string;
  /** Filesystem boundary, replaced only by command-level recovery tests. */
  readonly writeManifest?: typeof writeSuiteManifest;
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

export async function runSuiteCreateCommand(
  options: SuiteCreateCommandOptions,
): Promise<number> {
  const directory = options.directory.trim();
  const name = options.name.trim();
  if (!isPortableSuiteDirectory(directory)) {
    options.out("status: invalid-directory");
    options.fail(
      `A suite directory must use at most ${String(MAX_PORTABLE_COMPONENT_LENGTH)} lower-case letters, numbers, and hyphens, must not start or end with a hyphen, and must not be a Windows device name.`,
    );
    return FOLDER_EXIT.nothing;
  }
  if (name === "") {
    options.out("status: invalid-name");
    options.fail("A suite name must contain at least one non-space character.");
    return FOLDER_EXIT.nothing;
  }

  // The complete local repository is the first authority consulted. This is
  // what makes a malformed old suite a zero-write failure for a new one.
  let repository;
  try {
    const paths = folderPathsIn(options.cwd);
    repository = await readRepository(paths);
  } catch (cause) {
    options.out("status: invalid-repository");
    options.fail(
      cause instanceof RepositoryValidationError
        ? cause.message
        : `The Egma repository could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    options.out("status: no-project");
    options.fail(
      "This repository does not name its Egma Project. Run egma init here first.",
    );
    return FOLDER_EXIT.nothing;
  }

  const root = path.join(ready.paths.tests, directory);
  if (await exists(root)) {
    options.out("status: already-there");
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
    );
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.out(`status: ${cause instanceof PlatformRefusedError ? "refused" : "unreachable"}`);
      options.fail(cause.message);
      return cause instanceof PlatformRefusedError
        ? FOLDER_EXIT.turnedAway
        : FOLDER_EXIT.unreachable;
    }
    throw cause;
  }

  // Print identity before touching disk. If the local write fails, this is the
  // handle the developer and support logs keep, and pull can recover it.
  options.out(`suite: ${suite.id}`);
  options.out(`name: ${suite.name}`);

  let createdRoot = false;
  try {
    await mkdir(root);
    createdRoot = true;
    await (options.writeManifest ?? writeSuiteManifest)(path.join(root, "suite.yaml"), {
      id: suite.id,
      name: suite.name,
    });
  } catch (cause) {
    if (createdRoot) {
      // This exact path did not exist before the command and contains only
      // bytes this attempt could have written. Remove all of it on rollback.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    options.out("status: local-write-failed");
    options.fail(
      `Egma created suite ${suite.id}, but could not write egma/tests/${directory}/suite.yaml: ${cause instanceof Error ? cause.message : String(cause)} Pull to recover this remote-only suite.`,
    );
    return FOLDER_EXIT.localWriteFailed;
  }

  options.out(`directory: ${directory}`);
  options.out("status: created");
  return FOLDER_EXIT.done;
}
