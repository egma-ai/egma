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
  database = drizzle(pool, { schema, casing: "snake_case" });
}

export async function disconnect(): Promise<void> {
  const open = pool;
  pool = undefined;
  database = undefined;
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
