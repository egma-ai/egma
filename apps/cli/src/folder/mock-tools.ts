/**
 * The mock tools a test carries, in the one shape a file writes them.
 *
 * A mock tool answers for one of the agent's tools while a simulation runs, so
 * a simulation never reaches the real backend and a test can ask for the branch
 * it needs. **A mock tool belongs to the test that writes it.** There is no
 * project-wide list to override and nothing to scope to some agents and not
 * others: the test says what its world answers, and that answer versions with
 * the test exactly as an expected behavior does.
 *
 * ````markdown
 * ## Mock tools
 * ### get_availability
 * ```json
 * { "answer": { "slots": [] } }
 * ```
 * ### book
 * ```json
 * { "error": "calendar down" }
 * ```
 * ````
 *
 * **The heading is the tool's name and the block is what it answers with.** The
 * block says exactly one of `answer` and `error`, and nothing else. An answer is
 * whatever shape that tool's own contract has — an object, a list, a number,
 * `null` — so it is written as JSON rather than squeezed into the little YAML
 * the rest of the folder uses, and what the block says travels to egma's door
 * unchanged. How large an answer may be is egma's to say, and is said there.
 *
 * **Reading is forgiving and writing is exact**, the rule the test file format
 * already lives by. Any heading depth, any capitalisation of the section
 * heading, and a fence with or without `json` after it are all read. Everything
 * egma writes goes out through the one serializer below, which is what makes a
 * `pull` immediately after a `push` change zero bytes.
 */

import { FolderProblem } from "./problem.ts";
import { sameJsonValue } from "./json-value.ts";

/** One mock tool as a file writes it: one tool, and the one thing it says. */
export type MockToolEntry =
  | { readonly tool: string; readonly answer: unknown }
  | { readonly tool: string; readonly error: string };

/** The section heading, as egma writes it. */
export const MOCK_TOOLS_HEADING = "## Mock tools";

/** The section heading, however many hashes and whatever case it was typed in. */
export const MOCK_TOOLS_LINE = /^#{1,6}\s*mock\s+tools\s*$/iu;

/** Any heading — inside the section, one starts a mock tool. */
const HEADING_LINE = /^#{1,6}\s*(\S.*?)\s*$/u;

/** Three backticks or more, with or without a language after them. */
const FENCE_LINE = /^(`{3,})\s*(\S*)\s*$/u;

/**
 * A file egma could not read, said with enough to go and fix it.
 *
 * Thrown rather than carried, because every reader of these files already
 * catches: a test file that will not parse is named and left alone.
 */
export class MockToolProblem extends FolderProblem {
  constructor(where: string, said: string) {
    super(where, `${where}: ${said}`);
    this.name = "MockToolProblem";
  }
}

/** What the block says it answers with, as one entry. */
function said(entry: MockToolEntry): Readonly<Record<string, unknown>> {
  return "error" in entry ? { error: entry.error } : { answer: entry.answer };
}

/**
 * Why one key is not a mock tool's to hold.
 *
 * The two that were once accepted are named in their own words rather than
 * lumped in with a typo, because a repository holding either is a repository
 * somebody wrote on purpose against an older Egma, and "unsupported key" would
 * leave them guessing what replaced it. Nothing replaced either.
 */
function unsupportedKey(key: string, tool: string): string {
  if (key === "delay_ms") {
    return (
      `the mock tool "${tool}" holds delay_ms. A mocked answer arrives as soon ` +
      `as the lane can send it, and the key is gone — take the line out.`
    );
  }
  if (key === "agents") {
    return (
      `the mock tool "${tool}" holds agents. A mock tool belongs to the test ` +
      `that writes it, so there is nobody else to hold it back from — take the ` +
      `line out.`
    );
  }
  if (key === "tool") {
    return (
      `the mock tool "${tool}" holds a tool key. The heading is the tool's ` +
      `name — take the line out.`
    );
  }
  return (
    `the mock tool "${tool}" holds "${key}". A mock tool block says exactly one ` +
    `of answer and error, and nothing else.`
  );
}

/**
 * One block, as the one thing the mock tool answers with.
 *
 * Exactly one of `answer` and `error`. Both is a file that has not decided,
 * neither is a mock tool that answers nothing, and either would reach egma's
 * door only to be turned away there — so it is said here, over the file, where
 * the author is looking.
 */
function entryFrom(block: string | null, tool: string, where: string): MockToolEntry {
  if (block === null || block.trim() === "") {
    throw new MockToolProblem(
      where,
      `the mock tool "${tool}" has no JSON block under it. Write one saying ` +
        `what it answers with — {"answer": {"slots": []}}, or ` +
        `{"error": "the calendar is unreachable"}.`,
    );
  }

  let read: unknown;
  try {
    read = JSON.parse(block);
  } catch (problem) {
    throw new MockToolProblem(
      where,
      `the block under the mock tool "${tool}" is not JSON Egma can read — ` +
        `${problem instanceof Error ? problem.message : String(problem)}`,
    );
  }

  if (typeof read !== "object" || read === null || Array.isArray(read)) {
    throw new MockToolProblem(
      where,
      `the block under the mock tool "${tool}" says ${JSON.stringify(read)}, ` +
        `and a mock tool is written as an object saying what it answers with — ` +
        `like {"answer": {"slots": []}} or {"error": "the calendar is unreachable"}.`,
    );
  }

  const written = read as Record<string, unknown>;
  for (const key of Object.keys(written)) {
    if (key === "answer" || key === "error") continue;
    throw new MockToolProblem(where, unsupportedKey(key, tool));
  }

  const answers = "answer" in written;
  const fails = "error" in written;
  if (answers && fails) {
    throw new MockToolProblem(
      where,
      `the mock tool "${tool}" says both answer and error. A mock tool answers ` +
        `with one thing: write whichever branch the test needs.`,
    );
  }
  if (!answers && !fails) {
    throw new MockToolProblem(
      where,
      `the mock tool "${tool}" says neither answer nor error. Write answer with ` +
        `what the tool returns, or error with the failure it raises.`,
    );
  }

  if (fails) {
    const message = written["error"];
    if (typeof message !== "string") {
      throw new MockToolProblem(
        where,
        `the mock tool "${tool}" writes error as ${JSON.stringify(message)}. ` +
          `error is the failure this mock tool raises, written as text.`,
      );
    }
    return { tool, error: message };
  }

  return { tool, answer: written["answer"] };
}

/**
 * The entries in the lines under the section heading.
 *
 * Lines rather than text, because the test file splices this section out of a
 * larger document and slicing lines is how it does it.
 */
export function readMockTools(
  lines: readonly string[],
  where: string,
): readonly MockToolEntry[] {
  const entries: MockToolEntry[] = [];
  let tool: string | null = null;
  let written: string[] | null = null;
  let block: string | null = null;
  let closing: string | null = null;

  const finish = (): void => {
    if (tool === null) return;
    entries.push(entryFrom(block, tool, where));
    tool = null;
    block = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // Inside a fence nothing is a heading and nothing is a fence but the one
    // that closes this one, so an answer holding either reads back as itself.
    if (closing !== null) {
      if (line === closing) {
        if (written !== null) block = written.join("\n");
        written = null;
        closing = null;
        continue;
      }
      written?.push(raw);
      continue;
    }

    const fence = FENCE_LINE.exec(line);
    if (fence !== null) {
      closing = fence[1] as string;
      // The first block under a heading is the mock tool's; a fence anywhere
      // else is stepped over rather than read, so prose that shows an example
      // never turns into a mock tool nobody authored.
      written = tool !== null && block === null ? [] : null;
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading !== null) {
      finish();
      tool = heading[1] as string;
      continue;
    }
  }

  // A fence nobody closed still holds what somebody wrote, so it is read rather
  // than thrown away: what it says is judged exactly as a closed one is.
  if (written !== null && block === null) block = written.join("\n");
  finish();

  return entries;
}

/**
 * The section, as lines, or nothing at all when there is nothing to say.
 *
 * A test with no mock tools carries no heading for them rather than an empty
 * one: the shape is the format's, so what goes out is what reading it gives
 * back.
 */
export function writeMockTools(
  entries: readonly MockToolEntry[],
): readonly string[] {
  if (entries.length === 0) return [];

  const lines = [MOCK_TOOLS_HEADING];
  for (const entry of entries) {
    lines.push(`### ${entry.tool}`, "```json", JSON.stringify(said(entry), null, 2), "```");
  }
  return lines;
}

/** Whether two entries say the same thing, whatever order they say it in. */
export function sameMockTool(a: MockToolEntry, b: MockToolEntry): boolean {
  return a.tool === b.tool && sameJsonValue(said(a), said(b));
}

/** Whether two lists of mock tools say the same thing, in the same order. */
export function sameMockTools(
  a: readonly MockToolEntry[],
  b: readonly MockToolEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other !== undefined && sameMockTool(entry, other);
    })
  );
}
