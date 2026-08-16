/**
 * The Node check that runs before anything else.
 *
 * `npx` does not enforce the `engines` field, so a developer on an old Node
 * reaches our code and fails on syntax rather than on a sentence. This module
 * is imported statically by the entry point and everything else is loaded after
 * it, so the refusal is printed before any newer code is even parsed. Keep it
 * free of imports and of anything an old Node cannot run.
 */

/** The oldest Node the wizard and the agent adapters both run on. */
export const LOWEST_NODE_MAJOR = 22;

/**
 * The refusal to print, or `null` when this Node is new enough.
 *
 * A version string we cannot read is treated as new enough: refusing a
 * developer because we failed to parse their version number would be worse
 * than letting them try.
 */
export function nodeVersionRefusal(version: string): string | null {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isNaN(major) || major >= LOWEST_NODE_MAJOR) return null;

  return [
    `Egma needs Node ${LOWEST_NODE_MAJOR} or newer. This machine runs Node ${version}.`,
    "",
    `Install Node ${LOWEST_NODE_MAJOR} or newer, then run egma again.`,
  ].join("\n");
}
