/**
 * `pull`: the platform's current versions, written into the folder.
 *
 * Sync is a verb a developer runs and never a background process. Two authoring
 * surfaces that sync themselves is the documented way this goes wrong, so
 * nothing here happens unless somebody asked for it.
 *
 * What a pull is allowed to touch is narrow on purpose. It writes the files that
 * are pinned to tests the platform has, and it creates a file for a test the
 * folder does not have yet. It never deletes, and it never touches a file that
 * is not a copy of something on the platform — a test somebody is drafting and
 * has not pushed is theirs, and a pull that removed it would make the folder
 * unsafe to work in.
 */

import path from "node:path";

import {
  fileNameFor,
  type TestFile,
} from "../folder/test-file.ts";
import {
  readFolder,
  writeTestFile,
  type FolderPaths,
  type FolderTest,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { listTests, type PlatformTest } from "../platform/tests.ts";
import { pinsAgainst } from "./pins.ts";

/** One test after a pull, and whether the file it lives in moved. */
export type PulledTest = {
  readonly name: string;
  /** `egma/tests/…`, so every report says a path the same way. */
  readonly shown: string;
  readonly versionId: string;
  readonly state: "written" | "unchanged";
};

export type PullReport = {
  readonly tests: readonly PulledTest[];
  /** Files the platform has nothing for, left exactly as they are. */
  readonly kept: readonly string[];
};

export type PullOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
};

/** The file a platform test should be written into, as it now stands. */
export function fileFromPlatform(test: PlatformTest): TestFile {
  return {
    name: test.name,
    personas: test.personas,
    version: test.versionId,
    scenario: test.scenario,
    expectedBehaviors: test.expectedBehaviors,
  };
}

/**
 * A file name for a test the folder has never held, that is not already taken.
 *
 * Never taken, not even by a file egma did not write: a draft called
 * `after-hours-emergency.md` that nobody has pushed is somebody's work, and a
 * pull that landed a platform test on top of it would destroy it silently.
 */
function freeFileName(name: string, taken: Set<string>): string {
  const wanted = fileNameFor(name);
  if (!taken.has(wanted)) {
    taken.add(wanted);
    return wanted;
  }
  const stem = wanted.slice(0, -".md".length);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}.md`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export async function pullTests(options: PullOptions): Promise<PullReport> {
  const { signedIn, paths, fetchImpl } = options;
  const platformTests = await listTests(
    signedIn,
    ...(fetchImpl === undefined ? [] : ([fetchImpl] as const)),
  );
  const folder = await readFolder(paths);
  const held = folder.found;
  const resolve = pinsAgainst(
    signedIn,
    platformTests,
    ...(fetchImpl === undefined ? [] : ([fetchImpl] as const)),
  );

  // Which file each platform test already lives in. A pin is the only thing
  // that says so: names are not unique on the platform and a file can be
  // renamed, so nothing else here would be safe to write through.
  const fileOf = new Map<string, FolderTest>();
  const kept: string[] = [];
  for (const file of held) {
    const pin = file.test.version;
    if (pin === null) {
      kept.push(file.test.name);
      continue;
    }
    const pinned = await resolve(pin);
    const testId =
      pinned.kind === "current"
        ? pinned.test.id
        : pinned.kind === "behind"
          ? pinned.testId
          : null;
    if (testId === null || fileOf.has(testId)) {
      kept.push(file.test.name);
      continue;
    }
    fileOf.set(testId, file);
  }

  // Every `.md` name the folder already holds, including a file egma could not
  // read: a pull that landed a platform test on top of somebody's broken draft
  // would destroy the one file they most need to look at.
  const taken = new Set(
    [...held, ...folder.unreadable].map((file) => path.basename(file.file)),
  );
  const pulled: PulledTest[] = [];

  // Oldest first, so a folder being filled for the first time is named in the
  // order the tests were authored and two runs agree with each other.
  const inMintOrder = [...platformTests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const test of inMintOrder) {
    const already = fileOf.get(test.id);
    const name = already?.shown ?? `egma/tests/${freeFileName(test.name, taken)}`;
    const file = already?.file ?? path.join(paths.tests, path.basename(name));

    const { changed } = await writeTestFile(file, fileFromPlatform(test));
    pulled.push({
      name: test.name,
      shown: name,
      versionId: test.versionId,
      state: changed ? "written" : "unchanged",
    });
  }

  return { tests: pulled, kept };
}
