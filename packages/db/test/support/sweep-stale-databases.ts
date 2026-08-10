/**
 * Drop the test databases a previous run left behind.
 *
 * Every test file that touches a store creates a database of its own named
 * `egma_test_…` and drops it when it disconnects. A file that runs out of time
 * never reaches its disconnect, so its database stays — and stale databases are
 * not merely untidy. `create database` copies a template while holding a lock,
 * and both stores get slower at it as the count climbs, so one run that timed
 * out makes the next run likelier to time out too. One observed run failed 63
 * tests across 12 files and left 31 databases behind; dropping them made the
 * next run pass.
 *
 * So the sweep runs where the stores are started — `pnpm db:up`, which `pnpm
 * test` runs first — rather than inside the suite, where a file that has
 * already claimed a name must not have it swept out from under it. Nothing here
 * touches the deployment database itself: the prefix is only ever used by the
 * test support modules beside this one.
 */

import { createClient } from "@clickhouse/client";
import pg from "pg";

import {
  MAINTENANCE_CLICKHOUSE_URL,
  MAINTENANCE_DATABASE_URL,
  TEST_DATABASE_PREFIX,
} from "./store-urls.ts";

async function sweepPostgres(): Promise<readonly string[]> {
  const client = new pg.Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await client.connect();
  try {
    const stale = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like $1",
      [`${TEST_DATABASE_PREFIX}%`],
    );
    for (const { datname } of stale.rows) {
      // `with (force)` because a stranded database may still hold the
      // connections of the process that was killed holding it.
      await client.query(`drop database if exists "${datname}" with (force)`);
    }
    return stale.rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}

async function sweepClickHouse(): Promise<readonly string[]> {
  const client = createClient({ url: MAINTENANCE_CLICKHOUSE_URL });
  try {
    const answer = await client.query({
      query: `select name from system.databases where name like {prefix:String}`,
      query_params: { prefix: `${TEST_DATABASE_PREFIX}%` },
      format: "JSONEachRow",
    });
    const stale = await answer.json<{ name: string }>();
    for (const { name } of stale) {
      await client.command({ query: `drop database if exists "${name}"` });
    }
    return stale.map((row) => row.name);
  } finally {
    await client.close();
  }
}

const [postgres, clickhouse] = await Promise.all([
  sweepPostgres(),
  sweepClickHouse(),
]);

const swept = postgres.length + clickhouse.length;
if (swept > 0) {
  process.stdout.write(
    `dropped ${swept} stale test database(s): ` +
      `${postgres.length} in postgres, ${clickhouse.length} in clickhouse\n`,
  );
}
