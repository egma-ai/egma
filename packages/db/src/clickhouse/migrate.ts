import path from "node:path";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import {
  readMigrations,
  type Migration,
  type MigrationResult,
} from "../migrate.ts";

/**
 * The trace store's migrations apply on boot from numbered plain SQL files, the
 * same mechanism and the same file convention as the Postgres side. There is no
 * second migration tool, no migration container, and no step for a self-hoster
 * to forget.
 *
 * Two things differ, and both come from ClickHouse rather than from taste:
 *
 * - **There is no transaction to wrap a file in.** A file that fails halfway
 *   leaves what it already did behind, so every statement in a ClickHouse
 *   migration must be written to survive being run again — `IF NOT EXISTS`, and
 *   never a bare `CREATE`. The next boot then finishes the file rather than
 *   tripping over its own first half.
 * - **There is no advisory lock either.** Two instances starting at the same
 *   moment may both apply; because every statement is idempotent and the ledger
 *   collapses a repeated record, they arrive at the same schema. What the
 *   Postgres side gets from the lock, this side gets from the statements.
 */

export const CLICKHOUSE_MIGRATIONS_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "..",
  "clickhouse-migrations",
);

/**
 * ClickHouse has databases where Postgres has schemas, and the deployment
 * points at one database, so the ledger lives in it beside the tables it
 * records rather than in a namespace of its own.
 */
const BOOKKEEPING_TABLE = "egma_meta_migration";

/**
 * What separates two statements in a migration file. The Postgres files already
 * carry this marker, so the repository has one convention rather than two; here
 * it is load-bearing, because ClickHouse's HTTP interface runs one statement per
 * request.
 */
const STATEMENT_SEPARATOR = "--> statement-breakpoint";

export async function runClickHouseMigrations(
  clickhouseUrl: string,
  directory: string = CLICKHOUSE_MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);
  const client = createClient({ url: clickhouseUrl, max_open_connections: 1 });
  try {
    return await apply(client, migrations);
  } finally {
    await client.close();
  }
}

/** The statements of one file, in order, with the trailing semicolons off. */
function statementsOf(migration: Migration): string[] {
  return migration.sql
    .split(STATEMENT_SEPARATOR)
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter((statement) => statement.replace(/--[^\n]*/g, "").trim() !== "");
}

async function apply(
  client: ClickHouseClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  // `ReplacingMergeTree` here and nowhere near `spans`: this table is one row
  // per migration file, so collapsing a repeat costs nothing, and it is what
  // makes two instances applying at once end up with one record each.
  await client.command({
    query: `
      create table if not exists ${BOOKKEEPING_TABLE} (
        name       String,
        hash       String,
        applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      engine = ReplacingMergeTree(applied_at)
      order by name
    `,
  });

  const recorded = await client.query({
    query: `select name, hash from ${BOOKKEEPING_TABLE} final`,
    format: "JSONEachRow",
  });
  const alreadyApplied = new Map(
    (await recorded.json<{ name: string; hash: string }>()).map(
      (row) => [row.name, row.hash] as const,
    ),
  );

  const applied: string[] = [];

  for (const migration of migrations) {
    const knownHash = alreadyApplied.get(migration.name);

    if (knownHash !== undefined) {
      if (knownHash !== migration.hash) {
        throw new Error(
          `migration ${migration.name} has changed since it was applied; ` +
            `applied migrations are immutable, add a new file instead`,
        );
      }
      continue;
    }

    for (const statement of statementsOf(migration)) {
      try {
        await client.command({ query: statement });
      } catch (cause) {
        throw new Error(`migration ${migration.name} failed`, { cause });
      }
    }

    await client.insert({
      table: BOOKKEEPING_TABLE,
      values: [{ name: migration.name, hash: migration.hash }],
      format: "JSONEachRow",
    });

    applied.push(migration.name);
  }

  return { applied, alreadyApplied: [...alreadyApplied.keys()] };
}
