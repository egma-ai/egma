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
 *
 * **What it pulls is what applies to the agent this repository is bound to.**
 * One folder, one agent: which agents a test applies to is a set the browser
 * owns, and a folder that tried to hold the whole set would be a second source
 * of truth for links it cannot see. A test whose link is taken away in the
 * browser stops arriving, and the file it left behind stays exactly where it
 * is — because it is still the developer's file, and deleting somebody's work
 * over a link edit is not a thing a sync verb gets to do.
 *
 * **It is also where an old file becomes a new one, when that is safe.** A file
 * pinned to a version but carrying no identity revision cannot update a test —
 * it has nothing to say about the live half, so it could overwrite a rename
 * without noticing. A pull rewrites it in the current format, but only when the
 * file is a faithful copy of the version it pins and the name still matches
 * what the platform holds. Anything else is a draft somebody is in the middle
 * of, and it is left alone with the recovery said out loud.
 */

import path from "node:path";

import {
  fileNameFor,
  TEST_FILE_FORMAT,
  type ExpectedBehavior,
  type FileBehavior,
  type FilePersona,
  type TestFile,
} from "../folder/test-file.ts";
import { sameMockTools } from "../folder/mock-tools.ts";
import {
  readConfig,
  readFolder,
  writeTestFile,
  type FolderPaths,
  type FolderTest,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import {
  listTests,
  type PlatformContent,
  type PlatformTest,
} from "../platform/tests.ts";
import { pinsAgainst, type Pinned } from "./pins.ts";
import { keptUnmigrated } from "./refusals.ts";

/** One test after a pull, and whether the file it lives in moved. */
export type PulledTest = {
  readonly name: string;
  /** `egma/tests/…`, so every report says a path the same way. */
  readonly shown: string;
  readonly versionId: string;
  readonly state: "written" | "unchanged";
};

/** A file a pull would have rewritten in the current format and did not. */
export type KeptDraft = {
  readonly name: string;
  readonly shown: string;
  /** What to do about it, in one sentence. */
  readonly reason: string;
};

export type PullReport = {
  readonly tests: readonly PulledTest[];
  /** Files the platform has nothing for, left exactly as they are. */
  readonly kept: readonly string[];
  /** Old files a pull could not safely migrate, left exactly as they are. */
  readonly drafts: readonly KeptDraft[];
};

export type PullOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
};

/** The file a platform test should be written into, as it now stands. */
export function fileFromPlatform(test: PlatformTest): TestFile {
  return {
    // Said out loud even though the serializer decides it: this value is a
    // `TestFile`, and a `TestFile` that claimed a shape nothing writes would be
    // a value nobody could compare against what came off disk.
    format: TEST_FILE_FORMAT,
    name: test.name,
    description: test.description === "" ? null : test.description,
    personas: test.personas,
    version: test.versionId,
    identityRevision: test.revision,
    requiredCapabilities: test.requiredCapabilities,
    scenario: test.scenario,
    expectedBehaviors: test.expectedBehaviors,
    mockTools: test.mockTools,
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

/**
 * Whether the file's list says what the pinned version says.
 *
 * **There is no companion comparing priorities, and there was.** It refused a
 * pull with *a priority written into it is not the one egma holds*, so that a
 * `[P1]` somebody had typed into an old file was kept rather than overwritten.
 * The ladder retired: a marker is stripped on the way in and written on the way
 * out by nothing, so there is no claim left for a file to make and no edit left
 * to protect. A format 2 file whose sentences match is a faithful copy, and the
 * pull rewrites it into format 3 — which is what a format change looks like.
 */
function sameStatements(
  file: readonly FileBehavior[],
  version: readonly ExpectedBehavior[],
): boolean {
  return (
    file.length === version.length &&
    file.every((one, index) => one === version[index])
  );
}

function sameNames(
  file: readonly FilePersona[],
  version: readonly FilePersona[],
): boolean {
  return (
    file.length === version.length &&
    file.every((one, index) => one.name === version[index]?.name)
  );
}

/**
 * Whether an old file is a faithful copy of the version it pins, or a draft.
 *
 * **Only what the file actually recorded is compared.** A version-1 file had no
 * way to write a grader, a required capability or a description down, so those
 * cannot be a difference this file is responsible for and holding it to them
 * would refuse to migrate a folder nobody had touched. Everything the file
 * *did* say is compared exactly, order included, because that is where a local
 * draft would be. A priority marker is not among the things compared: it is
 * stripped on the way in and nothing writes one, so a file carrying markers and
 * the right sentences is a faithful copy that this pull rewrites into format 3.
 *
 * Personas are compared by the display name, which is all an old file has. A
 * persona renamed in the browser therefore reads as a difference, and is the
 * one honest false alarm here: the file does name somebody the platform no
 * longer answers to, and a push of it would be refused for exactly that.
 */
function faithfulCopy(file: TestFile, pinned: PlatformContent): string | null {
  if (file.scenario !== pinned.scenario) return "its scenario has been edited since";
  if (!sameStatements(file.expectedBehaviors, pinned.expectedBehaviors)) {
    return "its expected behaviors have been edited since";
  }
  if (!sameNames(file.personas, pinned.personas)) {
    return "the personas it names have changed since";
  }
  if (!sameMockTools(file.mockTools, pinned.mockTools)) {
    return "the mock tools it overrides have changed since";
  }
  return null;
}

/** The content the pin names, whichever way the pin resolved. */
function pinnedContent(pinned: Pinned): PlatformContent | null {
  if (pinned.kind === "current") return pinned.test;
  if (pinned.kind === "behind" || pinned.kind === "elsewhere") return pinned.version;
  return null;
}

export async function pullTests(options: PullOptions): Promise<PullReport> {
  const { signedIn, paths, fetchImpl } = options;
  // The agent this folder is bound to. It is the whole of what this repository
  // can see: a folder bound to nothing sees everything, which is what a folder
  // nobody has connected yet is looking at.
  const boundAgentId = (await readConfig(paths.config)).agent?.id ?? null;
  const platformTests = await listTests(signedIn, {
    agentId: boundAgentId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
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
  const drafts: KeptDraft[] = [];
  for (const file of held) {
    const pin = file.test.version;
    if (pin === null) {
      kept.push(file.test.name);
      continue;
    }
    const pinned = await resolve(pin);
    // `elsewhere` is a test the browser has unlinked from this repository's
    // agent. The file stays, untouched and unclaimed — a pull never deletes,
    // and there is nothing on this repository's side of the platform to write
    // through it.
    const mine =
      pinned.kind === "current"
        ? { id: pinned.test.id, liveName: pinned.test.name }
        : pinned.kind === "behind"
          ? { id: pinned.testId, liveName: pinned.testName }
          : null;
    if (mine === null || fileOf.has(mine.id)) {
      kept.push(file.test.name);
      continue;
    }

    // An old file may be rewritten in the current format only when it is a
    // faithful copy of the version it pins and the platform still calls the
    // test what the file calls it. Either difference could have come from
    // either side, and egma does not guess.
    if (file.test.identityRevision === null) {
      const content = pinnedContent(pinned);
      const drifted =
        content === null
          ? "Egma no longer holds the version it pins"
          : (faithfulCopy(file.test, content) ??
            (file.test.name === mine.liveName
              ? null
              : "the test has been renamed on one side or the other"));
      if (drifted !== null) {
        drafts.push({
          name: file.test.name,
          shown: file.shown,
          reason: keptUnmigrated(file.shown, drifted),
        });
        continue;
      }
    }

    fileOf.set(mine.id, file);
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

  return { tests: pulled, kept, drafts };
}
