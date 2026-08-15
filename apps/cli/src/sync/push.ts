/**
 * `push`: the folder's tests, uploaded, on git's terms.
 *
 * Every file carries what it was last synced at: the content version a run
 * would be judged by, and the revision of the live half beside it. Before
 * anything is uploaded, every readable file is held against what the platform
 * currently has, and a single file that cannot be written refuses the whole
 * push and names it. Nothing is merged, because there is no merge that could be
 * right: a teammate editing a test in the dashboard and a developer editing the
 * same test in a file are two people saying different things, and a heuristic
 * that picked one would be egma deciding which of them was wrong.
 *
 * A refusal costs the developer one `pull` and one look. Silently losing either
 * side's work costs them their trust in the tool, which is the thing this whole
 * product is for.
 *
 * **Four things refuse a file, and they are four different problems.** The
 * content has moved on, so a pull is owed. The live half has moved on, so a
 * rename would have been lost. The file is in a format that cannot say what a
 * write has to say, so a pull has to migrate it first. And the browser has
 * unlinked the test from the agent this repository is bound to, so this folder
 * is no longer entitled to write it at all — the only one of the four a pull
 * cannot fix, which is why it is the one reported when more than one applies.
 *
 * A push that gets past the check writes each file back from what the platform
 * stored, both tokens and all. That is what makes a `pull` straight afterwards
 * find nothing to do: the bytes in the working tree are computed from the
 * platform's answer, not from what was sent to it.
 *
 * **The race after the check is reported honestly.** Nothing here spans several
 * files in one transaction, and nothing pretends to: a link removed or a test
 * edited between the check and one file's upload refuses that file at the
 * platform's own door, and the report names every file that landed and every
 * file that did not. A push that had already written four tests never says it
 * was refused, and never says it succeeded either.
 */

import path from "node:path";

import { sameMockTools } from "../folder/mock-tools.ts";
import {
  DEFAULT_PRIORITY,
  type ExpectedBehavior,
  type FileBehavior,
  type FilePersona,
  type TestFile,
} from "../folder/test-file.ts";
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
  createTest,
  editTest,
  getTest,
  listTests,
  type PlatformTest,
  type TestInput,
} from "../platform/tests.ts";
import { pinsAgainst } from "./pins.ts";
import { fileFromPlatform } from "./pull.ts";
import {
  agentNotApplicable,
  agentNotApplicableLate,
  formatOutdated,
  testArchived,
} from "./refusals.ts";

/**
 * The one door rule egma can check without asking: a test with no expected
 * behaviors can never fail, and the platform will refuse it. Checking it here,
 * before anything is uploaded, keeps a folder with one empty test from landing
 * its good files and then being told about the bad one — the same reason the
 * pin check runs before the first upload.
 */
export const NO_BEHAVIORS_REASON =
  "no expected behaviors, so it could never fail. Add one, then run egma push.";

/** Why a push will not touch one file. */
export type ConflictReason =
  /** Somebody edited this test's content on the platform since this file was synced. */
  | "moved"
  /** Somebody renamed or redescribed it since this file was synced. */
  | "identity-moved"
  /** This egma has never issued the version the file is pinned to. */
  | "unknown"
  /** The file has a version pin and no identity revision, so it cannot update. */
  | "format"
  /** The browser has unlinked this test from the repository's bound agent. */
  | "not-applicable"
  /** The test itself is archived. */
  | "archived";

/** A test the push will not touch, and why. */
export type PushConflict = {
  readonly name: string;
  readonly shown: string;
  readonly reason: ConflictReason;
  /**
   * The whole sentence, for the reasons that carry one of their own.
   *
   * `moved` and `unknown` have always been summarised together by the caller,
   * because the fix for both is one pull and one look. The four below it each
   * name a different next move — migrate the file, relink the test, restore the
   * test — and a summary could not carry that, so each brings its own words.
   */
  readonly said: string | null;
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
  /** Absolute, for a caller that offers to open the file it is about. */
  readonly file: string;
  readonly reason: string;
  /**
   * Which of the two refusals this was.
   *
   * `egma` is the one egma can see coming and says before anything uploads: a
   * file it could not read, or a test with nothing to check. `platform` is the
   * platform's own door — it read the upload and refused it for a rule only it
   * can check, which today means a test naming a persona it does not hold.
   *
   * It is written down rather than worked out afterwards, because the door's
   * words are the door's: any sentence it likes, in any wording, changing the
   * day the platform changes. A caller that has to tell one refusal from the
   * other reads this and never the reason.
   */
  readonly refusedBy: "egma" | "platform";
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
  /**
   * The files to upload, absolute, when the caller has already decided which.
   * The whole folder when it is left out, which is what the verb does.
   *
   * The wizard is the caller that names them: it has just put a list of tests
   * on screen and had one keystroke agreed to that list, so what it uploads is
   * that list and not whatever else happens to be in the folder.
   */
  readonly only?: readonly string[];
  readonly fetchImpl?: Fetch;
};

function inputFrom(test: TestFile): TestInput {
  return {
    name: test.name,
    description: test.description ?? "",
    scenario: test.scenario,
    // A line that wrote no priority down is sent as the P0 it has always
    // meant. The distinction the file keeps is about what somebody *claimed*,
    // and a write has to say something either way.
    expectedBehaviors: test.expectedBehaviors.map((one) => ({
      behavior: one.behavior,
      priority: one.priority ?? DEFAULT_PRIORITY,
    })),
    personas: test.personas,
    graders: test.graders,
    requiredCapabilities: test.requiredCapabilities,
    mockTools: test.mockTools,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Whether the file's list is the list the platform holds.
 *
 * A line that wrote no priority down means P0, so it is compared as one: this
 * is the question "would uploading this file mint a version", and a write turns
 * an unmarked line into a P0 whatever it claimed. That is a different question
 * from the pull's, which is about what somebody wrote rather than what a write
 * would do with it.
 */
function sameBehaviors(
  a: readonly FileBehavior[],
  b: readonly ExpectedBehavior[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (one, index) =>
        one.behavior === b[index]?.behavior &&
        (one.priority ?? DEFAULT_PRIORITY) === b[index]?.priority,
    )
  );
}

/**
 * Whether two ordered lists of personas name the same people.
 *
 * **By identity, and never by the name beside it.** The id is what a write
 * resolves and the display name is what a reviewer reads, so somebody who
 * corrected a name in the file has said nothing about who calls — and treating
 * that as an edit would mint a version whose whole content is identical to the
 * one before it. A file with no ids for them is an older shape, and its names
 * are all it has to be compared by.
 */
function samePersonas(
  a: readonly FilePersona[],
  b: readonly FilePersona[],
): boolean {
  return (
    a.length === b.length &&
    a.every((one, index) => {
      const other = b[index];
      if (other === undefined) return false;
      return one.id === "" || other.id === ""
        ? one.name === other.name
        : one.id === other.id;
    })
  );
}

/**
 * Whether the file says exactly what the platform already holds. Order is
 * content in every list: an expected behaviors list is one a reader goes down,
 * personas are named in the order they were authored, graders in the order they
 * were added, and the platform compares a test's mock tools in the order they
 * were written — so a folder that thought order was nothing would mint a
 * version saying nothing.
 */
export function sameAsPlatform(file: TestFile, test: PlatformTest): boolean {
  return (
    file.name === test.name &&
    (file.description ?? "") === test.description &&
    file.scenario === test.scenario &&
    sameBehaviors(file.expectedBehaviors, test.expectedBehaviors) &&
    samePersonas(file.personas, test.personas) &&
    sameList(file.graders, test.graders) &&
    sameList(file.requiredCapabilities, test.requiredCapabilities) &&
    sameMockTools(file.mockTools, test.mockTools)
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

  const folder = await readFolder(paths);
  // The agent this folder is bound to, for the tests it creates and for the
  // question every edit asks. A test always applies to at least one agent, and
  // the only one a repository can honestly name is its own — a folder bound to
  // nothing is answered by the platform's own refusal, which says exactly that.
  const boundAgentId = (await readConfig(paths.config)).agent?.id ?? null;
  const wanted = options.only === undefined ? null : new Set(options.only);
  const readable =
    wanted === null ? folder.found : folder.found.filter((file) => wanted.has(file.file));
  const held = readable.filter((file) => file.test.expectedBehaviors.length > 0);

  // A file egma cannot read is named rather than uploaded, and rather than
  // ending the push: the other files in the folder are somebody's work too.
  // A test with no expected behaviors is the same shape — the platform's door
  // would refuse it anyway, and egma can see that from here, before any of the
  // folder's other files have been uploaded ahead of the refusal.
  const refused: TurnedAway[] = [
    ...(wanted === null
      ? folder.unreadable
      : folder.unreadable.filter((file) => wanted.has(file.file))
    ).map((file) => ({
      name: path.basename(file.file, ".md"),
      shown: file.shown,
      file: file.file,
      reason: file.reason,
      refusedBy: "egma" as const,
    })),
    ...readable
      .filter((file) => file.test.expectedBehaviors.length === 0)
      .map((file) => ({
        name: file.test.name,
        shown: file.shown,
        file: file.file,
        reason: NO_BEHAVIORS_REASON,
        refusedBy: "egma" as const,
      })),
  ];

  if (held.length === 0) {
    return {
      conflicts: [],
      uploadedNothing: true,
      tests: [],
      turnedAway: refused,
    };
  }

  const platformTests = await listTests(signedIn, {
    agentId: boundAgentId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const resolve = pinsAgainst(signedIn, platformTests, ...extra);

  // Everything is decided before anything is uploaded, so a push that is going
  // to be refused is refused with the folder and the platform both untouched.
  const conflicts: PushConflict[] = [];
  const plans: Plan[] = [];

  for (const file of held) {
    const pin = file.test.version;
    if (pin === null) {
      // Nothing on the platform claims to be this file, so nothing about it can
      // be stale. It is a create, and a create says the whole of what it is.
      plans.push({ kind: "create", file });
      continue;
    }

    // Answered without asking anything, and answered first: a file that cannot
    // say what an update has to say cannot make one, whatever else is true of
    // it. The pull that migrates it is the same pull the other refusals ask for.
    if (file.test.identityRevision === null) {
      conflicts.push({
        name: file.test.name,
        shown: file.shown,
        reason: "format",
        said: formatOutdated(file.shown),
      });
      continue;
    }

    const pinned = await resolve(pin);
    if (pinned.kind === "unknown") {
      conflicts.push({
        name: file.test.name,
        shown: file.shown,
        reason: "unknown",
        said: null,
      });
      continue;
    }

    // The test is real and this repository cannot see it. Two reasons, two
    // sentences, and one request to tell them apart — asked only here, where
    // the list has already come up empty-handed, so the ordinary push pays
    // nothing for it.
    if (pinned.kind === "elsewhere") {
      const found = await getTest(signedIn, pinned.testId, ...extra);
      if (found === null) {
        conflicts.push({
          name: pinned.testName,
          shown: file.shown,
          reason: "unknown",
          said: null,
        });
        continue;
      }
      conflicts.push(
        // A folder bound to no agent sees every test, so a test out of that
        // list and not archived is not something this repository can say
        // anything true about — and a sentence naming an agent it does not have
        // would be worse than the one that says egma cannot place the pin.
        found.archived || boundAgentId === null
          ? {
              name: pinned.testName,
              shown: file.shown,
              reason: found.archived ? "archived" : "unknown",
              said: found.archived
                ? testArchived(pinned.testId, found.test.name)
                : null,
            }
          : {
              name: pinned.testName,
              shown: file.shown,
              reason: "not-applicable",
              said: agentNotApplicable(pinned.testId, boundAgentId),
            },
      );
      continue;
    }

    if (pinned.kind === "behind") {
      conflicts.push({
        name: pinned.testName,
        shown: file.shown,
        reason: "moved",
        said: null,
      });
      continue;
    }

    // The content is current. What is left is the live half: a rename or a new
    // description in the browser moves the revision and nothing else, and a
    // file written before it would put the old name back without noticing.
    if (file.test.identityRevision !== pinned.test.revision) {
      conflicts.push({
        name: pinned.test.name,
        shown: file.shown,
        reason: "identity-moved",
        said:
          `${pinned.test.name} has been renamed or redescribed in Egma since ` +
          `${file.shown} was last synced. Run egma pull to bring the change ` +
          "down, look at it, then push again. Nothing was uploaded.",
      });
      continue;
    }

    plans.push(
      sameAsPlatform(file.test, pinned.test)
        ? { kind: "settled", file, test: pinned.test }
        : { kind: "edit", file, test: pinned.test },
    );
  }

  if (conflicts.length > 0) {
    return { conflicts, uploadedNothing: true, tests: [], turnedAway: refused };
  }

  const pushed: PushedTest[] = [];
  const turnedAway: TurnedAway[] = [...refused];
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
        ? await createTest(signedIn, { ...input, agentId: boundAgentId }, ...extra)
        : await editTest(
            signedIn,
            plan.test.id,
            {
              versionId: plan.test.versionId,
              revision: plan.file.test.identityRevision ?? "",
              agentId: boundAgentId,
            },
            input,
            ...extra,
          );

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
        // is the platform's and it held, which is the point of sending what
        // this edit was written against.
        lateConflicts.push({
          name: answer.testName === "" ? plan.file.test.name : answer.testName,
          shown: plan.file.shown,
          reason: "moved",
          said: null,
        });
        break;
      case "identity-moved":
        lateConflicts.push({
          name: plan.file.test.name,
          shown: plan.file.shown,
          reason: "identity-moved",
          said: answer.reason,
        });
        break;
      case "not-applicable":
        // The link went away between the check and this write. **Not the
        // platform's words**, which are written for a client that sent one
        // request: they end by saying push changed neither side, and by now it
        // may well have changed one. The fact and the fix are the same; the
        // claim about the whole run is dropped, because the report is what
        // carries that and it is what actually knows.
        lateConflicts.push({
          name: plan.file.test.name,
          shown: plan.file.shown,
          reason: "not-applicable",
          said: agentNotApplicableLate(plan.file.shown, boundAgentId ?? ""),
        });
        break;
      case "turned-away":
        turnedAway.push({
          name: plan.file.test.name,
          shown: plan.file.shown,
          file: plan.file.file,
          reason: answer.reason,
          refusedBy: "platform",
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
