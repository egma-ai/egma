/**
 * `push`: the folder's tests, uploaded, on git's terms.
 *
 * Every file carries the version it was last synced at. Before anything is
 * uploaded, each pin is compared with what the platform currently has, and a
 * single test that has moved refuses the whole push and names the tests that
 * moved. Nothing is merged, because there is no merge that could be right: a
 * teammate editing a test in the dashboard and a developer editing the same test
 * in a file are two people saying different things, and a heuristic that picked
 * one would be egma deciding which of them was wrong.
 *
 * A refusal costs the developer one `pull` and one look. Silently losing either
 * side's work costs them their trust in the tool, which is the thing this whole
 * product is for.
 *
 * A push that gets past the check writes each file back from what the platform
 * stored, pin and all. That is what makes a `pull` straight afterwards find
 * nothing to do: the bytes in the working tree are computed from the platform's
 * answer, not from what was sent to it.
 */

import type { TestFile } from "../folder/test-file.ts";
import {
  readFolderTests,
  writeTestFile,
  type FolderPaths,
  type FolderTest,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import {
  createTest,
  editTest,
  listTests,
  type PlatformTest,
  type TestInput,
} from "../platform/tests.ts";
import { pinsAgainst } from "./pins.ts";
import { fileFromPlatform } from "./pull.ts";

/** A test the push will not touch, and why. */
export type PushConflict = {
  readonly name: string;
  readonly shown: string;
  readonly reason:
    /** Somebody edited this test on the platform since this file was synced. */
    | "moved"
    /** This egma has never issued the version the file is pinned to. */
    | "unknown";
};

export type PushedTest = {
  readonly name: string;
  readonly shown: string;
  readonly versionId: string;
  readonly state: "created" | "updated" | "unchanged";
};

/** A test the platform would not accept, in the platform's own words. */
export type TurnedAway = {
  readonly name: string;
  readonly shown: string;
  readonly reason: string;
};

export type PushReport = {
  readonly conflicts: readonly PushConflict[];
  /** True when the conflicts were all found before anything was uploaded. */
  readonly uploadedNothing: boolean;
  readonly tests: readonly PushedTest[];
  readonly turnedAway: readonly TurnedAway[];
};

export type PushOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
};

function inputFrom(test: TestFile): TestInput {
  return {
    name: test.name,
    scenario: test.scenario,
    expectedBehaviors: test.expectedBehaviors,
    personas: test.personas,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Whether the file says exactly what the platform already holds. Order is
 * content in both lists: an expected behaviors list is one a reader goes down,
 * and personas are named in the order they were authored.
 */
function sameAsPlatform(file: TestFile, test: PlatformTest): boolean {
  return (
    file.name === test.name &&
    file.scenario === test.scenario &&
    sameList(file.expectedBehaviors, test.expectedBehaviors) &&
    sameList(file.personas, test.personas)
  );
}

/** What a push has decided to do about one file, before it does any of it. */
type Plan =
  | { readonly kind: "create"; readonly file: FolderTest }
  | { readonly kind: "edit"; readonly file: FolderTest; readonly test: PlatformTest }
  | { readonly kind: "settled"; readonly file: FolderTest; readonly test: PlatformTest };

export async function pushTests(options: PushOptions): Promise<PushReport> {
  const { signedIn, paths, fetchImpl } = options;
  const extra = fetchImpl === undefined ? [] : ([fetchImpl] as const);

  const held = await readFolderTests(paths);
  if (held.length === 0) {
    return { conflicts: [], uploadedNothing: true, tests: [], turnedAway: [] };
  }

  const platformTests = await listTests(signedIn, ...extra);
  const resolve = pinsAgainst(signedIn, platformTests, ...extra);

  // Everything is decided before anything is uploaded, so a push that is going
  // to be refused is refused with the folder and the platform both untouched.
  const conflicts: PushConflict[] = [];
  const plans: Plan[] = [];

  for (const file of held) {
    const pin = file.test.version;
    if (pin === null) {
      plans.push({ kind: "create", file });
      continue;
    }

    const pinned = await resolve(pin);
    if (pinned.kind === "unknown") {
      conflicts.push({ name: file.test.name, shown: file.shown, reason: "unknown" });
      continue;
    }
    if (pinned.kind === "behind") {
      conflicts.push({ name: pinned.testName, shown: file.shown, reason: "moved" });
      continue;
    }

    plans.push(
      sameAsPlatform(file.test, pinned.test)
        ? { kind: "settled", file, test: pinned.test }
        : { kind: "edit", file, test: pinned.test },
    );
  }

  if (conflicts.length > 0) {
    return { conflicts, uploadedNothing: true, tests: [], turnedAway: [] };
  }

  const pushed: PushedTest[] = [];
  const turnedAway: TurnedAway[] = [];
  const lateConflicts: PushConflict[] = [];

  for (const plan of plans) {
    if (plan.kind === "settled") {
      // Nothing to upload, and the file is still rewritten from what the
      // platform holds — a file somebody hand-formatted says the same thing in
      // different bytes, and leaving those bytes would make the next pull look
      // like work.
      await writeTestFile(plan.file.file, fileFromPlatform(plan.test));
      pushed.push({
        name: plan.test.name,
        shown: plan.file.shown,
        versionId: plan.test.versionId,
        state: "unchanged",
      });
      continue;
    }

    const input = inputFrom(plan.file.test);
    const answer =
      plan.kind === "create"
        ? await createTest(signedIn, input, ...extra)
        : await editTest(signedIn, plan.test.id, plan.test.versionId, input, ...extra);

    switch (answer.kind) {
      case "written": {
        await writeTestFile(plan.file.file, fileFromPlatform(answer.test));
        pushed.push({
          name: answer.test.name,
          shown: plan.file.shown,
          versionId: answer.test.versionId,
          state: plan.kind === "create" ? "created" : "updated",
        });
        break;
      }
      case "moved":
        // Somebody edited it between the check above and this write. The door
        // is the platform's and it held, which is the point of sending the
        // version this edit was written against.
        lateConflicts.push({
          name: answer.testName === "" ? plan.file.test.name : answer.testName,
          shown: plan.file.shown,
          reason: "moved",
        });
        break;
      case "turned-away":
        turnedAway.push({
          name: plan.file.test.name,
          shown: plan.file.shown,
          reason: answer.reason,
        });
        break;
    }
  }

  return {
    conflicts: lateConflicts,
    uploadedNothing: false,
    tests: pushed,
    turnedAway,
  };
}
