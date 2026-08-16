/**
 * The `.env` fence.
 *
 * egma approves everything the agent it drives asks for, so that a developer is
 * never interrupted. One thing is never approved: a file whose name starts with
 * `.env`. Those hold secrets, and an approved read puts them in a model's
 * context for good.
 *
 * The protocol shows a client a file path in two places, and the fence stands
 * in both: the permission request the agent sends before acting, and the
 * file-reading and file-writing methods an agent may ask the client to perform
 * on its behalf. Only the second can carry a message back to the agent, so that
 * is where the wording that sends it elsewhere lives.
 *
 * A tool call does not always carry a path. A terminal call carries a command
 * line — `cat .env` names the file inside a sentence, in a field the protocol
 * gives no shape to — so the fence reads every string a call holds, however
 * deeply it is buried, and treats each word of each string as a path. It
 * refuses more than it strictly has to. That is the right way round: a fence
 * that refuses a harmless call costs one retry, and a fence that misses one
 * costs the secret.
 */

import path from "node:path";

/** What the agent is told when it reaches for a fenced file. */
export const FENCE_MESSAGE =
  "Egma keeps .env files away from the coding agents it drives, so this file was not read. Work from the code and the committed example files instead, and ask the developer for any value you still need.";

/** What the developer sees when the fence stops the agent. */
export function fenceStatusLine(target: string): string {
  return `Refused: ${target} is fenced off from your coding agent. It was told to look elsewhere.`;
}

/** A path as the fence reads it: forward slashes, and its own last part. */
function nameOf(candidate: string): string {
  return path.basename(candidate.replace(/\\/g, "/"));
}

/**
 * Whether a path names a fenced file.
 *
 * The rule is the file's name, not its contents: everything matching `.env*` is
 * refused, including the committed example files, because a fence a developer
 * has to reason about is a fence they stop trusting.
 */
export function isFenced(candidate: string): boolean {
  if (candidate.length === 0) return false;
  return nameOf(candidate).startsWith(".env");
}

/**
 * What a shell would treat as the end of one word. Splitting on these is how a
 * path is found inside a command line, a flag, or a quoted argument.
 */
const WORD_BREAKS = /[\s"'`=|&;,<>(){}[\]]+/;

/**
 * A `.env` name anywhere in a string, whatever sits around it. The character
 * before it must not be one a name is made of, so `process.env` and
 * `src/env.ts` are left alone while `./.env` and `--file=.env` are not.
 */
const LOOSE_REFERENCE = /(?:^|[^\w])(\.env[\w.-]*)/;

/** The `.env` file a piece of text names, or `null` when it names none. */
export function fencedFileIn(text: string): string | null {
  for (const word of text.split(WORD_BREAKS)) {
    if (word !== "" && isFenced(word)) return nameOf(word);
  }
  // A word break we did not expect is still not a way through.
  return LOOSE_REFERENCE.exec(text)?.[1] ?? null;
}

/** How far into a nested raw input the fence reads. Deeper than any real one. */
const MAX_DEPTH = 8;

/** Every string a value holds, through arrays and objects alike. */
export function stringsIn(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= MAX_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      stringsIn(item, depth + 1),
    );
  }
  return [];
}

/**
 * The fenced file a tool call reaches for, or `null` when it reaches for none.
 * Both the paths the protocol gives a shape to and the raw arguments it does
 * not are read, because the agent chooses which of the two it uses.
 */
export function fencedReferenceIn(input: {
  readonly locations?: readonly { readonly path?: string }[] | null;
  readonly rawInput?: unknown;
}): string | null {
  for (const location of input.locations ?? []) {
    if (typeof location.path === "string" && isFenced(location.path)) {
      return nameOf(location.path);
    }
  }

  for (const text of stringsIn(input.rawInput)) {
    const found = fencedFileIn(text);
    if (found !== null) return found;
  }

  return null;
}
