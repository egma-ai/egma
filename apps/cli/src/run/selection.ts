/**
 * What a run is going to pin, worked out from the folder in front of the
 * developer.
 *
 * A run pins the versions it executes, and the whole value of that is being
 * able to say afterwards exactly what ran. So this resolves each file in the
 * folder to the version egma currently holds for it, and reports the two ways
 * a folder and a platform can disagree — **both of which refuse the run**:
 *
 * - **egma has never heard of this test.** Nothing can be pinned for it, so the
 *   run is refused rather than started one test short of what the developer is
 *   looking at. `egma push` is the fix and the refusal names it.
 * - **the file says something egma does not hold.** The run is refused for the
 *   same reason, and this is the deliberate change: it used to warn and run.
 *   A developer who edited a test this morning and forgot to push would have
 *   read green over a warning line, and reported an edit verified that never
 *   ran. Trust in what ran is the whole product, so a divergence is a door
 *   rather than a note. `egma push` is the fix and the refusal names it.
 *
 * **The comparison is content, field by field, and never a version number.**
 * Numbers agree while content differs precisely when a local edit was not
 * pushed — which is the case this gate exists for — so a number is the one
 * thing that cannot answer the question.
 *
 * Neither refusal is a merge and neither is a guess. The folder is a working
 * copy and the platform is the versioned store; this only says where the two
 * stand, and refuses to run while they stand apart.
 */

import type { FolderPaths, FolderTest } from "../folder/egma-folder.ts";
import { readFolderTests } from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { listTests, type PlatformTest } from "../platform/tests.ts";
import { pinsAgainst } from "../sync/pins.ts";
import { sameAsPlatform } from "../sync/push.ts";

/** One test the run will execute, and the version it will pin. */
export type Pinned = {
  readonly name: string;
  /** `egma/tests/…`, as every report says a path. */
  readonly shown: string;
  /** The version egma currently holds — what the run executes. */
  readonly versionId: string;
};

/** One test the run cannot pin, and why. */
export type Unpinnable = {
  readonly name: string;
  readonly shown: string;
};

export type Selection = {
  readonly pinned: readonly Pinned[];
  /** Files egma has no test for. A run with any of these is refused. */
  readonly unknown: readonly Unpinnable[];
  /**
   * Files that say something other than what egma holds. A run with any of
   * these is refused too, and for the harder reason: the test is real and a run
   * would look completely ordinary, right up to a green result about content
   * nobody executed.
   */
  readonly diverged: readonly Unpinnable[];
};

/** The one sentence a refusal ends on, naming what to do about it. */
export function pushFirstRefusal(unknown: readonly Unpinnable[]): string {
  const names = unknown.map((one) => one.name).join(", ");
  const one = unknown.length === 1;
  return `egma has no test for ${one ? "this file" : "these files"}: ${names}. Run egma push to put ${one ? "it" : "them"} on egma, then run this again. Nothing was started.`;
}

/**
 * The refusal for a file that says something egma does not hold.
 *
 * It names the push, because the push is the whole of the fix: what the
 * developer wants run is in their repository, and one verb puts it where a run
 * can pin it. Nothing was started, and it says so — a refusal a reader could
 * mistake for a run that half-happened is worse than no refusal at all.
 */
export function pushEditsRefusal(diverged: readonly Unpinnable[]): string {
  const names = diverged.map((one) => one.name).join(", ");
  const one = diverged.length === 1;
  return `egma holds something other than what ${one ? "this file says" : "these files say"}: ${names}. Run egma push to put your ${one ? "edit" : "edits"} on egma, then run this again. Nothing was started.`;
}

export type SelectOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
};

/**
 * Every test in the folder, resolved to the version a run would pin for it.
 *
 * A file that pins a version is resolved through the pin, because the pin is
 * what says which test this file is a draft of even after somebody renamed it.
 * A file that pins nothing has never been synced, so the only thing it can be
 * matched by is its name.
 */
export async function selectFromFolder(options: SelectOptions): Promise<Selection> {
  const { signedIn, paths, fetchImpl } = options;
  const extra = fetchImpl === undefined ? [] : ([fetchImpl] as const);

  const inTheFolder = await readFolderTests(paths);
  if (inTheFolder.length === 0) return { pinned: [], unknown: [], diverged: [] };

  const platformTests = await listTests(signedIn, ...extra);
  const resolve = pinsAgainst(signedIn, platformTests, ...extra);
  const byName = new Map(platformTests.map((test) => [test.name, test] as const));
  const byId = new Map(platformTests.map((test) => [test.id, test] as const));

  const pinned: Pinned[] = [];
  const unknown: Unpinnable[] = [];
  const diverged: Unpinnable[] = [];

  /**
   * One file, placed against the test egma holds for it.
   *
   * The whole of the gate is here: content, field by field. A file that says
   * what egma holds is pinned; a file that says anything else is named as a
   * divergence and nothing is pinned for it, because there is no version of
   * what it says for a run to execute.
   */
  const take = (file: FolderTest, test: PlatformTest): void => {
    if (!sameAsPlatform(file.test, test)) {
      diverged.push({ name: test.name, shown: file.shown });
      return;
    }
    pinned.push({ name: test.name, shown: file.shown, versionId: test.versionId });
  };

  for (const file of inTheFolder) {
    const pin = file.test.version;
    if (pin === null) {
      const named = byName.get(file.test.name);
      if (named === undefined) unknown.push({ name: file.test.name, shown: file.shown });
      else take(file, named);
      continue;
    }

    const held = await resolve(pin);
    if (held.kind === "current") {
      take(file, held.test);
      continue;
    }
    if (held.kind === "behind") {
      // The pin is a version this test has moved past, so the test is real and
      // what is current is what a run could pin. Whether it may is still the
      // content question and not this one: a file left behind by somebody
      // else's edit says something egma does not hold, and `take` refuses it.
      const test = byId.get(held.testId);
      if (test === undefined) unknown.push({ name: held.testName, shown: file.shown });
      else take(file, test);
      continue;
    }
    unknown.push({ name: file.test.name, shown: file.shown });
  }

  return { pinned, unknown, diverged };
}
