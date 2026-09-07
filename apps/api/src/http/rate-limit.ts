/**
 * Fixed-window limits keyed by resolved organization, so rotating API keys
 * does not reset a budget. Counters are local to this process: each replica
 * has a separate allowance, and restart clears its counters.
 */

export type RateLimitVerdict = {
  readonly allowed: boolean;
  /** How long to wait before the window turns over. */
  readonly retryAfterSeconds: number;
};

export type RateLimit = {
  /** Whether this organization may make one more request right now. */
  reached(organizationId: string): RateLimitVerdict;
};

export type RateLimitOptions = {
  /** Requests one organization may make per window. */
  readonly limit: number;
  readonly windowMilliseconds: number;
  /** The clock, so a test does not have to wait out a window. */
  readonly now?: () => number;
};

type Window = { startedAt: number; count: number };

/**
 * Windows are dropped once they are stale, so an instance that has served a
 * hundred thousand organizations is not still holding a counter for each.
 */
const SWEEP_EVERY = 1000;

export function fixedWindowRateLimit(options: RateLimitOptions): RateLimit {
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();
  let sinceSweep = 0;

  return {
    reached(organizationId) {
      const at = now();

      sinceSweep += 1;
      if (sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        for (const [key, window] of windows) {
          if (at - window.startedAt >= options.windowMilliseconds) {
            windows.delete(key);
          }
        }
      }

      const current = windows.get(organizationId);
      const window =
        current === undefined ||
        at - current.startedAt >= options.windowMilliseconds
          ? { startedAt: at, count: 0 }
          : current;
      windows.set(organizationId, window);

      window.count += 1;

      const remaining = options.windowMilliseconds - (at - window.startedAt);
      return {
        allowed: window.count <= options.limit,
        retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
      };
    },
  };
}
