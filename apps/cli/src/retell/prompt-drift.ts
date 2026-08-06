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
 *
 * **What this module gives back is one word, and never a byte of the file.**
 * Reading a file to compare it is a small thing that could quietly become a
 * large one: a path in a return value gets printed by whoever adds the next
 * line, and text in a return value gets sent. So the reading, the comparing and
 * the forgetting all happen in here, the answer is `same`, `differs` or
 * `not-compared`, and there is nothing else for a caller to reach for.
 */

import { readFile, realpath, stat } from "node:fs/promises";
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
  /** One half was missing or unreadable, so there was nothing to compare. */
  | "not-compared";

/** The two texts made comparable, and no more comparable than that. */
function forComparing(text: string): string {
  return text.replaceAll("\r\n", "\n").trim();
}

/** Whether a path is something inside this folder, rather than the folder or beyond it. */
function inside(root: string, where: string): boolean {
  const relative = path.relative(root, where);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A file egma will not read, whoever asked it to and for whatever reason. */
function fenced(where: string): boolean {
  return path.basename(where).startsWith(".env");
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
 *
 * That is a sentence written by a model being turned into a file egma opens, so
 * two fences stand around it and neither is advisory:
 *
 * **The folder.** A word is only tried where the developer ran egma. An
 * absolute path, a path climbing out with `..`, and a link inside the folder
 * pointing anywhere else are all the same answer — not a prompt file — because
 * the check is made on the path with every link on the way already followed.
 * A repository is what egma was invited to read, and nothing outside it is.
 *
 * **`.env`.** The fence the driven agent works under holds here too, and it is
 * checked twice: on the name that was said and again on where that name really
 * leads, so a link cannot launder a secret through a harmless-looking name.
 */
async function repoPromptFile(root: string, said: string): Promise<string | null> {
  const candidates = [said, ...said.split(/\s+/u)]
    .map((word) => word.replaceAll(/^[("'`]+|[)"'`,;:.]+$/gu, ""))
    .filter((word) => word !== "" && !word.includes("*"));

  for (const candidate of candidates) {
    const named = path.resolve(root, candidate);
    if (!inside(root, named) || fenced(named)) continue;

    let real: string;
    try {
      real = await realpath(named);
    } catch {
      // Not a path, or not one that exists. The next word may be.
      continue;
    }
    if (!inside(root, real) || fenced(real)) continue;

    try {
      if ((await stat(real)).isFile()) return real;
    } catch {
      continue;
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
  /** The folder egma was run in, which is the whole of what it may read. */
  readonly cwd: string;
  /** Where the find-the-agent step said the prompts live. */
  readonly said: string | null;
  /** What the provider is running, or `null` when it holds no prompt. */
  readonly running: string | null;
}): Promise<Drift> {
  const running = options.running ?? "";
  const said = (options.said ?? "").trim();
  if (running.trim() === "" || said === "") return "not-compared";

  // The folder itself, with its own links followed, so that a path inside it is
  // measured against the same folder it will be measured as being inside of.
  let root: string;
  try {
    root = await realpath(options.cwd);
  } catch {
    return "not-compared";
  }

  const file = await repoPromptFile(root, said);
  if (file === null) return "not-compared";

  try {
    // The one place a repository file is read, and the last place its contents
    // exist: they are compared here and nothing carries them out.
    return forComparing(await readFile(file, "utf8")) === forComparing(running)
      ? "same"
      : "differs";
  } catch {
    return "not-compared";
  }
}
