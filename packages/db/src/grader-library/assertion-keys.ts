/**
 * The shape of the `expected_behaviors` grader's assertion keys — written once,
 * and read back by the function directly beneath the one that writes it.
 *
 * **Both halves live here because a key is a round trip.** The engine mints one
 * when it records nested assertion details; a page parses one back when it fetches the
 * words behind it. Those are different processes in different packages, and for
 * a while they were also different files that each knew the spelling
 * `behavior_<n>` — which is a format nothing held together, free to be improved
 * on one side and left alone on the other. A grade row is permanent, so a fork
 * there is not a bug that gets noticed: it is a page that quietly stops
 * resolving last month's rows.
 *
 * **The key is a position, one-based, and never content.** One grade row can
 * hold several assertion details, so a key derived from what a person typed
 * would stop matching after the sentence changed. Positions are stable exactly
 * as far as they need to be: a conversation is graded against the frozen test version it was executed
 * against, so within one version position 3 is the same sentence forever.
 */

/** The prefix and the shape, in one place, so the two halves cannot disagree. */
const BEHAVIOR_KEY = /^behavior_(\d+)$/u;

/**
 * What one nested assertion detail files the behavior at this index under.
 *
 * @param at The behavior's index in the version's list, counting from nought.
 */
export function behaviorAssertionKey(at: number): string {
  return `behavior_${at + 1}`;
}

/**
 * Which behavior a key is about, counting from nought — or nothing at all where
 * the key is not one of this grader's.
 *
 * The exact inverse of the line above, and its neighbour so that an edit to one
 * has the other in front of it. A key in any other shape is a key this cannot
 * read, which is a fact to report rather than a case to be clever about: the
 * caller shows the key itself, because a plausible wrong sentence is worse than
 * a terse right one.
 */
export function behaviorAssertionAt(assertion: string): number | undefined {
  const digits = BEHAVIOR_KEY.exec(assertion)?.[1];
  if (digits === undefined) return undefined;

  const position = Number(digits);
  // One-based on the wire, so position 1 is the first sentence. A nought, or a
  // number too large to hold exactly, is a key nothing ever wrote.
  return Number.isSafeInteger(position) && position > 0
    ? position - 1
    : undefined;
}
