import { randomBytes } from "node:crypto";

import pg from "pg";

import { seedGraderLibrary } from "../../src/access/grader-library.ts";
import { connect, disconnect } from "../../src/client.ts";
import { runMigrations } from "../../src/migrate.ts";
import {
  MAINTENANCE_DATABASE_URL as MAINTENANCE_URL,
  TEST_DATABASE_PREFIX,
} from "./store-urls.ts";

/**
 * Every guarantee under test is a Postgres-specific behaviour — `COLLATE "C"`,
 * citext, composite foreign keys, check constraints, advisory locks — so tests
 * run against a real Postgres and never a substitute.
 *
 * Each test file owns a database of its own, created here and dropped
 * afterwards, so a file can migrate from empty without disturbing another.
 */

export const MAINTENANCE_DATABASE_URL = MAINTENANCE_URL;

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
  const name = `${TEST_DATABASE_PREFIX}${label}_${randomBytes(4).toString("hex")}`;
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

  const pool = new pg.Pool({ connectionString: database.url, max: 4 });

  return {
    ...database,
    sql: (text, values) => pool.query(text, values as unknown[] | undefined),
    async close() {
      await pool.end();
    },
    async drop() {
      await pool.end().catch(() => undefined);
      await database.drop();
    },
  };
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
 *
 * **Egma's own graders are on the shelf before anything else happens**, exactly
 * as they are on a real deployment: the API writes them from the catalog in the
 * same breath as applying its migrations, and every project created afterwards
 * is seeded with a copy of one — so a harness that skipped this would refuse the
 * first project it made, and refuse it for a reason no test is about.
 */
export async function createConnectedDatabase(
  label: string,
  options: {
    /**
     * Off for the one file that is *about* the seeding, which needs the shelf
     * empty to watch the first run fill it. Every other file wants what a
     * deployment has.
     */
    readonly seedGraders?: boolean;
  } = {},
): Promise<MigratedDatabase> {
  const database = await createMigratedDatabase(label);
  connect({ databaseUrl: database.url, encryptionKey: TEST_ENCRYPTION_KEY });
  if (options.seedGraders !== false) await seedGraderLibrary();

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
  /**
   * What `on delete restrict` raises, and deliberately its own code rather
   * than the foreign-key one above: a delete refused because something still
   * points at the row is a different fact from a write naming a row that was
   * never there, and a test asserting one must not pass on the other.
   */
  restrictViolation: "23001",
  checkViolation: "23514",
  /** What a lifecycle-guard trigger raises: `raise exception`'s own code. */
  raiseException: "P0001",
} as const;
