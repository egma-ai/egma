import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigrations } from "../src/migrate.ts";
import {
  CLICKHOUSE_MIGRATIONS_DIRECTORY,
  runClickHouseMigrations,
} from "../src/clickhouse/migrate.ts";
import { repeatedMigrationNumbers } from "./support/migration-numbers.ts";
import {
  appendIn,
  commandsIn,
  createEmptyTraceStore,
  createMigratedTraceStore,
  rowsIn,
  tablesIn,
  type EmptyTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

/**
 * A span's whole permanent identity, which is now also its filing order and the
 * key the engine collapses on. It holds no clock and no hash: a timestamp in the
 * key would make one span filed a microsecond apart into two, and a 32-bit
 * trace-id hash would let two customers' spans collide into one.
 */
const SPAN_IDENTITY = "organization_id, project_id, trace_id, span_id";

/** Where a read prunes, which is where the primary key stops. */
const PRUNING_KEY = "organization_id, project_id, trace_id";

const PARTITION_KEY = "toYYYYMM(started_at)";

/**
 * The verdicts table's identity, which is what a `ReplacingMergeTree` collapses
 * on: the customer, the conversation, the grader, the version of it, the
 * assertion, and where the conversation came from. Every part after the third is
 * there so that a re-grade adds a row rather than losing one.
 *
 * **It ends at `source`.** There is no `judged_by`: a human judgment returns as
 * a grader of its own — the reserved `human` type — and a grader of its own is
 * already in the key.
 */
const VERDICT_IDENTITY =
  "organization_id, project_id, trace_id, grader_id, grader_version_id, " +
  "assertion, source";

/**
 * The migrations allowed to drop a table, each because a ClickHouse sorting key
 * is fixed at creation and no `ALTER` reaches one. The verdict store's rebuild
 * was the first; the span identity's rebuild is the second, and the table it
 * drops is the carryover it made itself, dropped last so that every earlier
 * failure leaves the refill's source standing.
 */
const THE_ONE_FILE_THAT_DROPS_A_TABLE = "0003_verdicts_speak_the_redesign.sql";

/**
 * The pre-launch rebuild of the span identity, and the only file that may carry
 * rows.
 *
 * A backfill is normally forbidden here because a migration file has no
 * transaction and a re-run would move the same rows twice. This one may, and
 * the rule that makes it safe is checked below: both destinations collapse on
 * the complete span identity, so a second run writes the same rows onto
 * themselves.
 */
const THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY =
  "0007_spans_and_turns_replay_safe.sql";

/**
 * Everything up to one file, written where a runner can be pointed at it.
 *
 * The Postgres migration tests do this to hold a database at the schema one
 * migration starts from; the same question is asked of this chain twice — what
 * several instances applying the additive files at once arrive at, and what the
 * rebuild does to a store that already has rows in it.
 */
async function migrationsBefore(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "egma-clickhouse-"));
  for (const migration of await readMigrations(
    CLICKHOUSE_MIGRATIONS_DIRECTORY,
  )) {
    if (migration.name < name) {
      await writeFile(path.join(directory, migration.name), migration.sql);
    }
  }
  return directory;
}

/** The explicit synchronous pre-launch reset; later migrations stay shape-only. */
const THE_ONE_FILE_THAT_DELETES_PRODUCTION_TRACE_DATA =
  "0006_production_platform_identity.sql";

/**
 * These files have run in production. Even a comment edit changes the hash in
 * the migration ledger and makes the API refuse to boot. Corrections therefore
 * belong in a new migration file; these bytes never change again.
 */
const RELEASED_MIGRATION_HASHES = {
  "0000_spans.sql":
    "1e7bbb7ea92573fb662c4ffe61534a6dc872ef8e8c3e18bd2b7fc20197c23bf6",
  "0001_rename_digital_human_version_id.sql":
    "1e2574fc06f86c387dd89c6a0c511bba70aba40c7a46ae1b1d50c98a33e67901",
  "0002_verdicts.sql":
    "2efa180c0e84bc8af53564af28b5ae5469a809205af0f7c4aa3f275a0bde817e",
  "0003_verdicts_speak_the_redesign.sql":
    "c344b6678cecac6a865108d3c3728f265612c4e4ba7d186a70cd837a22154a1d",
  "0004_retire_normalised_otlp_audio_columns.sql":
    "981367806805a95b51bfb196a436ce0dc633023b7b3554d60c566ae5f4c1a792",
  "0005_drop_retired_audio_columns.sql":
    "bcce5a059cce8a67f03ef75c615297e13ed8e2589e00ffd8a66ccfa9d3868319",
} as const;

type Table = {
  readonly name: string;
  readonly engine: string;
  readonly sorting_key: string;
  readonly partition_key: string;
  readonly primary_key: string;
};

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

type ClickHouseFailure = {
  readonly code: number;
  readonly type: string;
};

async function fakeClickHouse(
  failAlter: (attempt: number) => ClickHouseFailure | undefined,
): Promise<{
  readonly url: string;
  readonly state: {
    stableStatements: number;
    alterAttempts: number;
    ledgerWrites: number;
  };
  readonly close: () => Promise<void>;
}> {
  const state = { stableStatements: 0, alterAttempts: 0, ledgerWrites: 0 };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://clickhouse.test");
      const query = url.searchParams.get("query") ?? body;

      if (query.includes("CREATE TABLE IF NOT EXISTS retry_probe")) {
        state.stableStatements += 1;
      }
      if (query.includes("INSERT INTO egma_meta_migration")) {
        state.ledgerWrites += 1;
      }
      if (query.includes("ALTER TABLE retry_probe")) {
        state.alterAttempts += 1;
        const failure = failAlter(state.alterAttempts);
        if (failure !== undefined) {
          response.statusCode = 500;
          response.end(
            `Code: ${failure.code}. DB::Exception: test failure ` +
              `(${failure.type})`,
          );
          return;
        }
      }

      response.statusCode = 200;
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function clickHouseThatTimesOutAfterApplyingStatement(): Promise<{
  readonly url: string;
  readonly state: {
    statementAttempts: number;
    statementApplications: number;
    ledgerWrites: number;
  };
  readonly close: () => Promise<void>;
}> {
  const state = {
    statementAttempts: 0,
    statementApplications: 0,
    ledgerWrites: 0,
  };
  let retryProbeExists = false;
  let responseTimedOut = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://clickhouse.test");
      const query = url.searchParams.get("query") ?? body;

      if (query.includes("CREATE TABLE IF NOT EXISTS retry_probe")) {
        state.statementAttempts += 1;
        if (!retryProbeExists) {
          retryProbeExists = true;
          state.statementApplications += 1;
        }

        // The schema change lands before the caller learns whether it worked.
        // The timeout is wrapped by the migration error, so this also proves
        // that the complete Error.cause chain is recognised as retryable.
        if (!responseTimedOut) {
          responseTimedOut = true;
          setTimeout(() => {
            response.statusCode = 200;
            response.end();
          }, 75);
          return;
        }
      }

      if (query.includes("ALTER TABLE retry_probe") && !retryProbeExists) {
        response.statusCode = 500;
        response.end("retry_probe does not exist");
        return;
      }

      if (query.includes("INSERT INTO egma_meta_migration")) {
        state.ledgerWrites += 1;
      }

      response.statusCode = 200;
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}?request_timeout=25`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * The statements of one file, split on the marker the runner splits on, with
 * the comments off and the whitespace collapsed. The guards below judge each
 * statement whole, because judged line by line a `CREATE MATERIALIZED VIEW`
 * with its `IF NOT EXISTS` on the next line reads as a bare `CREATE`, and the
 * word `insert` inside a comment reads as a backfill.
 */
function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((statement) => statement !== "");
}


describe("the trace store's migration files", () => {
  it("never rewrites a migration already released to production", async () => {
    const migrations = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    const currentHashes = new Map(
      migrations.map((migration) => [migration.name, migration.hash]),
    );

    for (const [name, releasedHash] of Object.entries(
      RELEASED_MIGRATION_HASHES,
    )) {
      expect(currentHashes.get(name), name).toBe(releasedHash);
    }
  });

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
   * **Each number is used once.** There is no journal on this side — the
   * runner reads the directory, sorts by filename and applies — so two files
   * wearing one number is not a conflict git can see and not a mismatch any
   * bookkeeping can catch. They simply both run, in filename order, and the
   * second gets the schema the first left.
   *
   * The sortedness check above cannot see it: it compares a sorted list against
   * itself, so it holds for any directory at all. This is the check that bites,
   * and `a directory that repeats a number` below is the proof that it does.
   *
   * Numbers may be sparse here, unlike Postgres: a ClickHouse file is written
   * by hand rather than generated, and the density rule the Postgres side keeps
   * belongs to the generator's journal.
   */
  it("use each number once", async () => {
    const migrations = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    expect(repeatedMigrationNumbers(migrations)).toEqual([]);
  });

  /**
   * There is no transaction around a ClickHouse migration, so a file that fails
   * halfway leaves its first half behind and the next boot runs it again. Every
   * statement therefore has to survive that, and this is the check that says so
   * before somebody writes the bare `CREATE` that only fails on the second boot
   * of a machine they are not looking at.
   */
  it("guards every schema change so a second run cannot trip over it", async () => {
    for (const migration of await readMigrations(
      CLICKHOUSE_MIGRATIONS_DIRECTORY,
    )) {
      for (const statement of statementsOf(migration.sql)) {
        if (/^CREATE\b/i.test(statement)) {
          // `CREATE OR REPLACE TABLE` is the second safe form and only the
          // rebuild may use it. It survives a second run for a different
          // reason than `IF NOT EXISTS` does — it makes the table the shape
          // the statement says whatever was there before, and the refill after
          // it puts the rows back — and it is what removes the instant in
          // which a rebuilt table does not exist for another booting instance.
          const guard =
            migration.name === THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY
              ? /^CREATE (?:OR REPLACE TABLE |(?:TABLE|VIEW|MATERIALIZED VIEW) IF NOT EXISTS )/i
              : /^CREATE (?:TABLE|VIEW|MATERIALIZED VIEW|DICTIONARY|FUNCTION) IF NOT EXISTS /i;
          expect(statement, migration.name).toMatch(guard);
        }
        // Each column operation has to survive the re-run on its own terms.
        expect(statement).not.toMatch(/\bADD COLUMN\b(?! IF NOT EXISTS)/i);
        expect(statement).not.toMatch(/\bMODIFY COLUMN\b(?! IF EXISTS)/i);
        expect(statement).not.toMatch(/\bRENAME COLUMN\b(?! IF EXISTS)/i);
        expect(statement).not.toMatch(/\bDROP COLUMN\b(?! IF EXISTS)/i);
      }
    }
  });

  /**
   * A backfill is not re-runnable — the boot after a halfway failure would move
   * the same rows again, and two instances racing would both move them — so a
   * migration file may create shape and never touch data. Moving rows belongs
   * to ingest, or to a tool a person runs once on purpose.
   *
   * **The files that may drop a table or carry rows are named here.** A
   * ClickHouse sorting key is fixed at creation, so a table whose identity has
   * to change has no `ALTER` that could reach it and is rebuilt instead: the
   * verdict store once, and the span identity once. What that costs is the
   * rows, which is affordable only pre-launch — so each exception is a filename
   * rather than a rule, and the next file that drops a table fails here and has
   * to argue for itself. The same rule names the one synchronous pre-launch
   * trace reset instead of permitting general data movement in migrations.
   *
   * The rebuild's own copies are held to the property that makes them
   * re-runnable: each names its columns rather than taking whatever `SELECT *`
   * returns, because the two tables no longer have the same shape, and each
   * lands in a table below that collapses on the span identity.
   */
  it("move no rows, ever", async () => {
    const mayRebuild = (name: string): boolean =>
      name === THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY;

    for (const migration of await readMigrations(
      CLICKHOUSE_MIGRATIONS_DIRECTORY,
    )) {
      for (const statement of statementsOf(migration.sql)) {
        if (!mayRebuild(migration.name)) {
          expect(statement, migration.name).not.toMatch(/^INSERT\b/i);
        } else if (/^INSERT\b/i.test(statement)) {
          expect(statement, migration.name).toMatch(/^INSERT INTO \w+ \(/i);
          expect(statement, migration.name).not.toMatch(/\bSELECT \*/i);
        }
        if (
          migration.name !==
          THE_ONE_FILE_THAT_DELETES_PRODUCTION_TRACE_DATA
        ) {
          expect(statement).not.toMatch(
            /^ALTER TABLE .*\b(?:UPDATE|DELETE)\b/i,
          );
        } else if (/^ALTER TABLE .*\bDELETE\b/i.test(statement)) {
          expect(statement).toMatch(/\bSETTINGS mutations_sync = 2\s*;?$/i);
        }
        if (
          migration.name !== THE_ONE_FILE_THAT_DROPS_A_TABLE &&
          !mayRebuild(migration.name)
        ) {
          expect(statement, migration.name).not.toMatch(/^DROP TABLE\b/i);
        }
      }
    }
  });

  /**
   * Grader-owned storage belongs to the grader effort, so the rebuild of the
   * trace tables never reaches into it. Verdicts left pointing at traces the
   * rebuild deleted are that effort's cleanup to make, and a statement here
   * that tidied them would be this effort taking a decision that is not its
   * own. Checked on the file rather than on a store, because the strongest form
   * of untouched is unnamed.
   */
  it("leaves grader-owned storage unnamed in the rebuild", async () => {
    const migrations = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    const rebuild = migrations.find(
      (migration) =>
        migration.name === THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
    );
    expect(rebuild).toBeDefined();

    for (const statement of statementsOf(rebuild?.sql ?? "")) {
      expect(statement).not.toMatch(/\bverdicts\b/i);
      expect(statement).not.toMatch(/\bgrading_job\b/i);
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

describe("four instances booting at the same moment", () => {
  let store: EmptyTraceStore;
  let additive: string;
  let additiveNames: string[];

  beforeAll(async () => {
    store = await createEmptyTraceStore("concurrent");
    additive = await migrationsBefore(
      THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
    );
    additiveNames = (await readMigrations(additive)).map(
      (migration) => migration.name,
    );
  });

  afterAll(async () => {
    await store.drop();
  });

  /**
   * The Postgres side takes an advisory lock; this side has none to take, so
   * nothing stops several instances applying at once. Idempotent statements and
   * a ledger that collapses a repeated record are the whole defence, and this
   * is where it is proved rather than promised in a comment.
   *
   * **The additive chain, which is the whole of what that defence covers.** The
   * rebuild below is excluded on purpose and the test after this one says on
   * what terms.
   */
  it("all finish, and leave one schema behind", async () => {
    // `Promise.all`, not `allSettled`: one rejection anywhere fails the test.
    await Promise.all([
      runClickHouseMigrations(store.url, additive),
      runClickHouseMigrations(store.url, additive),
      runClickHouseMigrations(store.url, additive),
      runClickHouseMigrations(store.url, additive),
    ]);

    expect(await tablesIn(store)).toEqual([
      "egma_meta_migration",
      "spans",
      "turns",
      "turns_mv",
      "verdicts",
    ]);

    const ledger = await rowsIn<{ name: string }>(
      store,
      "select distinct name from egma_meta_migration order by name",
    );
    expect(ledger.map((row) => row.name)).toEqual(additiveNames);

    // And a boot after the storm finds nothing left to do.
    const late = await runClickHouseMigrations(store.url, additive);
    expect(late.applied).toEqual([]);
    expect(late.alreadyApplied).toEqual(
      expect.arrayContaining(additiveNames),
    );
  });

  /**
   * **The rebuild is applied by one instance, and no arrangement of statements
   * could change that.** It replaces two tables and refills them, so two
   * instances rebuilding together can have one empty what the other has just
   * put back. Idempotence is not the missing piece — every statement in it is
   * idempotent — a lock is, and ClickHouse has none to offer. The cutover
   * already requires it: the writers stop before shared storage changes.
   *
   * So what is proved here is the other half: the rebuild lands cleanly on the
   * schema the storm left, and leaves the settled one.
   */
  it("leaves the rebuild to the one instance the cutover applies it with", async () => {
    const every = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);

    const result = await runClickHouseMigrations(store.url);
    expect(result.applied).toEqual([
      THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
    ]);

    expect(await tablesIn(store)).toEqual([
      "egma_meta_migration",
      "spans",
      "turns",
      "turns_mv",
      "verdicts",
    ]);

    const ledger = await rowsIn<{ name: string }>(
      store,
      "select distinct name from egma_meta_migration order by name",
    );
    expect(ledger.map((row) => row.name)).toEqual(
      every.map((migration) => migration.name),
    );

    const [spans] = await rowsIn<{ sorting_key: string }>(
      store,
      `select sorting_key from system.tables
        where database = '${store.name}' and name = 'spans'`,
    );
    expect(spans?.sorting_key).toBe(SPAN_IDENTITY);
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

  /**
   * The broken file's first statement landed before its second failed, and
   * there was no transaction to take it back. That half-applied state is
   * exactly what the next boot walks into, so this runs the same directory
   * again: the table that already exists causes no error — the IF NOT EXISTS
   * discipline doing its work — and the file fails on the statement that broke
   * it before, not a line earlier.
   */
  it("records nothing, so the next boot tries the whole file again", async () => {
    expect(await tablesIn(store)).toEqual(["egma_meta_migration", "lands_first"]);
    expect(await rowsIn(store, "select name from egma_meta_migration")).toEqual(
      [],
    );

    const failure = await runClickHouseMigrations(
      store.url,
      fixture("clickhouse-broken"),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    expect(failure?.message).toMatch(/migration 0000_broken\.sql failed/);
    // The second statement's engine, never the first statement's table: the
    // re-run got past what already exists and broke where it broke before.
    expect(String(failure?.cause)).toMatch(/NoSuchEngine/);
    expect(String(failure?.cause)).not.toMatch(/lands_first/);
  });
});

describe("a replicated ALTER whose metadata is still catching up", () => {
  it("retries the statement ClickHouse explicitly asks it to retry", async () => {
    const clickhouse = await fakeClickHouse((attempt) =>
      attempt === 1 ? { code: 517, type: "CANNOT_ASSIGN_ALTER" } : undefined,
    );

    try {
      const result = await runClickHouseMigrations(
        clickhouse.url,
        fixture("clickhouse-transient"),
      );

      expect(clickhouse.state.stableStatements).toBe(1);
      expect(clickhouse.state.alterAttempts).toBe(2);
      expect(clickhouse.state.ledgerWrites).toBe(1);
      expect(result.applied).toEqual(["0000_retry_replicated_alter.sql"]);
    } finally {
      await clickhouse.close();
    }
  });

  it("does not retry a different ClickHouse error", async () => {
    const clickhouse = await fakeClickHouse(() => ({
      code: 56,
      type: "UNKNOWN_STORAGE",
    }));

    try {
      await expect(
        runClickHouseMigrations(
          clickhouse.url,
          fixture("clickhouse-transient"),
        ),
      ).rejects.toThrow(/migration 0000_retry_replicated_alter\.sql failed/);
      expect(clickhouse.state.alterAttempts).toBe(1);
      expect(clickhouse.state.ledgerWrites).toBe(0);
    } finally {
      await clickhouse.close();
    }
  });

  it(
    "stops after the replica catch-up limit without recording the migration",
    async () => {
      const clickhouse = await fakeClickHouse(() => ({
        code: 517,
        type: "CANNOT_ASSIGN_ALTER",
      }));

      try {
        await expect(
          runClickHouseMigrations(
            clickhouse.url,
            fixture("clickhouse-transient"),
          ),
        ).rejects.toThrow(/migration 0000_retry_replicated_alter\.sql failed/);
        expect(clickhouse.state.alterAttempts).toBe(8);
        expect(clickhouse.state.ledgerWrites).toBe(0);
      } finally {
        await clickhouse.close();
      }
    },
    15_000,
  );
});

describe("a ClickHouse request that times out after applying a statement", () => {
  it("retries the complete idempotent migration and records it once", async () => {
    const clickhouse = await clickHouseThatTimesOutAfterApplyingStatement();

    try {
      const result = await runClickHouseMigrations(
        clickhouse.url,
        fixture("clickhouse-transient"),
      );

      expect(result.applied).toEqual(["0000_retry_replicated_alter.sql"]);
      expect(clickhouse.state.statementAttempts).toBe(2);
      expect(clickhouse.state.statementApplications).toBe(1);
      expect(clickhouse.state.ledgerWrites).toBe(1);
    } finally {
      await clickhouse.close();
    }
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
      `select name, engine, sorting_key, partition_key, primary_key
         from system.tables
        where database = '${store.name}' and name = '${name}'`,
    );
    return table;
  }

  async function typesOf(
    table: string,
  ): Promise<(name: string) => string | undefined> {
    const columns = await store.rows<{ name: string; type: string }>(
      `select name, type from system.columns
        where database = '${store.name}' and table = '${table}'`,
    );
    return (name) => columns.find((column) => column.name === name)?.type;
  }

  it("files spans by the whole immutable span identity", async () => {
    const spans = await tableNamed("spans");
    expect(spans?.engine).toBe("ReplacingMergeTree");
    expect(spans?.sorting_key).toBe(SPAN_IDENTITY);
    expect(spans?.primary_key).toBe(PRUNING_KEY);
    expect(spans?.partition_key).toBe(PARTITION_KEY);
  });

  /**
   * **No version column, and that is the assertion.** `ReplacingMergeTree(x)`
   * keeps the row with the greater `x`, which would make the later of two
   * disagreeing accounts of one span win — exactly the outcome the identity
   * exists to prevent, since the evidence already stored is the authoritative
   * one. The engine collapses exact replays and is never asked to settle a
   * conflict; the batched check before the write is what does that.
   *
   * The block-level shield in front of it is asserted too, because it is what
   * absorbs an exporter's byte-identical retry before the engine is involved.
   */
  it("collapses a span onto its identity without letting a later row win", async () => {
    const [spans] = await store.rows<{ create_table_query: string }>(
      `select create_table_query from system.tables
        where database = '${store.name}' and name = 'spans'`,
    );
    expect(spans?.create_table_query).toMatch(/ReplacingMergeTree\b/);
    expect(spans?.create_table_query).not.toMatch(/ReplacingMergeTree\s*\(/);
    expect(spans?.create_table_query).toMatch(
      /non_replicated_deduplication_window = 1000/,
    );
  });

  /**
   * The fingerprint the pre-write integrity check compares against, stored
   * rather than derived — a hash recomputed from stored columns could not
   * survive `LowCardinality`, `DateTime64` rounding or the payload faithfully.
   * It stays **out** of the filing order on purpose: two different contents
   * under one identity have to land on the same key so the check can see them
   * as one identity, not beside each other as two rows nobody compares.
   */
  it("stores each span's content fingerprint outside the key", async () => {
    const typeOf = await typesOf("spans");
    expect(typeOf("content_hash")).toBe("String");

    const spans = await tableNamed("spans");
    expect(spans?.sorting_key).not.toMatch(/content_hash/);
    expect(spans?.primary_key).not.toMatch(/content_hash/);
  });

  it("keeps the provider's payload verbatim beside the normalised columns", async () => {
    const typeOf = await typesOf("spans");

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
    expect(typeOf("agent_platform")).toBe("LowCardinality(String)");
    expect(typeOf("platform_agent_id")).toBe("String");
    expect(typeOf("platform_agent_name")).toBe("String");
    expect(typeOf("platform_agent_version")).toBe("String");
    expect(typeOf("audio_sample_rate_hz")).toBeUndefined();
    expect(typeOf("audio_encoding")).toBeUndefined();
  });

  /**
   * The derived grain collapses on the same identity and needs to separately: a
   * materialised view runs on the block that arrived, before the base table has
   * decided anything, and it may process one replay more than once. A derived
   * row is a pure function of the span it came from, so the span's identity is
   * the turn's identity.
   */
  it("carries a materialised view at turn grain, filed the same way", async () => {
    expect((await tableNamed("turns_mv"))?.engine).toBe("MaterializedView");

    const turns = await tableNamed("turns");
    expect(turns?.engine).toBe("ReplacingMergeTree");
    expect(turns?.sorting_key).toBe(SPAN_IDENTITY);
    expect(turns?.primary_key).toBe(PRUNING_KEY);
    expect(turns?.partition_key).toBe(PARTITION_KEY);
  });

  /**
   * The rebuild was the one moment `agent_platform` could reach the turn grain
   * without a second rewrite: a turn-grain read that has to know which platform
   * produced a turn should not reach back to the wide table for one cheap word.
   * The other three `platform_agent_*` columns stay off until a read needs them.
   */
  it("names the platform at turn grain, and nothing more of it", async () => {
    const typeOf = await typesOf("turns");
    expect(typeOf("agent_platform")).toBe("LowCardinality(String)");
    for (const name of [
      "platform_agent_id",
      "platform_agent_name",
      "platform_agent_version",
    ]) {
      expect(typeOf(name)).toBeUndefined();
    }
  });

  /**
   * The filing shape is settled again, on the identity this time. A later
   * migration may remove a redundant normalised column, but it may not rewrite
   * the filing shape or mix grading state into the trace row.
   */
  it("leaves the spans filing shape and turn view settled", async () => {
    const spans = await tableNamed("spans");
    expect(spans?.engine).toBe("ReplacingMergeTree");
    expect(spans?.sorting_key).toBe(SPAN_IDENTITY);
    expect(spans?.partition_key).toBe(PARTITION_KEY);

    const spanTypeOf = await typesOf("spans");
    // Nothing was added to the row, and nothing named `verdict` crept onto it:
    // a judgment is a row of its own table, made after the conversation, and a
    // column here would be the one thing a later grading would have to rewrite.
    for (const name of ["verdict", "score", "grader_id", "grader_version_id"]) {
      expect(spanTypeOf(name)).toBeUndefined();
    }

    const turns = await tableNamed("turns");
    expect(turns?.sorting_key).toBe(SPAN_IDENTITY);
    expect(turns?.partition_key).toBe(PARTITION_KEY);
    expect((await tableNamed("turns_mv"))?.engine).toBe("MaterializedView");
  });

  /** The carryover exists only inside the rebuild and is gone after it. */
  it("leaves no carryover table behind", async () => {
    expect(await tableNamed("spans_carryover")).toBeUndefined();
  });

  it("collapses a verdict only onto the identical judgment", async () => {
    const verdicts = await tableNamed("verdicts");

    expect(verdicts?.engine).toBe("ReplacingMergeTree");
    expect(verdicts?.sorting_key).toBe(VERDICT_IDENTITY);
    // The retired columns are gone from the row as well as from the key: one
    // word at every layer, and no ladder left for a failure to hide behind.
    const typeOf = await typesOf("verdicts");
    for (const name of ["dimension", "priority", "judged_by"]) {
      expect(typeOf(name)).toBeUndefined();
    }

    // The later judgment wins, which is what makes a re-run after a transient
    // error a correction rather than a second opinion.
    const [created] = await store.rows<{ create_table_query: string }>(
      `select create_table_query from system.tables
        where database = '${store.name}' and name = 'verdicts'`,
    );
    expect(created?.create_table_query).toMatch(
      /ReplacingMergeTree\(event_ts\)/,
    );
  });

  /**
   * A `ReplacingMergeTree` collapses rows inside a partition and never across
   * one, so a partition key derived from a clock would leave a re-run that
   * happened to land in the next month as two rows forever. The table is small
   * enough not to need one, so it does not have one — and this says so, because
   * adding a partition key later would look like an optimisation and would
   * quietly break the collapse.
   */
  it("files verdicts in one partition, so an identity can never straddle two", async () => {
    const verdicts = await tableNamed("verdicts");
    expect(verdicts?.partition_key).toBe("");
    // The index prunes on the customer and the conversation; the rest of the
    // sorting key is there to collapse rows, which happens after the granule
    // has been found.
    expect(verdicts?.primary_key).toBe(
      "organization_id, project_id, trace_id",
    );
  });

  it("types a verdict's columns as the vocabulary they hold", async () => {
    const typeOf = await typesOf("verdicts");

    // Closed vocabularies, so the store refuses a fifth word rather than filing
    // it. `skipped` and `errored` are in the enum because they must never be
    // collapsed into `failed`.
    expect(typeOf("verdict")).toBe(
      "Enum8('passed' = 1, 'failed' = 2, 'skipped' = 3, 'errored' = 4)",
    );

    // Tenancy takes the shape it has on `spans`, and so does `source`: the two
    // tables are read together and a word that meant two things would make that
    // impossible.
    expect(typeOf("organization_id")).toBe("LowCardinality(String)");
    expect(typeOf("project_id")).toBe("LowCardinality(String)");
    expect(typeOf("source")).toBe("LowCardinality(String)");

    expect(typeOf("trace_id")).toBe("String");
    expect(typeOf("grader_id")).toBe("String");
    expect(typeOf("grader_version_id")).toBe("String");
    expect(typeOf("assertion")).toBe("String");
    expect(typeOf("score")).toBe("Float64");
    expect(typeOf("rationale")).toBe("String");
    expect(typeOf("cited_span_ids")).toBe("Array(String)");
    expect(typeOf("run_id")).toBe("String");
    expect(typeOf("agent_id")).toBe("String");
    expect(typeOf("agent_version_id")).toBe("String");
    expect(typeOf("event_ts")).toBe("DateTime64(6, 'UTC')");
  });

  /**
   * The fold divides by this number, so a row outside 0 to 1 would not be one
   * wrong figure — it would be a wrong figure everywhere the row is ever
   * counted. Refused at the door instead.
   */
  it("refuses a score that is not a proportion", async () => {
    const judgment = {
      organization_id: "org_01JQZ0000000000000000000AA",
      trace_id: "cccccccccccccccccccccccccccccccc",
      grader_id: "grd_01JQZ0000000000000000000AA",
      grader_version_id: "grv_01JQZ00000000000000000000AA",
      assertion: "behavior_1",
      source: "simulation",
      verdict: "passed",
      event_ts: "2026-08-07 09:00:00.000000",
    };

    await expect(
      store.append("verdicts", [{ ...judgment, score: 1.5 }]),
    ).rejects.toThrow(/Constraint `score_is_a_proportion`.*is violated/);
    await expect(
      store.append("verdicts", [{ ...judgment, score: -0.1 }]),
    ).rejects.toThrow(/Constraint `score_is_a_proportion`.*is violated/);

    await store.append("verdicts", [{ ...judgment, score: 1 }]);
    expect(await store.rows("select 1 from verdicts")).toHaveLength(1);
  });

  it("refuses a word that is not one of the four", async () => {
    await expect(
      store.append("verdicts", [
        {
          organization_id: "org_01JQZ0000000000000000000AA",
          trace_id: "dddddddddddddddddddddddddddddddd",
          grader_id: "grd_01JQZ0000000000000000000AA",
          grader_version_id: "grv_01JQZ00000000000000000000AA",
          assertion: "behavior_1",
          source: "simulation",
          verdict: "inconclusive",
          score: 0.5,
          event_ts: "2026-08-07 09:00:00.000000",
        },
      ]),
    ).rejects.toThrow(/UNKNOWN_ELEMENT_OF_ENUM|Unknown element/);
  });
});

describe("the pre-launch Monitoring trace reset", () => {
  let store: MigratedTraceStore;

  beforeAll(async () => {
    store = await createMigratedTraceStore("monitoring_cutover");
  });

  afterAll(async () => {
    await store.drop();
  });

  it("waits for production rows to be removed and keeps simulation evidence", async () => {
    await store.append("spans", [
      {
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        span_id: "00f067aa0ba902b7",
        organization_id: "org_01JQZ0000000000000000000AA",
        source: "simulation",
        emitter: "egma",
        started_at: "2026-08-01 09:14:03.500000",
        duration_ns: 1_000_000,
        name: "human turn",
        kind: "turn:human",
        text: "hello",
        payload: "{}",
      },
      {
        trace_id: "5cf92f3577b34da6a3ce929d0e0e4737",
        span_id: "10f067aa0ba902b8",
        organization_id: "org_01JQZ0000000000000000000AA",
        source: "production",
        emitter: "agent",
        started_at: "2026-08-01 09:15:03.500000",
        duration_ns: 1_000_000,
        name: "human turn",
        kind: "turn:human",
        text: "production hello",
        payload: "{}",
      },
    ]);
    await store.append("verdicts", [
      {
        organization_id: "org_01JQZ0000000000000000000AA",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        grader_id: "grd_01JQZ0000000000000000000AA",
        grader_version_id: "grv_01JQZ00000000000000000000AA",
        assertion: "behavior_1",
        source: "simulation",
        verdict: "passed",
        score: 1,
        event_ts: "2026-08-01 09:15:00.000000",
      },
      {
        organization_id: "org_01JQZ0000000000000000000AA",
        trace_id: "5cf92f3577b34da6a3ce929d0e0e4737",
        grader_id: "grd_01JQZ0000000000000000000AA",
        grader_version_id: "grv_01JQZ00000000000000000000AA",
        assertion: "behavior_1",
        source: "production",
        verdict: "passed",
        score: 1,
        event_ts: "2026-08-01 09:16:00.000000",
      },
    ]);

    expect(await store.rows("select 1 from spans")).toHaveLength(2);
    expect(await store.rows("select 1 from turns")).toHaveLength(2);
    expect(await store.rows("select 1 from verdicts")).toHaveLength(2);

    const migrations = await readMigrations(CLICKHOUSE_MIGRATIONS_DIRECTORY);
    const cutover = migrations.find(
      (migration) =>
        migration.name === THE_ONE_FILE_THAT_DELETES_PRODUCTION_TRACE_DATA,
    );
    expect(cutover).toBeDefined();
    for (const statement of statementsOf(cutover?.sql ?? "")) {
      if (/^ALTER TABLE .*\bDELETE\b/i.test(statement)) {
        await store.command(statement);
      }
    }

    for (const table of ["spans", "turns", "verdicts"]) {
      expect(
        await store.rows<{ source: string }>(`select source from ${table}`),
      ).toEqual([{ source: "simulation" }]);
    }
  });
});

const ORGANIZATION_ID = "org_01JQZ0000000000000000000AA";
const PROJECT_ID = "prj_01JQZ0000000000000000000AA";

/** One turn-grain span, in the columns the shape before the rebuild holds. */
function turnSpan(
  traceId: string,
  spanId: string,
  source: string,
  text: string,
): Record<string, unknown> {
  return {
    trace_id: traceId,
    span_id: spanId,
    organization_id: ORGANIZATION_ID,
    project_id: PROJECT_ID,
    source,
    emitter: source === "simulation" ? "egma-runtime" : "agent",
    started_at: "2026-08-01 09:14:03.500000",
    duration_ns: 1_420_000_000,
    name: "human turn",
    kind: "turn:human",
    text,
    agent_platform: source === "simulation" ? "" : "livekit_agents",
    payload: "{}",
  };
}

/** One judgment about a trace, which no rebuild statement ever names. */
function judgment(traceId: string, source: string): Record<string, unknown> {
  return {
    organization_id: ORGANIZATION_ID,
    project_id: PROJECT_ID,
    trace_id: traceId,
    grader_id: "grd_01JQZ0000000000000000000AA",
    grader_version_id: "grv_01JQZ00000000000000000000AA",
    assertion: "behavior_1",
    source,
    verdict: "passed",
    score: 1,
    event_ts: "2026-08-01 09:15:00.000000",
  };
}

/**
 * The identity rebuild meeting a store that already has rows in it, which is
 * the only shape it will ever meet in a deployment.
 *
 * An empty store proves the statements parse. This proves what they do: it
 * migrates to the schema the rebuild starts from, writes evidence of both
 * kinds and a judgment about each, and then applies the file the same way a
 * boot does.
 */
describe("the identity rebuild against a populated store", () => {
  let store: EmptyTraceStore;

  const simulationTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
  const productionTrace = "5cf92f3577b34da6a3ce929d0e0e4737";
  const simulationSpan = "00f067aa0ba902b7";

  beforeAll(async () => {
    store = await createEmptyTraceStore("populated_rebuild");

    // Everything the rebuild starts from, and nothing of the rebuild itself.
    await runClickHouseMigrations(
      store.url,
      await migrationsBefore(THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY),
    );

    // Mixed evidence, written after the reset that precedes the rebuild, so
    // that production rows are here to be removed by the rebuild itself rather
    // than by the file before it.
    await appendIn(store, "spans", [
      turnSpan(
        simulationTrace,
        simulationSpan,
        "simulation",
        "simulation hello",
      ),
      turnSpan(
        productionTrace,
        "10f067aa0ba902b8",
        "production",
        "production hello",
      ),
    ]);
    await appendIn(store, "verdicts", [
      judgment(simulationTrace, "simulation"),
      judgment(productionTrace, "production"),
    ]);

    await runClickHouseMigrations(store.url);
  });

  afterAll(async () => {
    await store.drop();
  });

  it("keeps every simulation span and turn, with one visible copy each", async () => {
    expect(
      await rowsIn<{ trace_id: string; text: string }>(
        store,
        "select trace_id, text from spans final order by trace_id",
      ),
    ).toEqual([{ trace_id: simulationTrace, text: "simulation hello" }]);

    expect(
      await rowsIn<{ trace_id: string; text_preview: string }>(
        store,
        "select trace_id, text_preview from turns final order by trace_id",
      ),
    ).toEqual([
      { trace_id: simulationTrace, text_preview: "simulation hello" },
    ]);
  });

  it("removes production evidence by never carrying it across", async () => {
    expect(
      await rowsIn(
        store,
        `select 1 from spans where trace_id = '${productionTrace}'`,
      ),
    ).toEqual([]);
    expect(
      await rowsIn(
        store,
        `select 1 from turns where trace_id = '${productionTrace}'`,
      ),
    ).toEqual([]);
  });

  /**
   * The grader owns its own storage and its own cleanup. Verdicts pointing at
   * traces this rebuild deleted are the grader effort's to resolve, and the
   * ingestion migration deliberately does not name them — so both rows are
   * still here, including the production one.
   */
  it("does not touch a single verdict", async () => {
    expect(
      await rowsIn<{ source: string }>(
        store,
        "select source from verdicts final order by source",
      ),
    ).toEqual([{ source: "production" }, { source: "simulation" }]);
  });

  it("leaves the carryover table behind only while it is needed", async () => {
    expect(await tablesIn(store)).not.toContain("spans_carryover");
  });

  /**
   * The carried rows predate the fingerprint, so theirs is empty rather than
   * wrong. A caller that cannot compare treats the stored row as authoritative;
   * inventing a hash for evidence written before the rule existed would make a
   * conflict look like a replay.
   */
  it("carries the older evidence across with no fingerprint claimed for it", async () => {
    expect(
      await rowsIn<{ content_hash: string }>(
        store,
        "select content_hash from spans final",
      ),
    ).toEqual([{ content_hash: "" }]);
  });

  /**
   * And the point of the whole rebuild, on evidence that predates it: the
   * carried row now files under the span identity, so the same span arriving
   * again is the same span. Under the old filing order it was a second row
   * forever, because a timestamp and a trace-id hash stood in the key.
   *
   * Last in this block, because it is the only test here that writes.
   */
  it("collapses a replay of a carried span onto the one it carried", async () => {
    await appendIn(store, "spans", [
      turnSpan(
        simulationTrace,
        simulationSpan,
        "simulation",
        "simulation hello",
      ),
    ]);

    expect(
      await rowsIn<{ text: string }>(
        store,
        `select text from spans final where span_id = '${simulationSpan}'`,
      ),
    ).toEqual([{ text: "simulation hello" }]);
    expect(
      await rowsIn<{ text_preview: string }>(
        store,
        `select text_preview from turns final where span_id = '${simulationSpan}'`,
      ),
    ).toEqual([{ text_preview: "simulation hello" }]);
  });
});

/**
 * The rebuild's opening clauses, which is what a statement is called here.
 * Everything from the first bracket on is columns, and a case name is not the
 * place for them.
 */
function opening(statement: string): string {
  const clause =
    /^(?:CREATE (?:OR REPLACE )?(?:MATERIALIZED )?(?:TABLE|VIEW) (?:IF NOT EXISTS )?|DROP (?:TABLE|VIEW) IF EXISTS |INSERT INTO )\w+/i.exec(
      statement,
    );
  return clause?.[0] ?? statement;
}

/**
 * The rebuild's statements, read where Vitest can see them while it collects:
 * there is one case per statement below, and a list awaited in a hook arrives
 * too late to make cases from. The trailing semicolon comes off the way the
 * runner takes it off before sending, which is also what lets a case bound one
 * of the copies with `LIMIT`.
 */
const THE_REBUILDS_STATEMENTS = statementsOf(
  readFileSync(
    path.join(
      CLICKHOUSE_MIGRATIONS_DIRECTORY,
      THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
    ),
    "utf8",
  ),
).map((statement) => statement.replace(/\s*;$/, ""));

/**
 * Where a run can stop. `through` is how many statements finished; `partly`
 * then runs the one after them bounded to a single row.
 */
type CrashPoint = { readonly through: number; readonly partly: boolean };

/**
 * Every one of them: after each statement, and part-way through each of the two
 * copies, which are the only statements that can leave some of their rows
 * behind.
 */
const CRASH_POINTS: readonly CrashPoint[] = THE_REBUILDS_STATEMENTS.flatMap(
  (statement, index) =>
    /^INSERT\b/i.test(statement)
      ? [
          { through: index, partly: true },
          { through: index + 1, partly: false },
        ]
      : [{ through: index + 1, partly: false }],
);

/** What a crash point is called, taken from the statement it stopped on. */
function crashPointName({ through, partly }: CrashPoint): string {
  const clause = opening(
    THE_REBUILDS_STATEMENTS[partly ? through : through - 1] ?? "",
  );
  return partly ? `one row into \`${clause}\`` : `as far as \`${clause}\``;
}

/**
 * The identity rebuild resumed after a run that stopped inside it.
 *
 * **The ledger records a file, never a statement.** A failure anywhere in this
 * one — a real error or a lost response — records nothing, so the next boot
 * runs the whole file again on top of whatever the attempt before it left. Each
 * case below builds one of those leftovers on purpose by driving the front of
 * the file straight into the store, and then points the runner at the real
 * directory the way a boot points at it.
 *
 * Two of the leftovers are the ones the order of the file exists to survive:
 *
 * - **After the tables are replaced**, the carry-aside at the top reads the new
 *   shape. It has to parse there, which is why it names only columns both
 *   shapes hold, and it has to put nothing wrong into the carryover, which is
 *   why the carryover collapses on the span identity.
 * - **After the carryover is dropped**, the carry-aside is the only thing that
 *   can make it again, and the refilled `spans` is what it reads. That is what
 *   the drop being last buys.
 */
describe("the identity rebuild resumed after a partial run", () => {
  // Two simulation traces, because a copy that stopped part-way is only a state
  // at all when there is more than one row for it to have stopped between.
  const evidence = [
    { trace_id: "1bf92f3577b34da6a3ce929d0e0e4731", text: "the first thing" },
    { trace_id: "2bf92f3577b34da6a3ce929d0e0e4732", text: "the second thing" },
  ] as const;
  const productionTrace = "9cf92f3577b34da6a3ce929d0e0e4739";

  let beforeTheRebuild: string;

  beforeAll(async () => {
    beforeTheRebuild = await migrationsBefore(
      THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
    );
  });

  /** A store at the schema the rebuild starts from, with mixed evidence in it. */
  async function populatedStore(): Promise<EmptyTraceStore> {
    const store = await createEmptyTraceStore("resume");
    await runClickHouseMigrations(store.url, beforeTheRebuild);
    await appendIn(store, "spans", [
      ...evidence.map((row, index) =>
        turnSpan(
          row.trace_id,
          `00f067aa0ba902b${index}`,
          "simulation",
          row.text,
        ),
      ),
      turnSpan(productionTrace, "10f067aa0ba902b9", "production", "and this"),
    ]);
    await appendIn(store, "verdicts", [
      judgment(evidence[0].trace_id, "simulation"),
      judgment(productionTrace, "production"),
    ]);
    return store;
  }

  it.each(CRASH_POINTS.map((crash) => [crashPointName(crash), crash] as const))(
    "settles the same store from a run that got %s",
    async (_name, crash) => {
      const store = await populatedStore();
      try {
        // Where the failed run stopped.
        await commandsIn(
          store,
          THE_REBUILDS_STATEMENTS.slice(0, crash.through),
        );
        if (crash.partly) {
          await commandsIn(store, [
            `${THE_REBUILDS_STATEMENTS[crash.through] ?? ""} LIMIT 1`,
          ]);
        }

        // The boot after it. Nothing was recorded, so all of the file runs.
        const result = await runClickHouseMigrations(store.url);
        expect(result.applied).toEqual([
          THE_ONE_FILE_THAT_REBUILDS_THE_SPAN_IDENTITY,
        ]);

        // Every simulation span, once, holding the values it arrived with.
        expect(
          await rowsIn<{ trace_id: string; text: string }>(
            store,
            "select trace_id, text from spans final order by trace_id",
          ),
        ).toEqual(evidence);
        expect(
          await rowsIn<{ trace_id: string; text_preview: string }>(
            store,
            "select trace_id, text_preview from turns final order by trace_id",
          ),
        ).toEqual(
          evidence.map((row) => ({
            trace_id: row.trace_id,
            text_preview: row.text,
          })),
        );

        // Production evidence gone, and the judgments left as they were.
        expect(
          await rowsIn<{ source: string }>(
            store,
            "select source from verdicts final order by source",
          ),
        ).toEqual([{ source: "production" }, { source: "simulation" }]);

        // The settled schema, with the carryover no longer part of it.
        expect(await tablesIn(store)).toEqual([
          "egma_meta_migration",
          "spans",
          "turns",
          "turns_mv",
          "verdicts",
        ]);
      } finally {
        await store.drop();
      }
    },
  );
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
    provider_call_id: "call-abc",
    agent_platform: "livekit_agents",
    payload: '{"kept":"verbatim"}',
  };

  beforeAll(async () => {
    store = await createMigratedTraceStore("dedup");
  });

  afterAll(async () => {
    await store.drop();
  });

  /**
   * The fast shield first: a byte-identical insert block is dropped while it is
   * still in the recent window, so a repeat never reaches the table at all. The
   * view is checked as well, because a materialised view runs on the block that
   * arrived — a repeat the table dropped would otherwise still show the human
   * saying the same thing twice.
   */
  it("lands once, in the table and in the view", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.append("spans", [span]);
    }

    expect(await store.rows("select 1 from spans")).toHaveLength(1);
    expect(await store.rows("select 1 from turns")).toHaveLength(1);
  });

  /**
   * Every derived column lands in the column it is named for, which is worth
   * asserting because two of them are adjacent `String`s: a view whose columns
   * were matched by position rather than by name would put the platform in the
   * provider's call id and nothing would refuse it.
   */
  it("reaches the view with its sentinels filled in", async () => {
    const [turn] = await store.rows<{
      trace_id: string;
      kind: string;
      project_id: string;
      environment: string;
      provider_call_id: string;
      agent_platform: string;
      text_preview: string;
    }>(
      "select trace_id, kind, project_id, environment, provider_call_id, " +
        "agent_platform, text_preview from turns",
    );

    expect(turn?.trace_id).toBe(span.trace_id);
    expect(turn?.kind).toBe("turn:human");
    expect(turn?.project_id).toBe("default");
    expect(turn?.environment).toBe("default");
    expect(turn?.provider_call_id).toBe(span.provider_call_id);
    expect(turn?.agent_platform).toBe(span.agent_platform);
    expect(turn?.text_preview).toBe(span.text);
  });

  /**
   * The preview really is a preview. The span above is far shorter than the
   * cut, so this one is not: a turn past 1024 characters proves the view
   * truncates, and that the wide table keeps every character for the detail
   * page to go and get.
   */
  it("cuts the preview at 1024 characters, and keeps the whole text on `spans`", async () => {
    const said =
      "I need to move my Tuesday appointment, and it is a long story. ".repeat(
        20,
      );
    expect(said.length).toBeGreaterThan(1024);
    const long = { ...span, span_id: "00f067aa0ba902b8", text: said };

    await store.append("spans", [long]);

    const [turn] = await store.rows<{ text_preview: string }>(
      `select text_preview from turns where span_id = '${long.span_id}'`,
    );
    expect(turn?.text_preview).toHaveLength(1024);
    expect(turn?.text_preview).toBe(said.slice(0, 1024));

    const [kept] = await store.rows<{ text: string }>(
      `select text from spans where span_id = '${long.span_id}'`,
    );
    expect(kept?.text).toBe(said);
  });

  /**
   * And the guarantee under the shield, which is the whole reason the identity
   * became the filing order.
   *
   * The block window is a count of recent blocks rather than a span of time, so
   * a replay far enough behind the traffic in front of it arrives at a table
   * that has forgotten the original block. Reaching that state by inserting a
   * thousand other blocks would prove the same thing slowly; taking the window
   * away says it exactly — the shield is gone, and the span still lands once.
   *
   * Two physical copies is the ordinary state between the write and a merge.
   * What matters is that one identity is one visible span and one visible turn,
   * which is what every correctness-sensitive read asks for with `FINAL`.
   */
  it("lands once even when the block shield has forgotten it", async () => {
    const replayed = { ...span, span_id: "00f067aa0ba902b9" };
    await store.append("spans", [replayed]);

    for (const table of ["spans", "turns"]) {
      await store.command(
        `alter table ${table} modify setting non_replicated_deduplication_window = 0`,
      );
    }
    await store.append("spans", [replayed]);

    const at = async (query: string): Promise<number> => {
      const [row] = await store.rows<{ n: number }>(query);
      return row?.n ?? -1;
    };
    const identity = `span_id = '${replayed.span_id}'`;

    expect(
      await at(`select count() as n from spans where ${identity}`),
    ).toBe(2);
    expect(
      await at(`select count() as n from spans final where ${identity}`),
    ).toBe(1);
    expect(
      await at(`select count() as n from turns final where ${identity}`),
    ).toBe(1);
  });
});
