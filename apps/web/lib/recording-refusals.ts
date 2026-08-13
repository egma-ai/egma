/**
 * Whether a refusal of a recording is worth saying out loud.
 *
 * It is the whole of what the player decides for itself, so it is here rather
 * than inside the component: a rule carried only by a render branch is a rule
 * nothing can test, and this one has been got wrong twice already.
 *
 * The shape of the problem. Two surfaces ask egma to turn a conversation's
 * recording into a link, and they are not asking the same question. A run's
 * results **already know** there is one — the run's own answer said so — so any
 * refusal there contradicts what the page was just told. One transcript knows
 * only which simulation it is; asking *is* how it discovers whether there is
 * anything to hear, and a chat and a call that never connected are ordinary
 * answers rather than faults. Those get nothing at all: not a disabled control,
 * not an error, nothing — because a control that does nothing reads as a broken
 * feature, and a sentence beside every chat is that control wearing words.
 *
 * **Silence is bought for that one case and no other**, and the two ways of
 * over-buying it are the two bugs this has had. A store nobody configured, a
 * fault, an egma that cannot be reached, a row carrying a corrupt reference —
 * every one of those is about *egma* rather than about the conversation, and a
 * broken deployment that looks exactly like a product working correctly is the
 * failure the whole recordings effort exists to end. And a refusal arriving
 * **after** a link had already worked is never quiet either: by then somebody
 * has a player on screen, and one that vanishes without a word is worse than
 * the error it hides.
 */

/**
 * The codes this route answers with when there is nothing to hear and there
 * never was: `not_found` is *no simulation of yours has that id* and *this one
 * recorded nothing*; `unprocessable` is *a chat has no audio and never will*.
 *
 * **Codes, and never the status alone.** Fastify's own not-found reply carries
 * a `message` and a 404 — so does an API gateway's, and so does a proxy that
 * has stopped forwarding this path — and every one of those is a broken
 * deployment rather than a conversation without audio. That misconfiguration
 * has happened once already on this exact route. A code is the API's promise
 * (`apps/api/src/http/refusals.ts`: *the codes are contract and never change;
 * the sentences improve deliberately*), so a code is what this reads.
 *
 * A refusal egma answers with any other code — including a reference it will
 * not sign, which is a defect and has `unsignable_reference` of its own — is
 * shown. Anything unrecognised is shown too, which is the safe direction: a new
 * refusal is heard until somebody decides it is an absence.
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
