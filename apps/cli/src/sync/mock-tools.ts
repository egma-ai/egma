/**
 * The project's mock tools, between the folder and the platform.
 *
 * The two verbs are the folder's two verbs and they behave the way they behave
 * everywhere else — `pull` writes what the platform holds into the file, `push`
 * uploads what the file says — with one difference, and it is the entity's
 * rather than this module's: **a mock tool is not versioned.** There is no pin
 * to carry and no version to compare, so an edit overwrites and a push cannot
 * be refused for a mock tool somebody else moved. A test's overrides are the
 * other half of the mocked world and they do version, because they are test
 * content; they ride the test's own file and the test's own refusal rule.
 *
 * Neither verb removes one, exactly as neither removes a test. A folder is a
 * working copy that people draft in, and a verb that deleted whatever was not
 * in front of it would make the folder unsafe to work in.
 */

import {
  readMockToolsFile,
  writeMockToolsFile,
  FOLDER_NAME,
  MOCK_TOOLS_FILE_NAME,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import { sameMockTool, type MockToolEntry } from "../folder/mock-tools.ts";
import type { Fetch } from "../platform/device-flow.ts";
import {
  createMockTool,
  editMockTool,
  listMockTools,
  type PlatformMockTool,
} from "../platform/mock-tools.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import type { TurnedAway } from "./push.ts";

/** `egma/mock-tools.md`, as every report says a path. */
export const MOCK_TOOLS_SHOWN = `${FOLDER_NAME}/${MOCK_TOOLS_FILE_NAME}`;

export type MockToolsOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
};

export type PullMockToolsReport = {
  /** Every mock tool this pull wrote into the file, in the order it wrote them. */
  readonly tools: readonly string[];
  /** False when the file already said exactly this. */
  readonly written: boolean;
  /**
   * Why the file was left exactly as it is, when egma could not read it.
   *
   * A pull cannot merge what it cannot read: the mock tools somebody is
   * drafting in there are invisible to it, and writing the platform's answer
   * over the top would destroy the one file they most need to look at. So it
   * is named and left, which is what a pull does with a test file it cannot
   * read too.
   */
  readonly unreadable: string | null;
};

/** One mock tool after a push, and what happened to it. */
export type PushedMockTool = {
  readonly tool: string;
  readonly state: "created" | "updated" | "unchanged";
};

export type PushMockToolsReport = {
  readonly mockTools: readonly PushedMockTool[];
  readonly turnedAway: readonly TurnedAway[];
};

/**
 * By tool name, so a file reads in an order a person can go down and two runs
 * of either verb agree with each other. The name is the key the platform holds
 * them by — one answer per tool — so it is the only order that is stable while
 * mock tools are added and taken away.
 */
function byToolName(a: MockToolEntry, b: MockToolEntry): number {
  return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
}

/**
 * The platform's mock tools, written into the file.
 *
 * A mock tool the platform has never heard of is kept exactly as it is: it is
 * one somebody is drafting and has not pushed, and a pull that removed it would
 * destroy the work it was run to protect. One the platform does hold is written
 * from the platform's answer — there is no version to compare, so the verb that
 * ran last is the one that wins, which is what unversioned means.
 */
export async function pullMockTools(
  options: MockToolsOptions,
): Promise<PullMockToolsReport> {
  const { signedIn, paths, fetchImpl } = options;

  // Read before anything is asked of the platform, and read first of all: a
  // file egma cannot read is a pull that writes nothing rather than a pull that
  // ends on an exception. This verb is the one a refusal tells a developer to
  // run, so it is the last one allowed to fall over on a half-typed file.
  let authored: readonly MockToolEntry[];
  try {
    authored = await readMockToolsFile(paths.mockTools);
  } catch (problem) {
    return {
      tools: [],
      written: false,
      unreadable: problem instanceof Error ? problem.message : String(problem),
    };
  }

  const held = await listMockTools(
    signedIn,
    ...(fetchImpl === undefined ? [] : ([fetchImpl] as const)),
  );

  const onPlatform = new Set(held.map((one) => one.entry.tool));
  const drafts = authored.filter((entry) => !onPlatform.has(entry.tool));

  const entries = [...held.map((one) => one.entry), ...drafts].sort(byToolName);
  const { changed } = await writeMockToolsFile(paths.mockTools, entries);

  return { tools: entries.map((entry) => entry.tool), written: changed, unreadable: null };
}

/**
 * The file's mock tools, uploaded.
 *
 * The file is read before anything is asked of the platform, so a file egma
 * cannot read costs one refusal and no uploads. Everything else is one write
 * per mock tool the file says something new about, and the file is rewritten
 * afterwards from what the platform answered — which is what makes a `pull`
 * straight afterwards find nothing to do.
 */
export async function pushMockTools(
  options: MockToolsOptions,
): Promise<PushMockToolsReport> {
  const { signedIn, paths, fetchImpl } = options;
  const extra = fetchImpl === undefined ? [] : ([fetchImpl] as const);

  let authored: readonly MockToolEntry[];
  try {
    authored = await readMockToolsFile(paths.mockTools);
  } catch (problem) {
    // Named rather than thrown, and the tests around it are not forfeit over
    // it — the same shape a test file egma cannot read is answered with.
    return {
      mockTools: [],
      turnedAway: [
        {
          name: MOCK_TOOLS_FILE_NAME.replace(/\.md$/u, ""),
          shown: MOCK_TOOLS_SHOWN,
          file: paths.mockTools,
          reason: problem instanceof Error ? problem.message : String(problem),
          refusedBy: "egma",
        },
      ],
    };
  }

  if (authored.length === 0) return { mockTools: [], turnedAway: [] };

  const held = await listMockTools(signedIn, ...extra);
  const byTool = new Map<string, PlatformMockTool>(
    held.map((one) => [one.entry.tool, one] as const),
  );

  const pushed: PushedMockTool[] = [];
  const turnedAway: TurnedAway[] = [];
  const settled: MockToolEntry[] = [];

  for (const entry of authored) {
    const already = byTool.get(entry.tool);

    if (already !== undefined && sameMockTool(already.entry, entry)) {
      pushed.push({ tool: entry.tool, state: "unchanged" });
      settled.push(already.entry);
      continue;
    }

    const answer =
      already === undefined
        ? await createMockTool(signedIn, entry, ...extra)
        : await editMockTool(signedIn, already.id, entry, ...extra);

    if (answer.kind === "turned-away") {
      // Left in the file exactly as it was written, so the author is looking at
      // what the refusal is about.
      settled.push(entry);
      turnedAway.push({
        name: entry.tool,
        shown: MOCK_TOOLS_SHOWN,
        file: paths.mockTools,
        reason: answer.reason,
        refusedBy: "platform",
      });
      continue;
    }

    settled.push(answer.mockTool.entry);
    pushed.push({
      tool: answer.mockTool.entry.tool,
      state: already === undefined ? "created" : "updated",
    });
  }

  // Only what this push was handed. A mock tool somebody else authored is the
  // next `pull`'s to bring down, and a push that wrote it in would put a change
  // nobody made into the developer's diff.
  await writeMockToolsFile(paths.mockTools, [...settled].sort(byToolName));

  return { mockTools: pushed, turnedAway };
}
