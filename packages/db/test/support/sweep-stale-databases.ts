/**
 * Remove abandoned databases with the test prefix before starting the suite.
 * PostgreSQL skips databases with matching sessions and drops without FORCE.
 * ClickHouse uses schema age as a heuristic: skip unknown timestamps and
 * schemas newer than IN_USE_MINUTES. This cannot prove that an older database
 * is idle, so the cutoff must exceed the expected test-run duration.
 */

import { createClient } from "@clickhouse/client";
import pg from "pg";

import {
  MAINTENANCE_CLICKHOUSE_URL,
  MAINTENANCE_DATABASE_URL,
  TEST_DATABASE_PREFIX,
} from "./store-urls.ts";

/**
 * How recently a ClickHouse test database must have been written to for the
 * sweep to assume somebody is still using it.
 *
 * Comfortably longer than a whole suite takes, because the two mistakes are not
 * equal: leaving one database behind costs the next run nothing measurable, and
 * dropping one out from under a running suite costs somebody a whole run and an
 * afternoon deciding whether the failures were real.
 */
const IN_USE_MINUTES = 30;

/** Postgres's own code for "database is being accessed by other users". */
const IN_USE = "55006";

type Swept = { readonly dropped: readonly string[]; readonly leftAlone: number };

async function sweepPostgres(): Promise<Swept> {
  const client = new pg.Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await client.connect();
  try {
    const stale = await client.query<{ datname: string; sessions: string }>(
      `select d.datname,
              (select count(*)
                 from pg_stat_activity a
                where a.datname = d.datname
                   or a.application_name = d.datname)::text
                as sessions
         from pg_database d
        where d.datname like $1`,
      [`${TEST_DATABASE_PREFIX}%`],
    );

    const dropped: string[] = [];
    let leftAlone = 0;
    for (const { datname, sessions } of stale.rows) {
      if (Number(sessions) > 0) {
        leftAlone += 1;
        continue;
      }
      try {
        // Deliberately without `with (force)`. A session that arrived since the
        // count above is a suite that started while this was running, and the
        // right answer to that is Postgres refusing — not this terminating
        // somebody's backend mid-transaction.
        await client.query(`drop database "${datname}"`);
        dropped.push(datname);
      } catch (refused) {
        if ((refused as { code?: string }).code === IN_USE) {
          leftAlone += 1;
          continue;
        }
        throw refused;
      }
    }
    return { dropped, leftAlone };
  } finally {
    await client.end();
  }
}

async function sweepClickHouse(): Promise<Swept> {
  const client = createClient({ url: MAINTENANCE_CLICKHOUSE_URL });
  try {
    const answer = await client.query({
      // The newest metadata timestamp among a database's tables, and null for a
      // database that has none yet. Both are how old its schema is, which is
      // the only thing this store can be asked about being in use.
      query: `
        select d.name as name,
               max(t.metadata_modification_time) as touched
          from system.databases d
          left join system.tables t on t.database = d.name
         where d.name like {prefix:String}
         group by d.name`,
      query_params: { prefix: `${TEST_DATABASE_PREFIX}%` },
      format: "JSONEachRow",
    });
    const stale = await answer.json<{ name: string; touched: string | null }>();

    const cutoff = Date.now() - IN_USE_MINUTES * 60_000;
    const dropped: string[] = [];
    let leftAlone = 0;
    for (const { name, touched } of stale) {
      const touchedAt = touched === null ? NaN : Date.parse(`${touched}Z`);
      // No tables at all, or written to recently: a run happening now.
      if (Number.isNaN(touchedAt) || touchedAt > cutoff) {
        leftAlone += 1;
        continue;
      }
      await client.command({ query: `drop database if exists "${name}"` });
      dropped.push(name);
    }
    return { dropped, leftAlone };
  } finally {
    await client.close();
  }
}

const [postgres, clickhouse] = await Promise.all([
  sweepPostgres(),
  sweepClickHouse(),
]);

const dropped = postgres.dropped.length + clickhouse.dropped.length;
const leftAlone = postgres.leftAlone + clickhouse.leftAlone;
if (dropped > 0 || leftAlone > 0) {
  const kept =
    leftAlone === 0
      ? ""
      : `; left ${leftAlone} alone, in use or too recent to be nobody's`;
  process.stdout.write(
    `dropped ${dropped} stale test database(s): ` +
      `${postgres.dropped.length} in postgres, ${clickhouse.dropped.length} in ` +
      `clickhouse${kept}\n`,
  );
}
