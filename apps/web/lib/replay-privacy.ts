import { activeSectionIn } from "./navigation.ts";

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
 * So replay records the product, and this module names the exceptions. An
 * exception is content that was never ours to watch, or a secret that exists
 * once:
 *
 * - **Production traces.** The Traces screens under `monitoring` show a
 *   customer's end user talking to a customer's agent. It is the one kind of
 *   content in these pages that belongs to somebody who never opened them.
 * - **A secret on the page.** The API key shown once after it is minted, and
 *   the credential headers typed into a box rather than a password field.
 *   A password field needs no mark: `instrumentation-client.ts` knows one by
 *   its type and its autocomplete, so it stays masked even while somebody is
 *   holding the reveal control down.
 *
 * Everything else — the organization's name, the navigation, the buttons, a
 * test's name, a run's rows — is recorded, because that is the whole reason to
 * keep replay switched on.
 *
 * **One mark carries all of it**, and it is a plain attribute rather than a
 * PostHog class so the markup says what it means rather than which vendor is
 * reading it. `instrumentation-client.ts` hands the same selector to PostHog
 * three times — for text, for inputs and for attributes — so a region marked
 * once is masked in all three. rrweb inherits masking down the tree, so marking
 * a page's `<main>` marks every row, sheet and control drawn inside it,
 * including the ones added after the recording started.
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

/**
 * Whether this address is one of the production-trace screens.
 *
 * Read from the address, the way the navigation reads which item is lit. A page
 * that had to remember to mark itself is a page that can forget to, and the
 * next screen added under Traces would be recorded in the clear with nothing
 * saying so.
 */
export function showsProductionTraces(pathname: string): boolean {
  return activeSectionIn(pathname) === "monitoring";
}
