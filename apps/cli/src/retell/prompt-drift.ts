/**
 * Whether the prompt in the repository is the prompt the provider is running.
 *
 * They drift all the time and it is nobody's fault: somebody edits the words in
 * the dashboard on a Friday, the repository keeps yesterday's copy, and both
 * are honest. egma says so once and carries on. It never blocks, because being
 * out of step is not an error — but tests generated from the wrong half would
 * be tests about words nobody is running, so the line has to name which half
 * they will come from.
 *
 * The comparison is deliberately nearly exact. Line endings are made the same,
 * because a checkout on Windows changes every one of them and that is not a
 * drift anybody wants told. Blank space at the two ends is ignored, because a
 * file ends with a newline and a dashboard field does not. Everything inside is
 * compared as written: indentation and blank lines inside a prompt change what
 * a model does, so treating them as noise would hide a real difference.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** The one line, when there is one. Nothing else is ever said about drift. */
export const DRIFT_LINE =
  "Your repo's prompt differs from what Retell is running (repo may be stale, " +
  "or the dashboard is ahead). Tests will be generated from what Retell actually runs.";

export type Drift =
  /** Both halves were read, and they are not the same. */
  | "differs"
  /** Both halves were read, and they are the same. */
  | "same"
  /** One half was missing, so there was nothing to compare. */
  | "not-compared";

/** The two texts made comparable, and no more comparable than that. */
export function forComparing(text: string): string {
  return text.replaceAll("\r\n", "\n").trim();
}

/**
 * The file the repository keeps its prompt in, out of what the coding agent
 * reported.
 *
 * What comes back from that step is a sentence, not a path: it may be a bare
 * path, a path with a note after it, a pattern covering several files, or a
 * statement that the words live in a dashboard and not in the repository at
 * all. So every word of it is tried as a path and the first real file wins.
 * Anything else means there is no repository copy to compare, which is a real
 * answer and the one that produces no line.
 */
export async function repoPromptFile(cwd: string, said: string | null): Promise<string | null> {
  const trimmed = (said ?? "").trim();
  if (trimmed === "") return null;

  const candidates = [trimmed, ...trimmed.split(/\s+/u)]
    .map((word) => word.replaceAll(/^[("'`]+|[)"'`,;:.]+$/gu, ""))
    .filter((word) => word !== "" && !word.includes("*"));

  for (const candidate of candidates) {
    const where = path.resolve(cwd, candidate);
    // The fence around environment files holds here too. egma reads this file
    // itself rather than through a coding agent, and the rule is about the
    // file, not about who is doing the reading.
    if (path.basename(where).startsWith(".env")) continue;
    try {
      if ((await stat(where)).isFile()) return where;
    } catch {
      // Not a path, or not one that exists. The next word may be.
    }
  }
  return null;
}

/**
 * The comparison, made against a file rather than against a promise of one.
 *
 * A prompt egma could not read on either side is `not-compared` and says
 * nothing — an honest silence, rather than a line claiming a difference egma
 * has not seen.
 */
export async function compareWithRepo(options: {
  readonly cwd: string;
  /** Where the find-the-agent step said the prompts live. */
  readonly said: string | null;
  /** What the provider is running, or `null` when it holds no prompt. */
  readonly running: string | null;
}): Promise<{ readonly drift: Drift; readonly file: string | null }> {
  if (options.running === null || options.running.trim() === "") {
    return { drift: "not-compared", file: null };
  }

  const file = await repoPromptFile(options.cwd, options.said);
  if (file === null) return { drift: "not-compared", file: null };

  let held: string;
  try {
    held = await readFile(file, "utf8");
  } catch {
    return { drift: "not-compared", file: null };
  }

  return {
    drift: forComparing(held) === forComparing(options.running) ? "same" : "differs",
    file,
  };
}
