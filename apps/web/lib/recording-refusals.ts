/**
 * Hide expected recording absence only while availability is unknown. Once
 * a recording is known to exist or a player has worked, show failures instead
 * of silently removing it. Configuration and transport failures remain visible.
 */

/**
 * Treat only the API codes not_found and unprocessable as expected absence.
 * HTTP status alone could come from a broken proxy route. Show unknown codes
 * and unsignable references as failures.
 */
export const NOTHING_TO_HEAR: ReadonlySet<string> = new Set([
  "not_found",
  "unprocessable",
]);

export type RecordingRefusal = {
  /**
   * egma's own refusal code, or `undefined` for an answer that did not come
   * from egma at all — a proxy's page, a body that would not parse, a request
   * that never arrived.
   */
  readonly code: string | undefined;
};

export type WhoIsAsking = {
  /**
   * Whether this surface already knew there was a recording. A run's results
   * do; a transcript does not.
   */
  readonly knownToExist: boolean;
  /**
   * Whether a link had already resolved and been handed to the player before
   * this refusal. Only a player on screen can ask for a second one.
   */
  readonly afterOneWorked: boolean;
};

/** Whether this refusal is answered by showing nothing at all. */
export function offersNothing(
  refusal: RecordingRefusal,
  asking: WhoIsAsking,
): boolean {
  if (asking.knownToExist || asking.afterOneWorked) return false;
  return refusal.code !== undefined && NOTHING_TO_HEAR.has(refusal.code);
}
