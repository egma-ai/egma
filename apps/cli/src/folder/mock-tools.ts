/**
 * The mock tools the folder carries, in the one shape both files write them.
 *
 * A mock tool answers for one of the agent's tools while a simulation runs, so
 * a simulation never reaches the real backend and a test can ask for the branch
 * it needs. The project's own are a file of their own; a test that needs a
 * different answer says so inside its own markdown, because an override is test
 * content and versions with the test.
 *
 * Both places hold the identical block, so there is one thing to learn and one
 * thing to write. Where the two differ is only in how the section is *found* —
 * a test file has three sections and takes the last of them, the project's file
 * is prose and then this one — and each file says why where it does it:
 *
 * ````markdown
 * ## Mock tools
 * ### check_availability
 * ```json
 * {
 *   "answer": { "slots": [] },
 *   "delay_ms": 250
 * }
 * ```
 * ````
 *
 * **The heading is the tool's name and the block is what egma sends.** An
 * answer is whatever shape that tool's own contract has — an object, a list, a
 * number, `null` — so it is written as JSON rather than squeezed into the
 * little YAML the rest of the folder uses, and what the block says travels to
 * egma's door unchanged. That is why a delay past the ceiling, an answer past
 * the size egma can carry, or a key that is not one are all refused there, in
 * egma's own words: this end holds no second copy of a rule that would be free
 * to disagree with the one that matters.
 *
 * **Reading is forgiving and writing is exact**, the rule the test file format
 * already lives by. Any heading depth, any capitalisation of the section
 * heading, and a fence with or without `json` after it are all read. Everything
 * egma writes goes out through the one serializer below, which is what makes a
 * `pull` immediately after a `push` change zero bytes.
 */

/** One mock tool as a file writes it. */
export type MockToolEntry = {
  /** The agent's own name for the tool this answers for. */
  readonly tool: string;
  /**
   * Everything else the block said, exactly as it said it — `answer` or
   * `error`, and `delay_ms` and `agents` where they were written.
   *
   * Deliberately not a shape with named fields. What a mock tool holds is
   * egma's to decide, and a folder that only knew today's keys would silently
   * drop tomorrow's rather than letting egma answer about it.
   */
  readonly says: Readonly<Record<string, unknown>>;
};

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
 * catches: a test file that will not parse is named and left alone, and the
 * mock tools file is read the same way.
 */
export class MockToolProblem extends Error {
  readonly where: string;

  constructor(where: string, said: string) {
    super(`${where}: ${said}`);
    this.name = "MockToolProblem";
    this.where = where;
  }
}

/**
 * The entries in the lines under the section heading.
 *
 * Lines rather than text, because both files splice this section out of a
 * larger document and slicing lines is the one way both do it.
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
    entries.push({ tool, says: saidBy(block, tool, where) });
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
 * What one block says, as an object egma can send.
 *
 * A mock tool with no block at all says nothing, and is sent saying nothing —
 * egma's door answers that with the sentence about what a mock tool has to
 * answer with, which is the sentence the author needs. Only the two things this
 * end truly cannot carry are refused here: text that is not JSON, and JSON that
 * is not an object to send.
 */
function saidBy(
  block: string | null,
  tool: string,
  where: string,
): Readonly<Record<string, unknown>> {
  if (block === null || block.trim() === "") return {};

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

  // The heading is the tool's name, so a block that names one too is either
  // saying the same thing — and is dropped, having added nothing — or is
  // contradicting the heading, which nothing here is entitled to settle.
  const { tool: named, ...says } = read as Record<string, unknown>;
  if (named !== undefined && named !== tool) {
    throw new MockToolProblem(
      where,
      `the mock tool "${tool}" holds a block naming ${JSON.stringify(named)}. ` +
        `The heading is the tool's name; take the tool line out of the block, ` +
        `or put the mock tool under a heading that says the same thing.`,
    );
  }

  return says;
}

/**
 * The section, as lines, or nothing at all when there is nothing to say.
 *
 * A file with no mock tools carries no heading for them rather than an empty
 * one: the shape is the format's, so what goes out is what reading it gives
 * back.
 */
export function writeMockTools(
  entries: readonly MockToolEntry[],
): readonly string[] {
  if (entries.length === 0) return [];

  const lines = [MOCK_TOOLS_HEADING];
  for (const entry of entries) {
    lines.push(`### ${entry.tool}`, "```json", JSON.stringify(entry.says, null, 2), "```");
  }
  return lines;
}

/**
 * What one entry says, in a shape two entries can be compared by.
 *
 * The entry's own keys are put in one order first, because the order somebody
 * typed `delay_ms` and `answer` in is not something they said — egma has one
 * order it writes them in, and a file that arrived in another is the same mock
 * tool. What is inside each of those keys is left exactly as it is, and is
 * compared by its serialization: an answer is whatever shape that tool's own
 * contract has, so there is no set of fields to be exhaustive over, and the
 * platform compares an answer the same way for the same reason.
 */
function saidInOneOrder(entry: MockToolEntry): string {
  const says = entry.says;
  return JSON.stringify(
    Object.keys(says)
      .sort()
      .map((key) => [key, says[key]]),
  );
}

/** Whether two entries say the same thing, whatever order they say it in. */
export function sameMockTool(a: MockToolEntry, b: MockToolEntry): boolean {
  return a.tool === b.tool && saidInOneOrder(a) === saidInOneOrder(b);
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
