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
 */

import path from "node:path";

/** What the agent is told when it reaches for a fenced file. */
export const FENCE_MESSAGE =
  "egma keeps .env files away from the agents it drives, so this file was not read. Work from the code and the committed example files instead, and ask the developer for any value you still need.";

/** What the developer sees when the fence stops the agent. */
export function fenceStatusLine(target: string): string {
  return `Refused: ${target} is fenced off from the agent. It was told to look elsewhere.`;
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
  const name = path.basename(candidate.replace(/\\/g, "/"));
  return name.startsWith(".env");
}

/** Paths a tool call names, gathered from every shape the protocol allows. */
export function pathsIn(input: {
  readonly locations?: readonly { readonly path?: string }[] | null;
  readonly rawInput?: unknown;
}): string[] {
  const found: string[] = [];

  for (const location of input.locations ?? []) {
    if (typeof location.path === "string") found.push(location.path);
  }

  const raw = input.rawInput;
  if (raw !== null && typeof raw === "object") {
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (typeof value === "string") found.push(value);
    }
  }

  return found;
}

/** The first fenced path a tool call names, or `null` when it names none. */
export function fencedPathIn(input: {
  readonly locations?: readonly { readonly path?: string }[] | null;
  readonly rawInput?: unknown;
}): string | null {
  return pathsIn(input).find((candidate) => isFenced(candidate)) ?? null;
}
