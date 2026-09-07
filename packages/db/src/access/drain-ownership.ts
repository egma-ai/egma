import type pg from "pg";

import { dedicatedConnection } from "../client.ts";

/**
 * Allow one ingestion drainer per deployment. Concurrent drainers could both
 * accept conflicting versions of an immutable span before either write is visible.
 * Hold a session advisory lock on a dedicated Postgres connection. Standby processes
 * retry each interval; Postgres releases the lock when its session ends.
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
   * Reconnect after a lost session and clear the held flag. A disconnected session
   * no longer proves ownership of the advisory lock.
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
     * Check session liveness even when held is true; a lost session may have released
     * the lock. Use SELECT 1 for a held lock to avoid stacking advisory lock acquisitions.
     * Otherwise attempt to acquire it.
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
