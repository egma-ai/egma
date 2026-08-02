import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigrations } from "../src/migrate.ts";
import {
  CLICKHOUSE_MIGRATIONS_DIRECTORY,
  runClickHouseMigrations,
} from "../src/clickhouse/migrate.ts";
import {
  createEmptyTraceStore,
  createMigratedTraceStore,
  type EmptyTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/** The filing order and the partition key, settled and effectively irreversible. */
const SORTING_KEY =
  "organization_id, project_id, toStartOfMinute(started_at), xxHash32(trace_id), span_id";
const PARTITION_KEY = "toYYYYMM(started_at)";

type Table = {
  readonly name: string;
  readonly engine: string;
  readonly sorting_key: string;
  readonly partition_key: string;
};

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

describe("the trace store's migration files", () => {
  it("are numbered plain SQL, applied in that order", async () => {
    const migrations = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
    expect(migrations.map((migration) => migration.name)).toEqual(
      [...migrations.map((migration) => migration.name)].sort(),
    );
  });

  /**
   * There is no transaction around a ClickHouse migration, so a file that fails
   * halfway leaves its first half behind and the next boot runs it again. Every
   * statement therefore has to survive that, and this is the check that says so
   * before somebody writes the bare `CREATE` that only fails on the second boot
   * of a machine they are not looking at.
   */
  it("create nothing that a second run would trip over", async () => {
    for (const migration of await readMigrations(
      CLICKHOUSE_MIGRATIONS_DIRECTORY,
    )) {
      for (const statement of migration.sql.matchAll(/^\s*CREATE\s+(.+)$/gim)) {
        expect(statement[0]).toMatch(/IF NOT EXISTS/i);
      }
    }
  });
});

describe("booting against an empty ClickHouse", () => {
  let store: EmptyTraceStore;

  beforeAll(async () => {
    store = await createEmptyTraceStore("boot");
  });

  afterAll(async () => {
    await store.drop();
  });

  it("applies every migration", async () => {
    const expected = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    const result = await runClickHouseMigrations(store.url);

    expect(result.applied).toEqual(expected.map((migration) => migration.name));
    expect(result.alreadyApplied).toEqual([]);
  });

  it("applies nothing on the second boot, and does not error", async () => {
    const expected = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    const result = await runClickHouseMigrations(store.url);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(
      expect.arrayContaining(expected.map((migration) => migration.name)),
    );
  });

  it("refuses a migration file that changed after it was applied", async () => {
    await expect(
      runClickHouseMigrations(store.url, fixture("clickhouse-edited")),
    ).rejects.toThrow(/has changed since it was applied/);
  });
});

describe("a migration that cannot apply", () => {
  let store: EmptyTraceStore;

  beforeAll(async () => {
    store = await createEmptyTraceStore("failure");
  });

  afterAll(async () => {
    await store.drop();
  });

  /**
   * Boot calls this before it serves anything, so a rejection here is the API
   * refusing to start. Starting against a schema that is missing whatever the
   * file was meant to add would be worse than not starting: everything would
   * look fine until the first read of a column nobody created.
   */
  it("stops the boot rather than leaving it half-migrated", async () => {
    await expect(
      runClickHouseMigrations(store.url, fixture("clickhouse-broken")),
    ).rejects.toThrow(/migration 0000_broken\.sql failed/);
  });

  it("records nothing, so the next boot tries it again", async () => {
    const result = await runClickHouseMigrations(store.url);
    expect(result.alreadyApplied).toEqual([]);
  });
});

describe("the schema a boot leaves behind", () => {
  let store: MigratedTraceStore;

  beforeAll(async () => {
    store = await createMigratedTraceStore("schema");
  });

  afterAll(async () => {
    await store.drop();
  });

  async function tableNamed(name: string): Promise<Table | undefined> {
    const [table] = await store.rows<Table>(
      `select name, engine, sorting_key, partition_key
         from system.tables
        where database = '${store.name}' and name = '${name}'`,
    );
    return table;
  }

  it("files spans by organization, project, minute, trace and span", async () => {
    const spans = await tableNamed("spans");
    expect(spans?.engine).toBe("MergeTree");
    expect(spans?.sorting_key).toBe(SORTING_KEY);
    expect(spans?.partition_key).toBe(PARTITION_KEY);
  });

  /**
   * Nothing is ever deduplicated at read time on `spans`, so the engine must not
   * be one that collapses rows. Asserted rather than assumed, because switching
   * it on would look like a safety improvement and would tax every query on the
   * biggest table forever.
   */
  it("does not collapse a span row, ever", async () => {
    const [spans] = await store.rows<{ create_table_query: string }>(
      `select create_table_query from system.tables
        where database = '${store.name}' and name = 'spans'`,
    );
    expect(spans?.create_table_query).not.toMatch(/ReplacingMergeTree/);
    expect(spans?.create_table_query).toMatch(
      /non_replicated_deduplication_window = 1000/,
    );
  });

  it("keeps the provider's payload verbatim beside the normalised columns", async () => {
    const columns = await store.rows<{ name: string; type: string }>(
      `select name, type from system.columns
        where database = '${store.name}' and table = 'spans'`,
    );
    const typeOf = (name: string) =>
      columns.find((column) => column.name === name)?.type;

    expect(typeOf("payload")).toBe("String");
    expect(typeOf("trace_id")).toBe("String");
    expect(typeOf("span_id")).toBe("String");
    expect(typeOf("organization_id")).toBe("LowCardinality(String)");
    expect(typeOf("project_id")).toBe("LowCardinality(String)");
    expect(typeOf("source")).toBe("LowCardinality(String)");
    expect(typeOf("emitter")).toBe("LowCardinality(String)");
    expect(typeOf("environment")).toBe("LowCardinality(String)");
    expect(typeOf("started_at")).toBe("DateTime64(6, 'UTC')");
    expect(typeOf("provider_call_id")).toBe("String");
    expect(typeOf("connection_type")).toBe("LowCardinality(String)");
    expect(typeOf("audio_sample_rate_hz")).toBe("UInt32");
  });

  it("carries a materialised view at turn grain, filed the same way", async () => {
    expect((await tableNamed("turns_mv"))?.engine).toBe("MaterializedView");

    const turns = await tableNamed("turns");
    expect(turns?.sorting_key).toBe(SORTING_KEY);
    expect(turns?.partition_key).toBe(PARTITION_KEY);
  });
});

describe("a span arriving twice", () => {
  let store: MigratedTraceStore;

  const span = {
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    organization_id: "org_01JQZ0000000000000000000AA",
    source: "production",
    emitter: "agent",
    started_at: "2026-08-01 09:14:03.500000",
    duration_ns: 1_420_000_000,
    name: "human turn",
    kind: "turn:human",
    text: "I need to move my Tuesday appointment",
    payload: '{"kept":"verbatim"}',
  };

  beforeAll(async () => {
    store = await createMigratedTraceStore("dedup");
  });

  afterAll(async () => {
    await store.drop();
  });

  /**
   * The writer owes non-duplication; this is the backstop under it, and it earns
   * its keep on the production path egma does not own, where an exporter's retry
   * is byte-identical by design. The view is checked as well as the table: a
   * materialised view runs on the block that arrived, so a repeat the table drops
   * would otherwise still show the caller saying the same thing twice.
   */
  it("lands once, in the table and in the view", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.append("spans", [span]);
    }

    expect(await store.rows("select 1 from spans")).toHaveLength(1);
    expect(await store.rows("select 1 from turns")).toHaveLength(1);
  });

  it("reaches the view with its text truncated and its sentinels filled in", async () => {
    const [turn] = await store.rows<{
      trace_id: string;
      kind: string;
      project_id: string;
      environment: string;
      text_preview: string;
    }>("select trace_id, kind, project_id, environment, text_preview from turns");

    expect(turn?.trace_id).toBe(span.trace_id);
    expect(turn?.kind).toBe("turn:human");
    expect(turn?.project_id).toBe("default");
    expect(turn?.environment).toBe("default");
    expect(turn?.text_preview).toBe(span.text);
  });
});
