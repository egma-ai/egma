import { createClient, type ClickHouseClient } from "@clickhouse/client";

/**
 * The ClickHouse client is private to this module and is never exported, on the
 * same terms as the Postgres pool beside it. There is one policed boundary, not
 * two: a trace read or write is a function exported from `access/` that takes an
 * `AuthContext` and injects the tenancy predicates itself.
 */
let client: ClickHouseClient | undefined;

export type ClickHouseConnectOptions = {
  readonly clickhouseUrl: string;
  readonly maxOpenConnections?: number;
};

export function connectClickHouse(options: ClickHouseConnectOptions): void {
  if (client !== undefined) throw new Error("already connected to ClickHouse");
  client = createClient({
    url: options.clickhouseUrl,
    max_open_connections: options.maxOpenConnections ?? 10,
  });
}

export async function disconnectClickHouse(): Promise<void> {
  const open = client;
  client = undefined;
  await open?.close();
}

/**
 * The query interface the trace-store functions will be built on. The client
 * behind it is never handed out, and this is deliberately not re-exported from
 * the package entry point: the package's `exports` map offers `.` and nothing
 * else, so no file outside `packages/db/src` can reach it. A lint rule fails the
 * build if one tries.
 */
export function traceStore(): ClickHouseClient {
  if (client === undefined) throw new Error("not connected to ClickHouse");
  return client;
}

/** Answers whether the trace store is reachable, and nothing else. */
export async function pingClickHouse(): Promise<void> {
  const rows = await traceStore().query({ query: "select 1", format: "JSON" });
  await rows.json();
}
