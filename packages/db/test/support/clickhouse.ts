import { randomBytes } from "node:crypto";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { runClickHouseMigrations } from "../../src/clickhouse/migrate.ts";
import {
  MAINTENANCE_CLICKHOUSE_URL as MAINTENANCE_URL,
  TEST_DATABASE_PREFIX,
} from "./store-urls.ts";

/**
 * Every guarantee under test is a ClickHouse-specific behaviour — the sort key,
 * the partition key, what a materialised view does with a block, whether a
 * repeated insert lands twice — so tests run against a real ClickHouse and never
 * a substitute. A mocked one would confirm the strings Egma sends and nothing
 * about what they do.
 *
 * Each test file owns a database of its own, created here and dropped
 * afterwards, so a file can migrate from empty without disturbing another. This
 * is the Postgres support file's arrangement, on the store beside it.
 */

export const MAINTENANCE_CLICKHOUSE_URL = MAINTENANCE_URL;

function urlFor(databaseName: string): string {
  const url = new URL(MAINTENANCE_CLICKHOUSE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function onMaintenanceConnection<T>(
  work: (client: ClickHouseClient) => Promise<T>,
): Promise<T> {
  const client = createClient({ url: MAINTENANCE_CLICKHOUSE_URL });
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

export type EmptyTraceStore = {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
};

export async function createEmptyTraceStore(
  label: string,
): Promise<EmptyTraceStore> {
  const name = `${TEST_DATABASE_PREFIX}${label}_${randomBytes(4).toString("hex")}`;
  await onMaintenanceConnection((client) =>
    client.command({ query: `create database "${name}"` }),
  );

  return {
    name,
    url: urlFor(name),
    async drop() {
      await onMaintenanceConnection((client) =>
        client.command({ query: `drop database if exists "${name}"` }),
      );
    },
  };
}

/**
 * Raw rows from a store left empty on purpose, for the migration tests that ask
 * what a run left behind — before it ran, or after it failed. A client is
 * opened and closed per question, because the store under inspection has no
 * settled shape to keep a connection against.
 */
export async function rowsIn<Row>(
  store: EmptyTraceStore,
  query: string,
): Promise<Row[]> {
  const client = createClient({ url: store.url });
  try {
    const result = await client.query({ query, format: "JSONEachRow" });
    // Awaited here, not returned: the finally below closes the client, and an
    // unconsumed body does not survive that.
    return await result.json<Row>();
  } finally {
    await client.close();
  }
}

/** Every table the database holds, ledger included, in name order. */
export async function tablesIn(store: EmptyTraceStore): Promise<string[]> {
  const tables = await rowsIn<{ name: string }>(
    store,
    `select name from system.tables where database = '${store.name}' order by name`,
  );
  return tables.map((table) => table.name);
}

export type MigratedTraceStore = EmptyTraceStore & {
  /** Deliberately raw SQL: these tests bypass every application code path. */
  rows<Row>(query: string): Promise<Row[]>;
  /** Deliberately raw too, and the only way to see what a retry does. */
  append(table: string, values: readonly Record<string, unknown>[]): Promise<void>;
  /** DDL, for a test that needs the store to start refusing what it is sent. */
  command(query: string): Promise<void>;
  close(): Promise<void>;
};

export async function createMigratedTraceStore(
  label: string,
): Promise<MigratedTraceStore> {
  const store = await createEmptyTraceStore(label);
  await runClickHouseMigrations(store.url);

  const client = createClient({ url: store.url, max_open_connections: 4 });

  return {
    ...store,
    async rows<Row>(query: string) {
      const result = await client.query({ query, format: "JSONEachRow" });
      return result.json<Row>();
    },
    async append(table, values) {
      await client.insert({ table, values, format: "JSONEachRow" });
    },
    async command(query) {
      await client.command({ query });
    },
    async close() {
      await client.close();
    },
    async drop() {
      await client.close().catch(() => undefined);
      await store.drop();
    },
  };
}
