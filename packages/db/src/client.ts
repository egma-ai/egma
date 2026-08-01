import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

import * as schema from "./schema/index.ts";

/**
 * The Postgres pool is private to this module and is never exported. Reaching
 * the database from anywhere else has to go through a function exported here.
 */
let pool: pg.Pool | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

export type ConnectOptions = {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
};

export function connect(options: ConnectOptions): void {
  if (pool !== undefined) throw new Error("already connected to Postgres");
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
  await open?.end();
}

function connected(): NonNullable<typeof database> {
  if (database === undefined) throw new Error("not connected to Postgres");
  return database;
}

/** Answers whether the database is reachable, and nothing else. */
export async function ping(): Promise<void> {
  await connected().execute(sql`select 1`);
}
