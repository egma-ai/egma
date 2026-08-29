/**
 * The one thing session replay is not allowed to read: a secret drawn where a
 * person can read it.
 *
 * Replay used to mask every word on every page, and the recordings were grey
 * blocks that answered nothing. It records the pages now, so this mark is what
 * is left of the old policy — it goes on the element holding a live credential,
 * and `instrumentation-client.ts` hands the selector to PostHog as the only
 * text it masks. rrweb inherits masking down the tree, so the mark covers
 * whatever is inside the element.
 *
 * A password field needs no mark. Every input in the product stays masked by
 * PostHog's own `maskAllInputs`, so the mark is for text on the page.
 */
export const REPLAY_PRIVATE_ATTRIBUTE = "data-replay-private";

/** The same mark, as PostHog wants it. */
export const REPLAY_PRIVATE_SELECTOR = `[${REPLAY_PRIVATE_ATTRIBUTE}]`;

/** Spread onto the element whose text replay must not read. */
export const REPLAY_PRIVATE = { [REPLAY_PRIVATE_ATTRIBUTE]: "" } as const;
