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

/**
 * The same query interface, for the second fenced home.
 *
 * **`ee/` is a separate package and cannot import `db()`**, which is the point
 * of `db()` — the pool is private to this directory and the package's exports
 * map offers `.` and nothing else. But the cloud billing tables' reads and
 * writes have to live in `ee/`: no shared code may read a `cloud_` table, and
 * putting them here would put them in every self-hoster's build. So this is
 * the one door out, named after what it hands over rather than after who takes
 * it, and a lint rule — `only-a-fenced-home-holds-the-query-interface` — fails
 * the build for any file outside `packages/db/src/` or `ee/src/access/` that
 * imports it. Without that rule this export would be the loophole the whole
 * boundary exists to prevent.
 *
 * It is the same handle and therefore the same pool: a transaction opened
 * through it can hold a shared row and a `cloud_` row at once, which is what a
 * balance kept in step with its ledger needs.
 */
export function fencedDatabase(): Database {
  return db();
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

/**
 * Create an unpooled session for subscriptions or advisory locks. Its owner must
 * close it; returning session state to a pool could affect an unrelated caller.
 */
export function dedicatedConnection(): pg.Client {
  const url = databaseUrl;
  if (url === undefined) throw new Error("not connected to Postgres");
  // Bounded, because nothing above this waits on a clock of its own. A TCP
  // connect with no timeout hangs on the operating system's, which is minutes,
  // and both callers here are on the path of a request somebody is waiting on.
  // Generous for establishing a connection and authenticating; a network that
  // cannot do it inside this is one whose caller deserves the error now.
  return new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
}

/** A connection held open on one channel; closing it is the only thing to do. */
export type Listening = {
  close(): Promise<void>;
};

/** How long a listener waits before rebuilding a connection that dropped. */
const RELISTEN_AFTER_MILLISECONDS = 1_000;

/**
 * Listen on a dedicated connection and reconnect after failures. Notifications
 * are wake-up hints, not durable delivery. Invoke the callback after each successful
 * connection so it can query outstanding work, including notifications missed
 * while disconnected.
 */
export async function listen(
  channel: string,
  onNotification: () => void,
  onFailure: (error: unknown) => void = () => undefined,
): Promise<Listening> {
  const url = databaseUrl;
  if (url === undefined) throw new Error("not connected to Postgres");
  // Written into the statement rather than bound: `LISTEN` takes an identifier
  // and Postgres has no parameter position for one. The channel names are this
  // module's own constants, never a caller's string.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) {
    throw new Error(`"${channel}" is not a channel name Egma raises`);
  }

  let closed = false;
  let client: pg.Client | undefined;
  let waking: NodeJS.Timeout | undefined;
  let failureReported = false;

  const reportFailure = (error: unknown): void => {
    if (failureReported) return;
    failureReported = true;
    onFailure(error);
  };

  const rebuild = (): void => {
    if (closed || waking !== undefined) return;
    waking = setTimeout(() => {
      waking = undefined;
      void establish();
    }, RELISTEN_AFTER_MILLISECONDS);
    // This wait is part of the listener's lifetime. If the dropped socket was
    // the process's last handle, keeping this timer referenced is what lets a
    // standing worker reconnect instead of exiting. `close` clears it.
  };

  const establish = async (): Promise<void> => {
    if (closed) return;
    const connecting = new pg.Client({ connectionString: url });
    // Registered before connecting, because a connection that dies has to
    // arrive here rather than at an unhandled rejection.
    connecting.on("error", (error: unknown) => {
      if (closed) return;
      reportFailure(error);
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
    } catch (error) {
      reportFailure(error);
      connecting.end().catch(() => undefined);
      rebuild();
      return;
    }

    if (closed) {
      await connecting.end().catch(() => undefined);
      return;
    }
    client = connecting;
    failureReported = false;
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
