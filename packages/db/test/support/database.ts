import { randomBytes } from "node:crypto";

import pg from "pg";

import { connect, disconnect } from "../../src/client.ts";
import { runMigrations } from "../../src/migrate.ts";

/**
 * Every guarantee under test is a Postgres-specific behaviour — `COLLATE "C"`,
 * citext, composite foreign keys, check constraints, advisory locks — so tests
 * run against a real Postgres and never a substitute.
 *
 * Each test file owns a database of its own, created here and dropped
 * afterwards, so a file can migrate from empty without disturbing another.
 */

export const MAINTENANCE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://egma:egma@localhost:5433/egma";

function urlFor(databaseName: string): string {
  const url = new URL(MAINTENANCE_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function onMaintenanceConnection<T>(
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export type EmptyDatabase = {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
};

export async function createEmptyDatabase(label: string): Promise<EmptyDatabase> {
  const name = `egma_test_${label}_${randomBytes(4).toString("hex")}`;
  await onMaintenanceConnection((client) =>
    client.query(`create database "${name}"`),
  );

  return {
    name,
    url: urlFor(name),
    async drop() {
      await onMaintenanceConnection((client) =>
        client.query(`drop database if exists "${name}" with (force)`),
      );
    },
  };
}

export type MigratedDatabase = EmptyDatabase & {
  /** Deliberately raw SQL: these tests bypass every application code path. */
  sql<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
  close(): Promise<void>;
};

export async function createMigratedDatabase(
  label: string,
): Promise<MigratedDatabase> {
  const database = await createEmptyDatabase(label);
  await runMigrations(database.url);

  const pool = quietPool({ connectionString: database.url, max: 4 });

  return {
    ...database,
    sql: (text, values) => pool.query(text, values as unknown[] | undefined),
    async close() {
      await pool.end();
    },
    async drop() {
      await pool.end().catch(() => undefined);
      // Only now: dropping is `with (force)`, which terminates whatever backend
      // is still attached, and a client that was mid-`end()` when its backend
      // went would raise 57P01 with nobody left to hear it.
      await database.drop();
    },
  };
}

/**
 * A pool that cannot take the test run down with it.
 *
 * Teardown here is a race by design: `pool.end()` closes each client, and the
 * `drop database … with (force)` right behind it terminates any backend still
 * attached. A client caught between the two raises `57P01`, which pg surfaces
 * as an `error` event on the pool — and an `error` event with **no listener at
 * all** is an uncaught exception in Node, which vitest reports as an unhandled
 * error and fails the whole run over, in whichever unlucky file happened to be
 * tearing down at the time. It made the suite red about one run in three, in a
 * different file each time.
 *
 * So every pool a test opens listens, and says nothing: at this point in a
 * test's life a dropped connection is the point rather than a fault.
 */
export function quietPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on("error", () => undefined);
  return pool;
}

/**
 * The same, for a test that holds one connection itself.
 *
 * A `pg.Client` carries the identical trap: `error` with no listener is an
 * uncaught exception, and awaiting `end()` before the drop does not close the
 * window — the backend can be terminated while a statement is still in flight,
 * or the drop can land first when a test fails part way and skips its own
 * cleanup. This is not `openSingleConnection`, which hands back a narrow
 * `sql`/`close` pair: a test that wants `client.query<Row>` typed to its own
 * row shape gets the client itself, already listening.
 */
export function quietClient(url: string): pg.Client {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => undefined);
  return client;
}

/**
 * The master key the connected module seals credentials under in tests. Fixed
 * and well-formed — 32 bytes as 64 hex characters — because the tests assert
 * what sealing does, never that this particular key is secret.
 */
export const TEST_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

/**
 * A migrated database that the data-access module is connected to, for the
 * tests that go through it. The raw `sql` handle stays available so a test can
 * check what actually landed in the table without asking the module to tell it.
 */
export async function createConnectedDatabase(
  label: string,
): Promise<MigratedDatabase> {
  const database = await createMigratedDatabase(label);
  connect({ databaseUrl: database.url, encryptionKey: TEST_ENCRYPTION_KEY });

  return {
    ...database,
    async drop() {
      await disconnect();
      await database.drop();
    },
  };
}

export type SingleConnection = {
  /** Raw SQL on one connection, so `begin` and `commit` mean something. */
  sql<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
  close(): Promise<void>;
};

/**
 * One connection, held open, for the tests that need a transaction of their
 * own — a pool routes each statement wherever it likes, which makes `begin`
 * and `commit` land on different sessions.
 */
export async function openSingleConnection(
  url: string,
): Promise<SingleConnection> {
  const client = new pg.Client({ connectionString: url });
  // Same reason as `quietPool`: a client whose backend is terminated under it
  // at teardown must not turn a passing run into an uncaught exception.
  client.on("error", () => undefined);
  await client.connect();
  return {
    sql: (text, values) => client.query(text, values as unknown[] | undefined),
    close: () => client.end(),
  };
}

/**
 * The Postgres error code a failed constraint arrived as. Walks the `cause`
 * chain, because a query layer may wrap the driver's error in its own. The
 * walk is capped, so a circular chain cannot hang the test process.
 */
export function errorCodeOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current) return String((current as { code: unknown }).code);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const POSTGRES_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  /** What a lifecycle-guard trigger raises: `raise exception`'s own code. */
  raiseException: "P0001",
} as const;
