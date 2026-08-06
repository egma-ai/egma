/**
 * The test cases a developer already had, read off their disk.
 *
 * Most teams shipping a voice agent have a spreadsheet or a document of things
 * it ought to handle. Ignoring it and generating from nothing would throw away
 * the one piece of work that is already grounded in their customers, so egma
 * asks for it once and turns it into files before it generates anything.
 *
 * What arrives is a path a person typed, and egma opens what it points at. The
 * same two fences stand around it as around the prompt egma reads for the drift
 * line, and for the same reason — a path is an instruction to open a file, and
 * an instruction is only as safe as what it is allowed to reach:
 *
 * **The folder.** A path is only opened inside the folder the developer ran
 * egma in, measured after every link on the way is followed, so an absolute
 * path, a path climbing out with `..`, and a link pointing anywhere else are
 * all the same answer.
 *
 * **`.env`.** The fence the driven coding agent works under holds here too,
 * checked on the name that was said and again on where it really leads.
 *
 * The content is then handed to the coding agent inside the task. It is never
 * a path the agent is sent to fetch for itself: egma read the file, egma knows
 * what it read, and the agent gets exactly that and nothing around it.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * How much of a file egma will carry into a task.
 *
 * A note or a spreadsheet export of test cases is kilobytes. Something much
 * larger than this is not a list of test cases, and pushing it into a coding
 * agent's context would cost the developer their whole run for nothing.
 */
export const MAX_EXISTING_TESTS_BYTES = 256 * 1024;

export type ExistingTests =
  | {
      readonly kind: "read";
      /** As it reads in a report: relative to the folder egma was run in. */
      readonly shown: string;
      readonly content: string;
    }
  /** Nobody named a file, which is the ordinary answer. */
  | { readonly kind: "none" }
  /** Something was named and egma will not read it, in plain words. */
  | { readonly kind: "unusable"; readonly reason: string };

/** Whether a path is inside this folder, rather than the folder or beyond it. */
function inside(root: string, where: string): boolean {
  const relative = path.relative(root, where);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A file egma will not read, whoever asked it to and for whatever reason. */
function fenced(where: string): boolean {
  return path.basename(where).startsWith(".env");
}

/**
 * Whether this looks like something a person wrote rather than something a
 * program did. A spreadsheet saved as a spreadsheet is bytes egma cannot read
 * and a coding agent cannot either, so it is turned away with the one sentence
 * that fixes it rather than handed on as rubble.
 */
function isText(content: string): boolean {
  return !content.includes("\0");
}

/**
 * What the developer pointed at, or why egma will not open it.
 *
 * `said` is exactly what they typed. `n`, `no` and nothing at all are all the
 * same answer — they have none — because a question with a suggested key in it
 * gets answered with that key.
 */
export async function readExistingTests(cwd: string, said: string | null): Promise<ExistingTests> {
  const typed = (said ?? "").trim();
  if (typed === "" || /^(?:n|no|none)$/iu.test(typed)) return { kind: "none" };

  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { kind: "unusable", reason: `egma cannot read ${cwd}.` };
  }

  const outside = `${typed} is outside ${root}. egma reads only the folder it was started in, so copy the file in and run egma again.`;

  const named = path.resolve(root, typed);
  if (!inside(root, named)) return { kind: "unusable", reason: outside };
  if (fenced(named)) {
    return { kind: "unusable", reason: "egma never reads .env files, and never hands one on." };
  }

  let real: string;
  try {
    real = await realpath(named);
  } catch {
    return { kind: "unusable", reason: `There is nothing at ${typed}.` };
  }
  if (!inside(root, real)) return { kind: "unusable", reason: outside };
  if (fenced(real)) {
    return { kind: "unusable", reason: "egma never reads .env files, and never hands one on." };
  }

  const shown = path.relative(root, real);

  let size: number;
  try {
    const found = await stat(real);
    if (!found.isFile()) {
      return { kind: "unusable", reason: `${shown} is not a file. Name the file itself.` };
    }
    size = found.size;
  } catch {
    return { kind: "unusable", reason: `egma could not open ${shown}.` };
  }

  if (size > MAX_EXISTING_TESTS_BYTES) {
    return {
      kind: "unusable",
      reason: `${shown} is larger than ${Math.round(MAX_EXISTING_TESTS_BYTES / 1024)} KB, which is far more than a list of test cases. Point egma at the list itself.`,
    };
  }

  let content: string;
  try {
    content = await readFile(real, "utf8");
  } catch {
    return { kind: "unusable", reason: `egma could not read ${shown}.` };
  }

  if (!isText(content)) {
    return {
      kind: "unusable",
      reason: `${shown} is not a text file. Export it as CSV, or as a document egma can read, and run egma again.`,
    };
  }
  if (content.trim() === "") {
    return { kind: "unusable", reason: `${shown} is empty.` };
  }

  return { kind: "read", shown, content };
}
