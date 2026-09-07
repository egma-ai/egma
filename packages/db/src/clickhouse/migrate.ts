import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ClickHouseError,
  createClient,
  type ClickHouseClient,
} from "@clickhouse/client";

import {
  pendingMigrations,
  readMigrations,
  type Migration,
  type MigrationResult,
} from "../migrate.ts";

/**
 * Apply numbered SQL migrations on boot using the shared migration ledger rules.
 * ClickHouse files are not transactional and may run concurrently on separate
 * instances. Every statement must tolerate replay after partial or concurrent
 * application; record the file hash only after all statements finish.
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

/**
 * Replicated ClickHouse tables publish an ALTER to shared metadata before each
 * replica necessarily observes it. A following ALTER can therefore receive
 * CANNOT_ASSIGN_ALTER with an explicit instruction to retry. Ten seconds of
 * bounded backoff fits inside the deployment health window without turning an
 * unrelated migration error into a loop.
 */
const REPLICA_CATCHUP_ATTEMPTS = 8;
const REPLICA_CATCHUP_FIRST_WAIT_MS = 250;
const REPLICA_CATCHUP_MAX_WAIT_MS = 2_000;

/**
 * ClickHouse Cloud may need one request to wake after an idle period. The
 * client gives that request a precise timeout error. Every migration statement
 * is idempotent, so a bounded rerun can finish whatever the timed-out request
 * may already have applied without hiding a different startup failure.
 */
const CLOUD_WAKE_ATTEMPTS = 3;
const CLOUD_WAKE_WAIT_MS = 1_000;

export async function runClickHouseMigrations(
  clickhouseUrl: string,
  directory: string = CLICKHOUSE_MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);

  for (let attempt = 1; attempt <= CLOUD_WAKE_ATTEMPTS; attempt += 1) {
    const client = createClient({
      url: clickhouseUrl,
      max_open_connections: 1,
    });
    try {
      return await apply(client, migrations);
    } catch (cause) {
      if (!requestTimedOut(cause) || attempt === CLOUD_WAKE_ATTEMPTS) {
        throw cause;
      }
    } finally {
      await client.close();
    }

    await sleep(CLOUD_WAKE_WAIT_MS);
  }

  throw new Error("unreachable ClickHouse migration retry state");
}

function requestTimedOut(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message === "Timeout error." || requestTimedOut(cause.cause))
  );
}

/** The statements of one file, in order, with the trailing semicolons off. */
function statementsOf(migration: Migration): string[] {
  return migration.sql
    .split(STATEMENT_SEPARATOR)
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter((statement) => statement.replace(/--[^\n]*/g, "").trim() !== "");
}

function replicaIsCatchingUp(cause: unknown): cause is ClickHouseError {
  return (
    cause instanceof ClickHouseError &&
    cause.code === "517" &&
    cause.type === "CANNOT_ASSIGN_ALTER"
  );
}

async function applyStatement(
  client: ClickHouseClient,
  statement: string,
): Promise<void> {
  for (let attempt = 1; attempt <= REPLICA_CATCHUP_ATTEMPTS; attempt += 1) {
    try {
      await client.command({ query: statement });
      return;
    } catch (cause) {
      if (
        !replicaIsCatchingUp(cause) ||
        attempt === REPLICA_CATCHUP_ATTEMPTS
      ) {
        throw cause;
      }

      await sleep(
        Math.min(
          REPLICA_CATCHUP_FIRST_WAIT_MS * 2 ** (attempt - 1),
          REPLICA_CATCHUP_MAX_WAIT_MS,
        ),
      );
    }
  }
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

  for (const migration of pendingMigrations(migrations, alreadyApplied)) {
    for (const statement of statementsOf(migration)) {
      try {
        await applyStatement(client, statement);
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
