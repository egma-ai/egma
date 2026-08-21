/** Resolve one direct suite directory to one exact platform run precondition. */

import {
  RepositoryValidationError,
  readRepository,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { getTestSuite } from "../platform/test-suites.ts";
import { getTestVersion, listTests, type PlatformTest } from "../platform/tests.ts";
import { sameAsPlatform } from "../sync/push.ts";

export type Pinned = {
  readonly testId: string;
  readonly name: string;
  readonly shown: string;
  readonly versionId: string;
};

export type Selection = {
  readonly suiteId: string;
  readonly suiteName: string;
  readonly suiteDirectory: string;
  readonly pinned: readonly Pinned[];
};

export class RunSelectionError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`${issues.join(" ")} Run egma push or egma pull until this suite exactly matches Egma. Nothing was started.`);
    this.name = "RunSelectionError";
    this.issues = issues;
  }
}

export type SelectOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly directory: string;
  readonly fetchImpl?: Fetch;
};

/** A run never guesses identity from a name or path and never runs a subset. */
export async function selectSuiteForRun(options: SelectOptions): Promise<Selection> {
  const repository = await readRepository(options.paths);
  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    throw new RepositoryValidationError([
      "egma/config.yaml does not name a project. Run egma connect here first.",
    ]);
  }
  if (
    options.directory === "" ||
    options.directory === "." ||
    options.directory === ".." ||
    options.directory.includes("/") ||
    options.directory.includes("\\")
  ) {
    throw new RunSelectionError([
      "Choose exactly one direct directory under egma/tests, such as `egma run release`.",
    ]);
  }
  const suite = repository.suites.find((entry) => entry.directory === options.directory);
  if (suite === undefined) {
    throw new RunSelectionError([
      `egma/tests/${options.directory} is not a local suite directory.`,
    ]);
  }

  const remoteSuite = await getTestSuite(
    options.signedIn,
    suite.manifest.id,
    options.fetchImpl,
  );
  if (remoteSuite === null || remoteSuite.projectId !== projectId) {
    throw new RunSelectionError([
      `Suite ${suite.manifest.id} does not exist in this project on Egma.`,
    ]);
  }
  if (remoteSuite.name !== suite.manifest.name) {
    throw new RunSelectionError([
      `The local suite name is ${JSON.stringify(suite.manifest.name)}, but Egma says ${JSON.stringify(remoteSuite.name)}.`,
    ]);
  }

  const remote = await listTests(options.signedIn, {
    projectId,
    suiteId: suite.manifest.id,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const currentByVersion = new Map(remote.map((test) => [test.versionId, test] as const));
  const matchedIds = new Set<string>();
  const pinned: Pinned[] = [];
  const issues: string[] = [];

  for (const file of suite.tests) {
    const pin = file.test.version;
    if (pin === null) {
      issues.push(`${file.shown} has not been pushed.`);
      continue;
    }
    let test: PlatformTest | undefined = currentByVersion.get(pin);
    if (test === undefined) {
      const version = await getTestVersion(options.signedIn, pin, options.fetchImpl);
      if (version !== null && version.suiteId !== suite.manifest.id) {
        issues.push(`${file.shown} belongs to suite ${version.suiteId}; tests cannot move between suites.`);
      } else {
        issues.push(`${file.shown} does not pin the current platform version.`);
      }
      continue;
    }
    if (test.suiteId !== suite.manifest.id) {
      issues.push(`${file.shown} belongs to suite ${test.suiteId}; tests cannot move between suites.`);
      continue;
    }
    if (matchedIds.has(test.id)) {
      issues.push(`Test ${test.id} is represented more than once in egma/tests/${suite.directory}.`);
      continue;
    }
    matchedIds.add(test.id);
    if (file.test.identityRevision !== test.revision || !sameAsPlatform(file.test, test)) {
      issues.push(`${file.shown} does not exactly match Egma.`);
      continue;
    }
    pinned.push({
      testId: test.id,
      name: test.name,
      shown: file.shown,
      versionId: test.versionId,
    });
  }

  for (const test of remote) {
    if (!matchedIds.has(test.id)) {
      issues.push(`Egma test ${JSON.stringify(test.name)} is missing from egma/tests/${suite.directory}.`);
    }
  }
  if (suite.tests.length === 0) {
    issues.push(`egma/tests/${suite.directory} is empty. Add and push a test before you run it.`);
  }
  if (issues.length > 0) throw new RunSelectionError(issues);
  return {
    suiteId: suite.manifest.id,
    suiteName: suite.manifest.name,
    suiteDirectory: suite.directory,
    pinned,
  };
}
