/**
 * Shared expected-behaviors assertion keys: behavior_<one-based position>.
 * Keep encoding and parsing compatible with stored grades. Resolve each position
 * against the simulation's pinned test version, never the current test content.
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
 * Return the zero-based behavior index, or undefined for an unrecognized key.
 * Callers should show an unknown key as-is rather than guess its behavior.
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
