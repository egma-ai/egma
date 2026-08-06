/**
 * What a run is going to pin, worked out from the folder in front of the
 * developer.
 *
 * A run pins the versions it executes, and the whole value of that is being
 * able to say afterwards exactly what ran. So this resolves each file in the
 * folder to the version egma currently holds for it, and reports the two ways
 * a folder and a platform can disagree:
 *
 * - **egma has never heard of this test.** Nothing can be pinned for it, so the
 *   run is refused rather than started one test short of what the developer is
 *   looking at. `egma push` is the fix and the refusal names it.
 * - **the file says something egma does not hold.** The run happens — what egma
 *   holds is a real, runnable suite — but the difference is named on its own
 *   line, because a run that quietly executed last week's wording of a test the
 *   developer edited this morning would be the exact failure this product
 *   exists to prevent.
 *
 * Neither of those is a merge and neither is a guess. The folder is a working
 * copy and the platform is the versioned store; this only says where the two
 * stand.
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
  /** True when the file in the repository says something else. */
  readonly stale: boolean;
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
};

/** The one sentence a refusal ends on, naming what to do about it. */
export function pushFirstRefusal(unknown: readonly Unpinnable[]): string {
  const names = unknown.map((one) => one.name).join(", ");
  const one = unknown.length === 1;
  return `egma has no test for ${one ? "this file" : "these files"}: ${names}. Run egma push to put ${one ? "it" : "them"} on egma, then run this again. Nothing was started.`;
}

/** The sentence that goes with a file egma will not be executing. */
export function staleWarning(stale: readonly Pinned[]): string {
  const names = stale.map((one) => one.name).join(", ");
  const one = stale.length === 1;
  return `egma will run what it holds, and it is not what ${one ? "this file says" : "these files say"}: ${names}. Run egma push first if you meant your ${one ? "edit" : "edits"}.`;
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
  if (inTheFolder.length === 0) return { pinned: [], unknown: [] };

  const platformTests = await listTests(signedIn, ...extra);
  const resolve = pinsAgainst(signedIn, platformTests, ...extra);
  const byName = new Map(platformTests.map((test) => [test.name, test] as const));
  const byId = new Map(platformTests.map((test) => [test.id, test] as const));

  const pinned: Pinned[] = [];
  const unknown: Unpinnable[] = [];

  const take = (file: FolderTest, test: PlatformTest): void => {
    pinned.push({
      name: test.name,
      shown: file.shown,
      versionId: test.versionId,
      stale: !sameAsPlatform(file.test, test),
    });
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
      // the run pins what is current — with the difference said out loud.
      const test = byId.get(held.testId);
      if (test === undefined) unknown.push({ name: held.testName, shown: file.shown });
      else take(file, test);
      continue;
    }
    unknown.push({ name: file.test.name, shown: file.shown });
  }

  return { pinned, unknown };
}
