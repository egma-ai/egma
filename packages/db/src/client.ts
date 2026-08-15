import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

import * as schema from "./schema/index.ts";
import { holdMasterKey, releaseMasterKey } from "./sealing.ts";

/**
 * The Postgres pool is private to this module and is never exported. Reaching
 * the database from anywhere else has to go through a function exported here.
 */
let pool: pg.Pool | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;
/**
 * Kept because a listening connection cannot come out of the pool — see
 * `listen` below — and the pool is the only other thing that knows where the
 * database is.
 */
let databaseUrl: string | undefined;

export type ConnectOptions = {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
  /**
   * `EGMA_ENCRYPTION_KEY`: 32 random bytes as 64 hex characters, under which
   * connection credentials are sealed before they touch a row. It arrives
   * here — the same door the database URL does — and a malformed one refuses
   * to connect at all, so a misconfigured deployment is loud at boot. Without
   * one, everything runs except sealing and unsealing a credential.
   */
  readonly encryptionKey?: string;
};

export function connect(options: ConnectOptions): void {
  if (pool !== undefined) throw new Error("already connected to Postgres");
  if (options.encryptionKey !== undefined) {
    holdMasterKey(options.encryptionKey);
  }
  pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
  });
  // An idle pooled connection can die between checkouts — Postgres restarted,
  // a failover, or a test database force-dropped under it. pg reports that by
  // emitting `error` on the pool, and an unlistened `error` event brings the
  // whole process down for a connection nothing was even using. The pool
  // already discards the broken client and mints a fresh one on the next
  // checkout; a query in flight on that client still gets its own rejection.
  // So the listener's whole job is to exist.
  pool.on("error", () => undefined);
  databaseUrl = options.databaseUrl;
  database = drizzle(pool, { schema, casing: "snake_case" });
}

export async function disconnect(): Promise<void> {
  const open = pool;
  pool = undefined;
  database = undefined;
  databaseUrl = undefined;
  releaseMasterKey();
  await open?.end();
}

/**
 * The query interface every function in `access/` is built on. The pool behind
 * it is never handed out, and this is deliberately not re-exported from the
 * package entry point: the package's `exports` map offers `.` and nothing else,
 * so no file outside `packages/db/src` can reach it. A lint rule fails the build
 * if one tries.
 */
export function db(): Database {
  if (database === undefined) throw new Error("not connected to Postgres");
  return database;
}

export type Database = NonNullable<typeof database>;
export type Transaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * Somewhere a statement can run: the connection, or a transaction on it. A
 * write that has to be all-or-nothing opens a transaction and hands this to the
 * functions that own each table, so a table still has exactly one owner.
 */
export type Queryable = Database | Transaction;

/** Answers whether the database is reachable, and nothing else. */
export async function ping(): Promise<void> {
  await db().execute(sql`select 1`);
}

/** A connection held open on one channel; closing it is the only thing to do. */
export type Listening = {
  close(): Promise<void>;
};

/** How long a listener waits before rebuilding a connection that dropped. */
const RELISTEN_AFTER_MILLISECONDS = 1_000;

/**
 * Wake `onNotification` whenever somebody raises this Postgres channel.
 *
 * **On a connection of its own, deliberately, and not one out of the pool.** A
 * `LISTEN` belongs to the session that issued it, so a pooled connection would
 * carry the subscription back into the pool and hand it to the next unrelated
 * query — and the pool would be one connection short for as long as the
 * subscription lived, which is the process's whole lifetime.
 *
 * **The wake is a hint and never a delivery.** A notification raised while
 * nothing was connected is gone, so this calls back once on every connection it
 * establishes, including the first: whoever listens is being told "ask again",
 * and asking is a query that sees everything outstanding whether or not any
 * notification survived. That is what keeps a dropped connection, a restart and
 * a service that was not running yet from being three different bugs.
 *
 * It reaches no table and carries nothing out — a channel name goes in and a
 * nudge comes back — which is why it takes no tenancy: there is nothing here to
 * scope.
 */
export async function listen(
  channel: string,
  onNotification: () => void,
): Promise<Listening> {
  const url = databaseUrl;
  if (url === undefined) throw new Error("not connected to Postgres");
  // Written into the statement rather than bound: `LISTEN` takes an identifier
  // and Postgres has no parameter position for one. The channel names are this
  // module's own constants, never a caller's string.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) {
    throw new Error(`"${channel}" is not a channel name egma raises`);
  }

  let closed = false;
  let client: pg.Client | undefined;
  let waking: NodeJS.Timeout | undefined;

  const rebuild = (): void => {
    if (closed || waking !== undefined) return;
    waking = setTimeout(() => {
      waking = undefined;
      void establish();
    }, RELISTEN_AFTER_MILLISECONDS);
    // A pending reconnection must never hold the process open by itself: the
    // service exits when its work is done, not when its timers are.
    waking.unref();
  };

  const establish = async (): Promise<void> => {
    if (closed) return;
    const connecting = new pg.Client({ connectionString: url });
    // Registered before connecting, because a connection that dies has to
    // arrive here rather than at an unhandled rejection.
    connecting.on("error", () => {
      if (client === connecting) client = undefined;
      connecting.end().catch(() => undefined);
      rebuild();
    });
    connecting.on("notification", () => {
      if (!closed) onNotification();
    });

    try {
      await connecting.connect();
      await connecting.query(`listen ${channel}`);
    } catch {
      connecting.end().catch(() => undefined);
      rebuild();
      return;
    }

    if (closed) {
      await connecting.end().catch(() => undefined);
      return;
    }
    client = connecting;
    onNotification();
  };

  await establish();

  return {
    async close() {
      closed = true;
      if (waking !== undefined) clearTimeout(waking);
      const open = client;
      client = undefined;
      await open?.end().catch(() => undefined);
    },
  };
}
