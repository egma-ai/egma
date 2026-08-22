import { dedicatedConnection } from "../client.ts";

/**
 * Which process, out of however many are running, is the one that drains.
 *
 * **One drainer per deployment is a correctness rule, not a tuning choice.**
 * Two processes walking the same pending prefix can each read the trace store,
 * each find an identity absent, and each then write a different account of one
 * immutable span — because neither one's write was visible when the other
 * looked. The integrity check that is supposed to refuse exactly that cannot
 * see a write that has not landed yet. Nothing else in this design has that
 * shape: acceptance is safe on every process because an object is immutable and
 * a replay of one is a no-op, and Retell polling is safe because every selected
 * agent is leased before a provider request. Draining is the one place where
 * "more than one" is wrong.
 *
 * **A session-scoped Postgres advisory lock, and nothing new.** It is held on a
 * connection of this process's own, so it is released by Postgres the moment
 * that connection goes — including when the process is killed, which is the
 * case a lease with a timeout has to be tuned for and this one does not. A
 * process that does not get it is not broken and does not stop: it keeps its
 * scan loop, drains nothing, asks again on the next interval, and reports
 * itself as standing by.
 *
 * **It takes no tenancy, because there is nothing here to scope.** The claim is
 * one per deployment rather than one per customer: the pending prefix holds
 * every project's evidence and the process that walks it walks all of it. The
 * same reason the channel subscription beside it takes none.
 */

/**
 * The key, and why it is this one: `egma` read as ASCII, then 2 for the
 * drainer. The migration runner is 1 in the same namespace, which is the only
 * other advisory lock this codebase takes at boot; keeping them in one
 * namespace means a person reading `pg_locks` sees egma's own locks together
 * and can tell which is which.
 */
export const DRAIN_ADVISORY_LOCK = {
  namespace: 0x65676d61,
  id: 2,
} as const;

/** The one drain claim, from the point of view of the process holding it. */
export type DrainOwnership = {
  /** True while this process is the deployment's drainer. */
  readonly held: boolean;
  /**
   * Ask for the claim, or confirm the one already held. Answers what `held`
   * will say afterwards. Safe to call on every scan interval: a process that
   * has it does not ask again, so the lock is taken exactly once per session.
   */
  take(): Promise<boolean>;
  /** Give it up, and close the connection that held it. */
  release(): Promise<void>;
};

export async function openDrainOwnership(): Promise<DrainOwnership> {
  const client = dedicatedConnection();
  // A connection that dies must not become an unhandled rejection, and must not
  // be believed afterwards. Postgres has already dropped the lock at that
  // point, so the honest state is "not held" and the next interval asks again.
  let broken = false;
  client.on("error", () => {
    broken = true;
  });
  await client.connect();

  let held = false;
  let closed = false;

  const ownership: DrainOwnership = {
    get held() {
      return held && !broken && !closed;
    },
    async take() {
      if (closed) return false;
      if (held && !broken) return true;
      if (broken) return false;
      try {
        const answer = await client.query<{ taken: boolean }>(
          "select pg_try_advisory_lock($1, $2) as taken",
          [DRAIN_ADVISORY_LOCK.namespace, DRAIN_ADVISORY_LOCK.id],
        );
        held = answer.rows[0]?.taken === true;
      } catch {
        // Postgres is unreachable or the connection went. Standing by is the
        // truthful answer, and it costs one scan interval to find out again.
        held = false;
      }
      return held;
    },
    async release() {
      closed = true;
      held = false;
      await client.end().catch(() => undefined);
    },
  };
  return ownership;
}
