import { randomBytes } from "node:crypto";

import pg from "pg";

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

/** The Postgres error code a failed constraint arrived as. */
export function errorCodeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export const POSTGRES_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
} as const;
