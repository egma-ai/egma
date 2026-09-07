/**
 * Mark displayed credentials for replay text masking, including descendants.
 * PostHog maskAllInputs separately covers input values.
 */
export const REPLAY_PRIVATE_ATTRIBUTE = "data-replay-private";

/** The same mark, as PostHog wants it. */
export const REPLAY_PRIVATE_SELECTOR = `[${REPLAY_PRIVATE_ATTRIBUTE}]`;

/** Spread onto the element whose text replay must not read. */
export const REPLAY_PRIVATE = { [REPLAY_PRIVATE_ATTRIBUTE]: "" } as const;
