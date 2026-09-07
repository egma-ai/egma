import { randomBytes } from "node:crypto";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { runClickHouseMigrations } from "../../src/clickhouse/migrate.ts";
import {
  MAINTENANCE_CLICKHOUSE_URL as MAINTENANCE_URL,
  TEST_DATABASE_PREFIX,
} from "./store-urls.ts";

/**
 * Use real ClickHouse to test engine behavior. Each test file gets a
 * separate database, migrated from empty and dropped during teardown.
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

/** Raw rows from a store without keeping a shared client open. */
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
  migrationsDirectory?: string,
): Promise<MigratedTraceStore> {
  const store = await createEmptyTraceStore(label);
  await runClickHouseMigrations(store.url, migrationsDirectory);

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
