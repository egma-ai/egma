/**
 * What a claimant is called, for both claim registers.
 *
 * Two standing services claim work here now — the simulator takes queued
 * simulations, the grader takes finished conversations — and they name
 * themselves on the same terms. One function rather than one per register, so
 * the two cannot drift into disagreeing about what a claimant's name may be.
 */

/** How long a claimant's name for itself may be. */
const LONGEST_CLAIMANT_NAME = 200;

/**
 * The claimant's name for itself, as it will be stored: trimmed, non-empty,
 * short enough to be a label. An operational identifier, never an identity in
 * egma's tables — two replicas telling each other apart is all it is for.
 */
export function validClaimant(claimant: string): string {
  const trimmed = claimant.trim();
  if (trimmed === "") throw new Error("a claimant needs a name");
  if (trimmed.length > LONGEST_CLAIMANT_NAME) {
    throw new Error(`a claimant's name fits in ${LONGEST_CLAIMANT_NAME} characters`);
  }
  return trimmed;
}
