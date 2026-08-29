/**
 * The few things session replay is not allowed to read.
 *
 * **The policy used to be the other way round.** Replay masked every word on
 * every page, every input, and every attribute that could carry a word. What
 * came back was a recording of grey blocks — an agent's page and a run's page
 * were the same picture, so a replay answered no question anybody had. A replay
 * that hides the product is not a careful replay, it is a broken one
 * (developer decision, 2026-08-28).
 *
 * So replay records the product, and this module names the exception. There is
 * one, and it is a secret drawn where a person can read it:
 *
 * - **The API key**, in the moment it is minted and shown once.
 * - **The credential headers**, typed into a box rather than a password field
 *   because somebody has to see the JSON they are pasting.
 *
 * A password field needs no mark: `instrumentation-client.ts` knows one by its
 * type and its autocomplete, so it stays masked even in the second somebody
 * presses the reveal control and the type says `text`.
 *
 * **Production traces are recorded like everything else** (developer decision,
 * 2026-08-29). The Traces screens show a customer's end user talking to a
 * customer's agent, and hiding them was this module's first exception. It is
 * gone on purpose: the screens are new, watching somebody use them is how they
 * get fixed, and a masked screen teaches nothing about the screen. See
 * `egma-planning/docs/adr/0021-session-replay-records-the-product.md`, which
 * records what that costs and what would bring the mask back.
 *
 * **One mark carries the policy**, and it is a plain attribute rather than a
 * PostHog class so the markup says what it means rather than which vendor is
 * reading it. `instrumentation-client.ts` hands the same selector to PostHog
 * three times — for text, for inputs and for attributes — so a region marked
 * once is masked in all three. rrweb inherits masking down the tree, so marking
 * an element marks everything drawn inside it, including what arrives after the
 * recording started.
 */
export const REPLAY_PRIVATE_ATTRIBUTE = "data-replay-private";

/** The same mark, as PostHog and `Element.closest` want it. */
export const REPLAY_PRIVATE_SELECTOR = `[${REPLAY_PRIVATE_ATTRIBUTE}]`;

/**
 * Spread onto the element whose contents replay must not read.
 *
 * Spread rather than written out, so a surface cannot half-remember the
 * attribute's name and mark nothing while looking marked.
 */
export const REPLAY_PRIVATE = { [REPLAY_PRIVATE_ATTRIBUTE]: "" } as const;

/**
 * Whether this element is inside a marked region — itself counting as inside.
 *
 * `closest` rather than a walk of our own: the mark is meant to cover a subtree,
 * and PostHog hands these functions the element rather than the region.
 */
export function isReplayPrivate(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  return element.closest(REPLAY_PRIVATE_SELECTOR) !== null;
}
