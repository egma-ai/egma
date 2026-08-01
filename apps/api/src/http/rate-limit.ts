/**
 * How much of egma one customer may ask for at once.
 *
 * **Keyed on the resolved organization, never on the credential.** A customer
 * rotating a key — mint, deploy, revoke — must not find that their budget reset
 * itself, and a customer running ten keys across ten deployments must not get
 * ten budgets. The organization is the unit that is being served and therefore
 * the unit that is being limited, and it is resolved from the credential before
 * this is consulted, so there is nothing a client can send to be counted as
 * somebody else.
 *
 * A fixed window in this process's memory, deliberately. It is the cheapest
 * thing that answers the question, it needs no second datastore on a
 * self-hoster's machine, and its one weakness — two instances each allowing a
 * full budget — is a factor-of-two on a limit that exists to stop a runaway
 * loop rather than to meter billing. A shared counter is a change to this file
 * whenever something needs one.
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
