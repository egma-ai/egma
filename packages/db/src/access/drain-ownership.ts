import type pg from "pg";

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
   * will say afterwards. Safe to call as often as a pass likes: a session that
   * already holds it is asked only whether it is still alive, so the lock is
   * taken exactly once and never stacked.
   */
  take(): Promise<boolean>;
  /**
   * Give up the claim but keep the connection, so a later pass can take it
   * again. For a process that holds the lock and finds it has nothing it may
   * drain — a trace store not yet ready — and must let a healthy instance take
   * over rather than hold the deployment's one claim behind a green health
   * check.
   */
  unlock(): Promise<void>;
  /** Give it up for good, and close the connection that held it. */
  release(): Promise<void>;
};

export async function openDrainOwnership(): Promise<DrainOwnership> {
  let client: pg.Client | undefined;
  let held = false;
  let closed = false;

  /**
   * The connection this claim lives on, built if there is not one.
   *
   * **A dead connection is a lost lock and nothing more.** Postgres drops the
   * lock the moment the session goes, so the honest state afterwards is "not
   * held" — and the honest next step is to connect again and ask. A process
   * that remembered the failure instead would stand by for the rest of its
   * life over one dropped socket, which on the single-instance deployment
   * everybody actually runs means draining stops until somebody restarts it.
   */
  const connected = async (): Promise<pg.Client> => {
    const open = client;
    if (open !== undefined) return open;
    const fresh = dedicatedConnection();
    // Registered before connecting, because a connection that dies has to
    // arrive here rather than at an unhandled rejection.
    fresh.on("error", () => {
      if (client === fresh) {
        client = undefined;
        held = false;
      }
      fresh.end().catch(() => undefined);
    });
    await fresh.connect();
    client = fresh;
    return fresh;
  };

  // Opened here so that a deployment whose database is unreachable at boot
  // fails where it can be seen, rather than standing by silently.
  await connected();

  const ownership: DrainOwnership = {
    get held() {
      return held && !closed && client !== undefined;
    },
    /**
     * Asked every time, including inside a pass and by the process that already
     * holds it.
     *
     * **A claim believed without asking is the dangerous one.** A session can
     * die without this process being told promptly — a failover, a reaper, a
     * network that went away — and Postgres releases the lock the moment it
     * does. A holder that short-circuited on its own memory would go on
     * believing it was the drainer while another instance took the claim, and
     * the two would walk the prefix together: exactly the arrangement this lock
     * exists to prevent, arrived at by trusting a cached answer.
     *
     * So a session that already holds it is still asked — but only whether it
     * is still alive, with a plain round trip rather than a second
     * `pg_try_advisory_lock`. A session-level lock cannot be taken by anyone
     * else while this session lives and holds it, so liveness is the whole
     * question left, and asking it that way is what keeps a per-object re-ask
     * from stacking one hold on top of another it would then have to unlock as
     * many times to release. A session that does not hold it asks for it
     * outright.
     */
    async take() {
      if (closed) return false;
      try {
        const active = await connected();
        if (held) {
          await active.query("select 1");
        } else {
          const answer = await active.query<{ taken: boolean }>(
            "select pg_try_advisory_lock($1, $2) as taken",
            [DRAIN_ADVISORY_LOCK.namespace, DRAIN_ADVISORY_LOCK.id],
          );
          held = answer.rows[0]?.taken === true;
        }
      } catch {
        // Unreachable, or the connection went while the question was in
        // flight. Standing by is the truthful answer, and the next ask
        // builds a connection and takes it again.
        client = undefined;
        held = false;
      }
      return held;
    },
    async unlock() {
      if (closed) return;
      const open = client;
      if (open === undefined) {
        held = false;
        return;
      }
      try {
        // Every advisory hold this session has, dropped at once and the
        // connection kept — so the next pass that finds it may drain again
        // takes the claim freshly rather than from a connection nobody holds.
        await open.query("select pg_advisory_unlock_all()");
      } catch {
        // The connection went while letting go. Postgres drops the lock with
        // the session, so it is released either way; the next ask rebuilds.
        client = undefined;
      }
      held = false;
    },
    async release() {
      closed = true;
      held = false;
      const open = client;
      client = undefined;
      await open?.end().catch(() => undefined);
    },
  };
  return ownership;
}
