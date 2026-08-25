import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CROCKFORD_ALPHABET, mintedAt, newId } from "@egma/ids";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MIGRATION_ADVISORY_LOCK,
  MIGRATION_HASH_CORRECTIONS,
  MIGRATIONS_DIRECTORY,
  readMigrations,
  runMigrations,
} from "../src/migrate.ts";
import {
  PROVIDER_CATALOG,
  PROVIDERS_BY_JOB,
} from "../src/models/catalog.ts";
import {
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
} from "../src/models/selections.ts";
import * as schema from "../src/schema/index.ts";
import {
  createEmptyDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type EmptyDatabase,
} from "./support/database.ts";
import { repeatedMigrationNumbers } from "./support/migration-numbers.ts";

function idBits(id: string): bigint {
  const body = id.slice(id.indexOf("_") + 1);
  let value = 0n;
  for (const character of body) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    if (digit === -1) throw new Error(`invalid Egma id: ${id}`);
    value = (value << 5n) | BigInt(digit);
  }
  return value;
}

/** Add the historical tail without applying the destructive suite cutover. */
async function addHistoricalMigration(
  directory: string,
  name: string,
): Promise<void> {
  const migrations = (await readMigrations()).filter(
    (one) => one.name >= name && one.name < "0040",
  );
  if (migrations[0]?.name !== name) throw new Error(`missing migration ${name}`);
  for (const migration of migrations) {
    await writeFile(path.join(directory, migration.name), migration.sql);
  }
}

describe("the migration files", () => {
  /**
   * 0042 reached the hosted test database before the agent-platform cutover.
   * Its bytes are now part of that database's migration history. A later
   * schema change must use a new migration instead of changing this hash.
   */
  it("keeps the deployed 0042 migration immutable", async () => {
    const deployed = (await readMigrations()).find(
      (migration) =>
        migration.name === "0042_agents_own_platform_monitoring.sql",
    );

    expect(deployed?.hash).toBe(
      "e811c2066c1ee01af8d7e358a16dc9caded5f37a517cec9526b860acf4ab0160",
    );
  });

  it("are numbered plain SQL, applied in that order", async () => {
    const migrations = await readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
    expect(migrations.map((migration) => migration.name)).toEqual(
      [...migrations.map((migration) => migration.name)].sort(),
    );
  });

  it("start by creating the citext extension, because the user table needs it", async () => {
    const [first] = await readMigrations();
    expect(first?.name).toBe("0000_extensions.sql");
    expect(first?.sql).toMatch(/create extension if not exists citext/i);
  });

  /**
   * **One sequence, counted from zero with no gaps.** Two efforts landing at
   * once is exactly how a repository ends up with two migrations wearing one
   * number: each takes the next free one from where it was standing, and a
   * self-hoster upgrading across both applies whichever of them sorted first
   * and never learns the other existed. So the numbers are held dense and
   * unrepeated here, where a merge that doubled one fails rather than ships.
   */
  it("are one dense sequence, each number used once", async () => {
    const numbers = (await readMigrations()).map((migration) =>
      Number(migration.name.slice(0, 4)),
    );
    expect(numbers).toEqual(numbers.map((_, index) => index));
  });

  /**
   * The same rule again, said the way the failure reads: which number was used
   * twice. The density check above already refuses a repeat, but it reports it
   * as two long lists of integers that differ somewhere in the middle, and the
   * person reading that has a merge of six renumbered migrations in front of
   * them. Both directories are held by `repeatedMigrationNumbers`, so the two
   * stores cannot drift into two answers about what a number means.
   */
  it("use each number once, and say which if not", async () => {
    expect(repeatedMigrationNumbers(await readMigrations())).toEqual([]);
  });

  /**
   * The journal is drizzle's own bookkeeping — nothing applies from it, the
   * plain SQL above is what boot reads — and it is what the generator diffs the
   * next migration against. A journal that disagrees with the files is a
   * generator working from a schema no instance ever had, so it is held to the
   * same story: the same tags, in the same order, one entry each.
   */
  it("are the same story the generator's journal tells", async () => {
    const journal = JSON.parse(
      await readFile(
        path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: readonly { idx: number; tag: string }[] };
    const files = (await readMigrations()).map((migration) =>
      migration.name.replace(/\.sql$/, ""),
    );

    expect(journal.entries.map((entry) => entry.tag)).toEqual(files);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      files.map((_, index) => index),
    );
  });
});

/**
 * The newest snapshot, held to the schema it claims to be a snapshot of.
 *
 * **The snapshot is the baseline every future `db:generate` diffs against, and
 * a wrong baseline does not stay one wrong migration.** Whatever it
 * misremembers is reported as still pending, so the next person to add a column
 * gets a statement about somebody else's column bundled into their unrelated
 * migration — and it travels forward with every generate after that.
 *
 * The journal test above holds the *files* to one story. This holds the
 * *schema* to it, which is the half that had no check: the drift that produced
 * this test was a column recorded as `text` where the schema says
 * `text COLLATE "C"`, and nothing failed. Every migration ran correctly, every
 * database ended up right, and only `drizzle-kit generate` knew.
 *
 * It reads files and nothing else, so it costs milliseconds and needs no
 * database. `schema-shape.test.ts` asks the other question — whether a *live*
 * migrated database matches the schema — and the two together are what make a
 * hand-edited snapshot loud.
 */
describe("the newest snapshot", () => {
  /** Every column the schema declares, by table, as its SQL type. */
  const declared = new Map<string, Map<string, string>>(
    (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => {
        const config = getTableConfig(table);
        return [
          config.name,
          new Map(
            config.columns.map((column) => [column.name, column.getSQLType()]),
          ),
        ] as const;
      }),
  );

  type Snapshot = {
    readonly tables: Readonly<
      Record<
        string,
        { readonly columns: Readonly<Record<string, { readonly type: string }>> }
      >
    >;
  };

  async function newest(): Promise<Snapshot> {
    const journal = JSON.parse(
      await readFile(
        path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: readonly { idx: number }[] };
    const last = journal.entries.at(-1);
    if (last === undefined) throw new Error("the journal holds no entries");

    return JSON.parse(
      await readFile(
        path.join(
          MIGRATIONS_DIRECTORY,
          "meta",
          `${String(last.idx).padStart(4, "0")}_snapshot.json`,
        ),
        "utf8",
      ),
    ) as Snapshot;
  }

  it("records every table the schema declares", async () => {
    const snapshot = await newest();
    expect(declared.size).toBeGreaterThan(0);
    for (const table of declared.keys()) {
      expect(snapshot.tables[`public.${table}`], table).toBeDefined();
    }
  });

  it("records every column as the type the schema says it is", async () => {
    const snapshot = await newest();
    const disagreements: string[] = [];

    for (const [table, columns] of declared) {
      const recorded = snapshot.tables[`public.${table}`]?.columns ?? {};
      for (const [column, type] of columns) {
        const held = recorded[column]?.type;
        if (held !== type) {
          disagreements.push(
            `${table}.${column}: the schema says ${type}, the snapshot says ${String(held)}`,
          );
        }
      }
    }

    // Named rather than counted, because the fix is per column and a bare
    // count would send somebody hunting through three thousand lines of JSON.
    expect(disagreements).toEqual([]);
  });
});

/**
 * The newest snapshot, held to the database the migrations actually build.
 *
 * **The two tests above cost nothing because they read files, and that is also
 * their limit: a snapshot is generated, but a migration's SQL body is not
 * always.** Drizzle writes the naive diff — `ADD COLUMN … NOT NULL` — which
 * fails outright on a table that already holds rows and moves no data, so a
 * migration that has to backfill is authored by hand: add nullable, fill every
 * row, then `SET NOT NULL`. That is correct and it is what `0030` does.
 *
 * It leaves a gap nothing else covers. Drizzle never reads the `.sql` when it
 * diffs, so an authored body and its generated snapshot can disagree and no
 * tool notices — and the next `generate` would then plan against a schema that
 * does not exist. The file tests cannot see it, because both files can be
 * internally consistent while the SQL between them builds something else.
 *
 * Nullability is where they come apart, and it is the one thing nothing checked:
 * the type test above compares types only, and `schema-shape.test.ts` pins
 * nullability for exactly two columns of `simulation` as a structural claim
 * about runs. A column left nullable by an authored body while the snapshot
 * claims otherwise passed every test in this repository until this one.
 *
 * So: build from empty, ask Postgres what it ended up with, and hold every
 * column to what the snapshot claims.
 */
describe("the newest snapshot, against what the migrations build", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("snapshot_agreement");
    await runMigrations(database.url);
  });

  afterAll(async () => {
    await database.drop();
  });

  it("claims every column the migrations build, and no other", async () => {
    const journal = JSON.parse(
      await readFile(
        path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: readonly { idx: number }[] };
    const last = journal.entries.at(-1);
    if (last === undefined) throw new Error("the journal holds no entries");

    const snapshot = JSON.parse(
      await readFile(
        path.join(
          MIGRATIONS_DIRECTORY,
          "meta",
          `${String(last.idx).padStart(4, "0")}_snapshot.json`,
        ),
        "utf8",
      ),
    ) as {
      readonly tables: Readonly<
        Record<
          string,
          {
            readonly name: string;
            readonly columns: Readonly<
              Record<string, { readonly name: string; readonly notNull: boolean }>
            >;
          }
        >
      >;
    };

    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    let built: Map<string, boolean>;
    try {
      const { rows } = await client.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(
        `select table_name, column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public'`,
      );
      built = new Map(
        rows.map((row) => [
          `${row.table_name}.${row.column_name}`,
          row.is_nullable === "NO",
        ]),
      );
    } finally {
      await client.end();
    }

    const disagreements: string[] = [];
    let compared = 0;

    for (const table of Object.values(snapshot.tables)) {
      for (const column of Object.values(table.columns)) {
        const key = `${table.name}.${column.name}`;
        const inDatabase = built.get(key);
        if (inDatabase === undefined) {
          disagreements.push(
            `${key}: the snapshot claims it, the migrations build no such column`,
          );
          continue;
        }
        compared += 1;
        if (inDatabase !== column.notNull) {
          disagreements.push(
            `${key}: the snapshot says notNull=${column.notNull}, the migrations build notNull=${inDatabase}`,
          );
        }
        built.delete(key);
      }
    }

    for (const key of built.keys()) {
      // Drizzle's own bookkeeping is not part of the schema it describes.
      if (key.startsWith("__drizzle")) continue;
      disagreements.push(
        `${key}: the migrations build it, the snapshot claims no such column`,
      );
    }

    // Named rather than counted, for the same reason as the type test above:
    // the fix is per column, and a count sends somebody hunting through
    // thousands of lines of JSON to find which one.
    expect(disagreements).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  });

  it("builds the non-negative grading sequence base used by later claims", async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows: columns } = await client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'grading_job'
            and column_name = 'sequence_base'`,
      );
      expect(columns).toEqual([{
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      }]);

      const { rows: constraints } = await client.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conname = 'grading_job_sequence_base_is_counted'`,
      );
      expect(constraints).toHaveLength(1);
      expect(constraints[0]?.definition).toMatch(/sequence_base.*>= 0/i);
    } finally {
      await client.end();
    }
  });
});

describe("applying migrations on boot", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("boot");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("succeeds against an empty database", async () => {
    const expected = await readMigrations();
    const result = await runMigrations(database.url);

    expect(result.applied).toEqual(expected.map((migration) => migration.name));
    expect(result.alreadyApplied).toEqual([]);
  });

  it("leaves the citext extension in place", async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        "select extname from pg_extension where extname = 'citext'",
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("applies nothing on the second boot, and does not error", async () => {
    const expected = await readMigrations();
    const result = await runMigrations(database.url);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(
      expect.arrayContaining(expected.map((migration) => migration.name)),
    );
  });

  it("reconciles the exact pre-hosted 0040 correction without reapplying it", async () => {
    const [correction] = MIGRATION_HASH_CORRECTIONS;
    if (correction === undefined) throw new Error("0040 correction is missing");
    const migration = (await readMigrations()).find(
      (candidate) => candidate.name === correction.name,
    );
    expect(migration?.hash).toBe(correction.correctedHash);

    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        `update egma_meta.migration set hash = $1 where name = $2`,
        [correction.previouslyRecordedHash, correction.name],
      );
    } finally {
      await client.end();
    }

    const result = await runMigrations(database.url);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain(correction.name);

    const checked = new pg.Client({ connectionString: database.url });
    await checked.connect();
    try {
      const { rows } = await checked.query<{ hash: string }>(
        `select hash from egma_meta.migration where name = $1`,
        [correction.name],
      );
      expect(rows).toEqual([{ hash: correction.correctedHash }]);
    } finally {
      await checked.end();
    }
  });

  it("refuses a migration file that changed after it was applied", async () => {
    await expect(
      runMigrations(
        database.url,
        fileURLToPath(new URL("./fixtures/edited", import.meta.url)),
      ),
    ).rejects.toThrow(/has changed since it was applied/);
  });
});

describe("two instances booting at the same moment", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("concurrent");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("do not both apply — one waits, then finds nothing to do", async () => {
    const expected = await readMigrations();

    const [first, second] = await Promise.all([
      runMigrations(database.url),
      runMigrations(database.url),
    ]);

    const appliedCounts = [first.applied.length, second.applied.length].sort();
    expect(appliedCounts).toEqual([0, expected.length]);

    const waiter = first.applied.length === 0 ? first : second;
    expect(waiter.alreadyApplied).toEqual(
      expect.arrayContaining(expected.map((migration) => migration.name)),
    );
  });
});

describe("the boot-time advisory lock", () => {
  let database: EmptyDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase("advisory_lock");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("is what makes a second instance wait", async () => {
    const { namespace, id } = MIGRATION_ADVISORY_LOCK;
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    await holder.query(`select pg_advisory_lock(${namespace}, ${id})`);

    let finished = false;
    const booting = runMigrations(database.url).then((result) => {
      finished = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(finished).toBe(false);

    await holder.query(`select pg_advisory_unlock(${namespace}, ${id})`);
    await holder.end();

    const result = await booting;
    expect(result.applied.length).toBeGreaterThan(0);
  });
});

describe("the persona rename (0005)", () => {
  let database: EmptyDatabase;
  let beforeTheRename: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  // The bodies are minted now-format and re-prefixed old-format, so the rows
  // below are exactly what a pre-rename deployment would hold.
  const identityBody = newId("prs").slice("prs_".length);
  const versionBody = newId("prsv").slice("prsv_".length);

  beforeAll(async () => {
    database = await createEmptyDatabase("persona_rename");

    // The world as it was: every migration before the rename, in a directory
    // of its own, so a digital_human row can exist for 0005 to find.
    beforeTheRename = await mkdtemp(path.join(os.tmpdir(), "egma-before-0005-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0005") {
        await writeFile(
          path.join(beforeTheRename, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRename);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query("begin");
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      `insert into digital_human (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [`dh_${identityBody}`, organizationId, projectId, `dhv_${versionBody}`],
    );
    await client.query(
      `insert into digital_human_version (id, digital_human_id, version, traits)
       values ($1, $2, 1, '{"personality":"Plain"}'::jsonb)`,
      [`dhv_${versionBody}`, `dh_${identityBody}`],
    );
    await client.query("commit");
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRename, { recursive: true, force: true });
    await database.drop();
  });

  it("leads what is still pending on a pre-rename database", async () => {
    const result = await runMigrations(database.url);
    // Everything before the rename is already applied and must not run twice,
    // so the rename is the first thing left. Whatever was numbered after it
    // follows, which is why this names the leader rather than the whole list.
    expect(result.applied[0]).toBe("0005_rename_digital_human_to_persona.sql");
    expect(result.applied.every((name) => name >= "0005")).toBe(true);
  });

  it("carries the rows across and completes the newly required language", async () => {
    const personas = await client.query<{
      id: string;
      current_version_id: string;
    }>("select id, current_version_id from persona where id = $1", [
      `prs_${identityBody}`,
    ]);
    expect(personas.rows).toEqual([
      {
        id: `prs_${identityBody}`,
        current_version_id: `prsv_${versionBody}`,
      },
    ]);

    const versions = await client.query<{
      id: string;
      persona_id: string;
      traits: unknown;
    }>(
      "select id, persona_id, traits from persona_version where id = $1",
      [`prsv_${versionBody}`],
    );
    expect(versions.rows).toEqual([
      {
        id: `prsv_${versionBody}`,
        persona_id: `prs_${identityBody}`,
        traits: { personality: "Plain", language: "en-US" },
      },
    ]);
  });

  it("keeps the current-version pointer deferred, which create depends on", async () => {
    // 0003 wrote DEFERRABLE INITIALLY DEFERRED by hand because the schema
    // source cannot express it; 0005 renames that constraint rather than
    // recreating it, and this is the proof the clause survived the trip.
    const { rows } = await client.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `select condeferrable, condeferred from pg_constraint
       where conname = 'persona_current_version_id_persona_version_id_fk'`,
    );
    expect(rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });

  it("pins the new prefixes: a dh_ id no longer fits the check", async () => {
    await expect(
      client.query(
        `insert into persona (id, organization_id, project_id, name, current_version_id, revision)
         values ($1, $2, $3, 'Old Format', $4, 'a-revision')`,
        [
          `dh_${newId("prs").slice("prs_".length)}`,
          organizationId,
          projectId,
          `prsv_${versionBody}`,
        ],
      ),
    ).rejects.toThrow(/persona_id_prefix/);
  });
});

describe("the persona junction's rename (0008)", () => {
  let database: EmptyDatabase;
  let beforeTheRename: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const testId = newId("tst");
  const testVersionId = newId("tstv");

  beforeAll(async () => {
    database = await createEmptyDatabase("junction_rename");

    // The world as it was: every migration before the rename, in a directory of
    // its own, so a test_version_persona row can exist for 0008 to carry.
    beforeTheRename = await mkdtemp(path.join(os.tmpdir(), "egma-before-0008-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0008") {
        await writeFile(
          path.join(beforeTheRename, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRename);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query("begin");
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organizationId, projectId, personaVersionId],
    );
    await client.query(
      `insert into persona_version (id, persona_id, version, traits)
       values ($1, $2, 1, '{"personality":"Plain"}'::jsonb)`,
      [personaVersionId, personaId],
    );
    await client.query(
      `insert into test (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Reschedules a booked appointment', $4)`,
      [testId, organizationId, projectId, testVersionId],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $2, 1, '{"scenario": "moves it", "expectedBehaviors": ["confirms"]}'::jsonb)`,
      [testVersionId, testId],
    );
    await client.query(
      `insert into test_version_persona (test_version_id, persona_id, position)
       values ($1, $2, 1)`,
      [testVersionId, personaId],
    );
    await client.query("commit");

    await runMigrations(database.url);
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRename, { recursive: true, force: true });
    await database.drop();
  });

  it("carries the rows across rather than rebuilding the table under them", async () => {
    const { rows } = await client.query<{
      test_version_id: string;
      persona_id: string;
      position: number;
    }>("select test_version_id, persona_id, position from test_persona");
    expect(rows).toEqual([
      { test_version_id: testVersionId, persona_id: personaId, position: 1 },
    ]);
  });

  it("renames the constraints and the index rather than recreating them", async () => {
    const { rows: constraints } = await client.query<{ conname: string }>(
      `select con.conname
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
        where c.relname = 'test_persona' and con.contype in ('p', 'u', 'c', 'f')
        order by con.conname`,
    );
    expect(constraints.map((row) => row.conname)).toEqual([
      "test_persona_persona_id_persona_id_fk",
      "test_persona_pk",
      "test_persona_test_version_id_prefix",
      "test_persona_test_version_id_test_version_id_fk",
      "test_persona_version_id_position_unique",
    ]);

    const { rows: indexes } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'test_persona'
        order by indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      "test_persona_persona_id_idx",
      "test_persona_pk",
      "test_persona_version_id_position_unique",
    ]);
  });

  it("keeps the prefix check the junction was built with", async () => {
    await expect(
      client.query(
        `insert into test_persona (test_version_id, persona_id, position)
         values ($1, $2, 2)`,
        [newId("tst"), personaId],
      ),
    ).rejects.toThrow(/test_persona_test_version_id_prefix/);
  });

});

describe("the simulation's test pin (0009)", () => {
  let database: EmptyDatabase;
  let beforeThePin: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");
  const connectionId = newId("con");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const runId = newId("run");
  const simulationId = newId("sim");
  const testId = newId("tst");
  const testVersionId = newId("tstv");

  beforeAll(async () => {
    database = await createEmptyDatabase("simulation_test_pin");

    // The world as it was: every migration before the pin, in a directory of
    // its own, so a simulation row can exist for 0009 to arrive on top of.
    beforeThePin = await mkdtemp(path.join(os.tmpdir(), "egma-before-0009-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0009") {
        await writeFile(path.join(beforeThePin, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeThePin);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agentId, organizationId, projectId],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'Staging', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connectionId, organizationId, projectId, agentId],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organizationId, projectId, personaVersionId],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{\"personality\":\"Plain\"}'::jsonb)",
      [personaVersionId, personaId],
    );
    await client.query(
      `insert into test (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Reschedules a booked appointment', $4)`,
      [testId, organizationId, projectId, testVersionId],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $2, 1, '{"scenario": "Moves a booking", "expectedBehaviors": ["verifies who it is speaking to"]}'::jsonb)`,
      [testVersionId, testId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status, triggered_via,
          requested_personas, connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb, 1)`,
      [
        runId,
        organizationId,
        projectId,
        agentId,
        connectionId,
        JSON.stringify({ personaIds: [personaId] }),
        JSON.stringify({
          type: "retell",
          modality: "chat",
          topology: "hosted-broker",
          environment: null,
          config: {},
        }),
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'retell', 'chat', 'queued')`,
      [
        simulationId,
        runId,
        organizationId,
        projectId,
        agentId,
        connectionId,
        personaId,
        personaVersionId,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeThePin, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds simulations", async () => {
    await addHistoricalMigration(beforeThePin, "0009_simulation_test_pin.sql");
    const result = await runMigrations(database.url, beforeThePin);
    expect(result.applied[0]).toBe("0009_simulation_test_pin.sql");
    expect(result.applied.every((name) => name >= "0009")).toBe(true);
  });

  it("leaves the simulation that was already there exactly as it was, pinning nothing", async () => {
    const { rows } = await client.query<{
      id: string;
      persona_version_id: string;
      status: string;
      test_id: string | null;
      test_version_id: string | null;
    }>(
      "select id, persona_version_id, status, test_id, test_version_id from simulation",
    );
    expect(rows).toEqual([
      {
        id: simulationId,
        persona_version_id: personaVersionId,
        status: "queued",
        test_id: null,
        test_version_id: null,
      },
    ]);
  });

  it("lets that same row be pinned afterwards, which is what the column is for", async () => {
    await client.query(
      "update simulation set test_id = $1, test_version_id = $2 where id = $3",
      [testId, testVersionId, simulationId],
    );

    const { rows } = await client.query<{
      test_id: string;
      test_version_id: string;
    }>("select test_id, test_version_id from simulation where id = $1", [
      simulationId,
    ]);
    expect(rows).toEqual([
      { test_id: testId, test_version_id: testVersionId },
    ]);
  });
});

describe("the re-grade's narrowing (0013)", () => {
  let database: EmptyDatabase;
  let beforeTheNarrowing: string;
  let throughBeforeProductionReset: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const jobId = newId("gjb");
  const traceId = "0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    database = await createEmptyDatabase("regrade_narrowing");

    // The world as it was: every migration before the narrowing, in a directory
    // of its own, so a conversation egma has already judged is sitting in the
    // queue when 0013 arrives on top of it.
    beforeTheNarrowing = await mkdtemp(
      path.join(os.tmpdir(), "egma-before-0013-"),
    );
    for (const migration of await readMigrations()) {
      if (migration.name < "0013") {
        await writeFile(
          path.join(beforeTheNarrowing, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheNarrowing);

    // Keep this historical proof at the last release before Monitoring resets
    // old production jobs. Applying 0038 here would erase the row before this
    // describe could prove what 0013 itself did to it.
    throughBeforeProductionReset = await mkdtemp(
      path.join(os.tmpdir(), "egma-through-0037-"),
    );
    for (const migration of await readMigrations()) {
      if (migration.name < "0038") {
        await writeFile(
          path.join(throughBeforeProductionReset, migration.name),
          migration.sql,
        );
      }
    }

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    // A production trace's job, because it is the source that needs no run and
    // no simulation behind it — and a *graded* one, because a settled job is
    // exactly what the check 0013 brings is about: a deployment with judged
    // conversations in it must take the constraint rather than be rejected by it.
    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, trace_id, status,
          first_span_at, last_span_at, last_seen_at, root_closed_at,
          attempts, finished_at)
       values ($1, $2, $3, 'production', $4, 'graded',
               now(), now(), now(), now(), 1, now())`,
      [jobId, organizationId, projectId, traceId],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheNarrowing, { recursive: true, force: true });
    await rm(throughBeforeProductionReset, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds judged conversations", async () => {
    const result = await runMigrations(
      database.url,
      throughBeforeProductionReset,
    );
    expect(result.applied[0]).toBe("0013_regrade_narrowing.sql");
    expect(
      result.applied.every((name) => name >= "0013" && name < "0038"),
    ).toBe(true);
  });

  it("leaves the job that was already there narrowed to nothing, which is what every job starts as", async () => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      regrade_grader_id: string | null;
    }>("select id, status, regrade_grader_id from grading_job");

    expect(rows).toEqual([
      { id: jobId, status: "graded", regrade_grader_id: null },
    ]);
  });

  it("brings the check that keeps a narrowing on work still outstanding", async () => {
    // The settled row above is why this constraint could be added at all: it
    // validates every row already in the table, and a null narrowing satisfies
    // it whatever state the job is in.
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'grading_job_only_outstanding_work_is_narrowed'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("regrade_grader_id IS NULL");
    expect(rows[0]?.definition).toContain("'pending'");
    expect(rows[0]?.definition).toContain("'claimed'");
  });

  it("points the column at the grader table, so a narrowing names a grader that exists", async () => {
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'grading_job_regrade_grader_id_grader_id_fk'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toMatch(
      /FOREIGN KEY \(regrade_grader_id\) REFERENCES grader\(id\)/,
    );
  });
});

describe("the run-events record and the run's pin (0014)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the record, in a directory of its own. */
  let beforeTheRecord: string;
  let client: pg.Client;

  const organization = newId("org");
  const project = newId("prj");
  const agent = newId("agt");
  const connection = newId("con");
  const personaId = newId("prs");
  const personaVersion = newId("prsv");
  const run = newId("run");
  const simulation = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("run_events_upgrade");
    beforeTheRecord = await mkdtemp(path.join(os.tmpdir(), "egma-before-0014-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0014") {
        await writeFile(
          path.join(beforeTheRecord, migration.name),
          migration.sql,
        );
      }
    }
    await runMigrations(database.url, beforeTheRecord);

    // A customer's work, written the way that release wrote it: a run over a
    // connection, one conversation inside it, and no pinned-version column
    // anywhere — which is exactly what 0014 has to upgrade over.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organization],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [project, organization],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agent, organization, project],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connection, organization, project, agent],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organization, project, personaVersion],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{\"personality\":\"Plain\"}'::jsonb)",
      [personaVersion, personaId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, requested_personas, connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb, 1)`,
      [
        run,
        organization,
        project,
        agent,
        connection,
        JSON.stringify({ personaIds: [personaId] }),
        JSON.stringify({
          type: "retell",
          modality: "chat",
          topology: "hosted-broker",
          environment: null,
          config: {},
        }),
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'retell', 'chat', 'queued')`,
      [
        simulation,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheRecord, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds work", async () => {
    await addHistoricalMigration(beforeTheRecord, "0014_run_events.sql");
    const result = await runMigrations(database.url, beforeTheRecord);
    expect(result.applied[0]).toBe("0014_run_events.sql");
    expect(result.applied.every((name) => name >= "0014")).toBe(true);
  });

  it("says what is true of the run that was already there: it pinned no version", async () => {
    const { rows } = await client.query<{
      pinned_test_versions: { testVersionIds: string[] };
    }>("select pinned_test_versions from run where id = $1", [run]);
    expect(rows[0]?.pinned_test_versions).toEqual({ testVersionIds: [] });
  });

  it("drops the backfill's default, so the next run has to say what it pinned", async () => {
    await expect(
      client.query(
        `insert into run
           (id, organization_id, project_id, agent_id, connection_id, status,
            triggered_via, requested_personas, connection_snapshot, expected_simulation_count)
         values ($1, $2, $3, $4, $5, 'pending', 'manual', '{}'::jsonb, '{}'::jsonb, 1)`,
        [newId("run"), organization, project, agent, connection],
      ),
    ).rejects.toThrow(/pinned_test_versions/u);
  });

  it("brings a record that is a record: an event cannot be rewritten afterwards", async () => {
    await client.query(
      `insert into run_event
         (run_id, seq, organization_id, project_id, kind, status)
       values ($1, 1, $2, $3, 'run', 'pending')`,
      [run, organization, project],
    );
    await expect(
      client.query(
        "update run_event set status = 'running' where run_id = $1 and seq = 1",
        [run],
      ),
    ).rejects.toThrow(/is written once/u);
  });
});


describe("the dispatch-failure vocabulary (0015)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the widened word, in a directory of its own. */
  let beforeTheWord: string;
  let client: pg.Client;

  const organization = newId("org");
  const project = newId("prj");
  const agent = newId("agt");
  const connection = newId("con");
  const personaId = newId("prs");
  const personaVersion = newId("prsv");
  const run = newId("run");
  const claimed = newId("sim");
  const landed = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("dispatch_failure_upgrade");
    beforeTheWord = await mkdtemp(path.join(os.tmpdir(), "egma-before-0015-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0015") {
        await writeFile(path.join(beforeTheWord, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheWord);

    // A customer's work as that release wrote it: a run over a connection,
    // one conversation still queued, and one already landed with the old
    // vocabulary — because 0015 re-validates the widened checks over every
    // row that exists, so they have to hold for what the old release wrote.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organization],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [project, organization],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agent, organization, project],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [connection, organization, project, agent],
    );
    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id)
       values ($1, $2, $3, 'Impatient Rita', $4)`,
      [personaId, organization, project, personaVersion],
    );
    await client.query(
      "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{\"personality\":\"Plain\"}'::jsonb)",
      [personaVersion, personaId],
    );
    await client.query("commit");
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, pinned_test_versions, requested_personas,
          connection_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb,
          $8::jsonb, 2)`,
      [
        run,
        organization,
        project,
        agent,
        connection,
        JSON.stringify({ testVersionIds: [] }),
        JSON.stringify({ personaIds: [personaId] }),
        JSON.stringify({
          type: "retell",
          modality: "chat",
          topology: "hosted-broker",
          environment: null,
          config: {},
        }),
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality,
          status, claimed_by, claimed_at, heartbeat_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'retell', 'chat', 'claimed',
          'simulator-blue-1', now(), now())`,
      [
        claimed,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, position, connection_type, modality,
          status, ending_reason, claimed_by, claimed_at, heartbeat_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 2, 'retell', 'chat',
          'failed', 'simulator_error', 'simulator-blue-1', now(), now(), now())`,
      [
        landed,
        run,
        organization,
        project,
        agent,
        connection,
        personaId,
        personaVersion,
      ],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheWord, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds landed work", async () => {
    await addHistoricalMigration(beforeTheWord, "0015_dispatch_failure.sql");
    const result = await runMigrations(database.url, beforeTheWord);
    expect(result.applied[0]).toBe("0015_dispatch_failure.sql");
    expect(result.applied.every((name) => name >= "0015")).toBe(true);
  });

  it("keeps what was already true: the landed conversation keeps its reason", async () => {
    const { rows } = await client.query<{ ending_reason: string }>(
      "select ending_reason from simulation where id = $1",
      [landed],
    );
    expect(rows[0]?.ending_reason).toBe("simulator_error");
  });

  it("lets a claimed row the old release wrote take the landing the upgrade brings", async () => {
    await client.query(
      `update simulation
       set status = 'failed', ending_reason = 'dispatch_failed', ended_at = now()
       where id = $1`,
      [claimed],
    );
    const { rows } = await client.query<{ ending_reason: string }>(
      "select ending_reason from simulation where id = $1",
      [claimed],
    );
    expect(rows[0]?.ending_reason).toBe("dispatch_failed");
  });

  it("holds the widened word to its class: a way to have failed, never to have ended", async () => {
    await expect(
      client.query(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, position, modality,
            status, ending_reason, claimed_by, claimed_at, heartbeat_at,
            started_at, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 3, 'chat',
            'completed', 'dispatch_failed', 'simulator-blue-1', now(), now(),
            now(), now())`,
        [
          newId("sim"),
          run,
          organization,
          project,
          agent,
          connection,
          personaId,
          personaVersion,
        ],
      ),
    ).rejects.toThrow(/simulation_ending_reason_agrees/u);
  });

  it("lets the record speak the widened word, and stay a record", async () => {
    await client.query(
      `insert into run_event
         (run_id, seq, organization_id, project_id, kind, simulation_id, status, reason)
       values ($1, 1, $2, $3, 'simulation', $4, 'failed', 'dispatch_failed')`,
      [run, organization, project, claimed],
    );
    await expect(
      client.query(
        "update run_event set reason = 'simulator_error' where run_id = $1 and seq = 1",
        [run],
      ),
    ).rejects.toThrow(/is written once/u);
  });
});

/* ------------------------------------------------------------------- *
 * Seeding a customer's work the way an older release wrote it.
 * ------------------------------------------------------------------- */

/**
 * Everything one seeded run is made of: the tenancy above it, the agent it
 * reaches over one connection, the persona at one version, and the run itself.
 *
 * Written by hand rather than through the data-access module, on purpose. The
 * point of an upgrade check is what the *older* release wrote, and the module
 * writes what today's schema takes — so seeding through it would put today's
 * rows in and then congratulate the migration for coping with them.
 */
type ACustomersWork = {
  readonly organization: string;
  readonly project: string;
  readonly agent: string;
  readonly connection: string;
  readonly personaId: string;
  readonly personaVersion: string;
  readonly run: string;
  /** How many conversations the run says it expects, which its rows must match. */
  readonly expected: number;
};

async function seedACustomersWork(
  client: pg.Client,
  work: ACustomersWork,
): Promise<void> {
  await client.query(
    "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
    [work.organization],
  );
  await client.query(
    "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
    [work.project, work.organization],
  );
  await client.query(
    "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
    [work.agent, work.organization, work.project],
  );
  await client.query(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
     values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
    [work.connection, work.organization, work.project, work.agent],
  );
  // The persona and the version name each other, so they go in together.
  await client.query("begin");
  await client.query(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [work.personaId, work.organization, work.project, work.personaVersion],
  );
  await client.query(
    "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{\"personality\":\"Plain\"}'::jsonb)",
    [work.personaVersion, work.personaId],
  );
  await client.query("commit");
  await client.query(
    `insert into run
       (id, organization_id, project_id, agent_id, connection_id, status,
        triggered_via, pinned_test_versions, requested_personas,
        connection_snapshot, expected_simulation_count)
     values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb,
        $8::jsonb, $9)`,
    [
      work.run,
      work.organization,
      work.project,
      work.agent,
      work.connection,
      JSON.stringify({ testVersionIds: [] }),
      JSON.stringify({ personaIds: [work.personaId] }),
      JSON.stringify({
        type: "retell",
        modality: "chat",
        topology: "hosted-broker",
        environment: null,
        config: {},
      }),
      work.expected,
    ],
  );
}

/**
 * Where one seeded conversation stood when the older release stopped writing
 * it: still waiting, finished, or landed by that release's own claim path as
 * work it could never hand over.
 */
type SimulationShape = "queued" | "completed" | "dispatch_failed";

/**
 * Writes `connection_type`, which 0019 drops — so this helper can only seed
 * a schema that has not migrated that far yet. Every block that uses it
 * replays to a pinned point before inserting; a block that migrates to the
 * head first must write its own insert.
 */
async function insertSimulation(
  client: pg.Client,
  work: ACustomersWork,
  simulation: {
    readonly id: string;
    readonly position: number;
    readonly shape: SimulationShape;
    /** Chat unless a case needs the audio facts, which only voice may hold. */
    readonly modality?: "chat" | "voice" | undefined;
    /**
     * What the conversation was, for a release that kept it in the row's
     * three jsonb columns. Written in the insert rather than an update
     * afterwards, because a terminal simulation is written once and the row
     * itself enforces that.
     */
    readonly conversation?:
      | {
          readonly transcript: unknown;
          readonly events: unknown;
          readonly metrics: unknown;
        }
      | undefined;
  },
): Promise<void> {
  const landing = {
    queued: { columns: "", values: ", 'queued'" },
    completed: {
      columns: `, claimed_by, claimed_at, heartbeat_at, started_at, ended_at,
                ending_reason`,
      values: `, 'completed', 'simulator-blue-1', now(), now(), now(), now(),
               'persona_concluded'`,
    },
    dispatch_failed: {
      columns: ", claimed_by, claimed_at, heartbeat_at, ended_at, ending_reason",
      values: `, 'failed', 'simulator-blue-1', now(), now(), now(),
               'dispatch_failed'`,
    },
  }[simulation.shape];

  // The conversation's three slots come last in the parameter list, so a
  // statement that does not name them simply stops before them.
  const held = simulation.conversation;
  await client.query(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, position, connection_type, modality,
        status${landing.columns}${
          held === undefined ? "" : ", transcript, events, metrics"
        })
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'retell', $10${landing.values}${
       held === undefined ? "" : ", $11::jsonb, $12::jsonb, $13::jsonb"
     })`,
    [
      simulation.id,
      work.run,
      work.organization,
      work.project,
      work.agent,
      work.connection,
      work.personaId,
      work.personaVersion,
      simulation.position,
      simulation.modality ?? "chat",
      ...(held === undefined
        ? []
        : [
            JSON.stringify(held.transcript),
            JSON.stringify(held.events),
            JSON.stringify(held.metrics),
          ]),
    ],
  );
}

describe("the simulation's summary facts (0016)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood before the two facts, in a directory of its own. */
  let beforeTheFacts: string;
  let client: pg.Client;

  const work: ACustomersWork = {
    organization: newId("org"),
    project: newId("prj"),
    agent: newId("agt"),
    connection: newId("con"),
    personaId: newId("prs"),
    personaVersion: newId("prsv"),
    run: newId("run"),
    expected: 3,
  };
  const queued = newId("sim");
  const landed = newId("sim");
  const undispatched = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("summary_facts_upgrade");
    beforeTheFacts = await mkdtemp(path.join(os.tmpdir(), "egma-before-0016-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0016") {
        await writeFile(path.join(beforeTheFacts, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheFacts);

    // A customer's work as that release wrote it: one conversation still
    // queued, one finished, and one that release's own claim path landed as
    // dispatch_failed. The last two are the rows the new columns are about,
    // and the rows their guards re-validate on the way in.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await seedACustomersWork(client, work);
    await insertSimulation(client, work, {
      id: queued,
      position: 1,
      shape: "queued",
    });
    await insertSimulation(client, work, {
      id: landed,
      position: 2,
      shape: "completed",
    });
    await insertSimulation(client, work, {
      id: undispatched,
      position: 3,
      shape: "dispatch_failed",
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheFacts, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds landed work", async () => {
    await addHistoricalMigration(beforeTheFacts, "0016_simulation_summary_facts.sql");
    const result = await runMigrations(database.url, beforeTheFacts);
    expect(result.applied[0]).toBe("0016_simulation_summary_facts.sql");
    expect(result.applied.every((name) => name >= "0016")).toBe(true);
  });

  it("says what is true of the conversations that already landed: no facts", async () => {
    // No turn count and no provider reference, because no report could carry
    // either when they landed — never a number invented for them.
    const { rows } = await client.query<{
      turn_count: number | null;
      provider_reference: string | null;
    }>(
      `select turn_count, provider_reference from simulation
        where id in ($1, $2)`,
      [landed, undispatched],
    );
    expect(rows).toEqual([
      { turn_count: null, provider_reference: null },
      { turn_count: null, provider_reference: null },
    ]);
  });

  it("brings the columns with their guard: a summary fact is a terminal fact", async () => {
    await expect(
      client.query("update simulation set turn_count = 3 where id = $1", [
        queued,
      ]),
    ).rejects.toThrow(/simulation_summary_facts_only_when_ended/u);
  });
});

/**
 * An instance that has been running since before a migration is the case a
 * migration is actually for, and it is the one an empty database never tests:
 * every check above starts from nothing, where a column added `not null` with
 * no default lands happily and would fail the moment a single row existed.
 *
 * So this applies the schema as it stood one migration ago, puts a customer's
 * work into it, and then upgrades — which is what a self-hoster's `docker
 * compose pull` does on a Tuesday morning.
 *
 * It named the *newest* migration to do that, and this is where that graduated:
 * the seed rows below write `transcript`, `events` and `metrics`, which is a
 * story only 0017 can tell, because 0017 is the migration that drops them. Read
 * through `at(-1)` it broke the moment anything landed after — the columns it
 * seeds no longer exist by then — so it names its own migration now, and the
 * newest migration's upgrade story lives in that migration's own describe, the
 * way the livekit type's does below.
 */
describe("the conversation leaving the row, over work already there (0017)", () => {
  let database: EmptyDatabase;
  /** The migration files, up to 0017's predecessor, as that release shipped. */
  let asItWas: string;

  beforeAll(async () => {
    database = await createEmptyDatabase("upgrade");
    asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-upgrade-"));
  });

  afterAll(async () => {
    await database.drop();
    await rm(asItWas, { recursive: true, force: true });
  });

  it("applies 0017 over rows the release before it wrote", async () => {
    const migrations = await readMigrations();
    const subject = migrations.findIndex((migration) =>
      migration.name.startsWith("0017_"),
    );
    if (subject === -1) throw new Error("0017 is missing");
    const newest = migrations[subject];
    if (newest === undefined) throw new Error("0017 is missing");
    const before0017 = migrations.slice(0, subject);

    for (const migration of before0017) {
      await writeFile(path.join(asItWas, migration.name), migration.sql);
    }
    const before = await runMigrations(database.url, asItWas);
    expect(before.applied).toEqual(
      before0017.map((migration) => migration.name),
    );

    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    const work: ACustomersWork = {
      organization: newId("org"),
      project: newId("prj"),
      agent: newId("agt"),
      connection: newId("con"),
      personaId: newId("prs"),
      personaVersion: newId("prsv"),
      run: newId("run"),
      expected: 3,
    };
    const queued = newId("sim");
    const landed = newId("sim");
    const dialing = newId("sim");
    try {
      // A customer's work, written the way the release before this one wrote
      // it: one conversation still queued, and one finished with its
      // transcript, its tool calls and its measures in the three jsonb
      // columns — because that release had nowhere else to put them. Those
      // columns are what this migration drops, so a row that actually holds
      // a conversation is the row the upgrade has to survive.
      await seedACustomersWork(client, work);
      await insertSimulation(client, work, {
        id: queued,
        position: 1,
        shape: "queued",
      });
      await insertSimulation(client, work, {
        id: landed,
        position: 2,
        shape: "completed",
        conversation: {
          transcript: [
            { speaker: "human", text: "Can you move my cleaning to Tuesday?" },
            { speaker: "agent", text: "Booked for Tuesday at four." },
          ],
          events: [{ kind: "tool_call", name: "reschedule_appointment" }],
          metrics: { turn_response_latency: [900, 1_100] },
        },
      });
      // And one voice conversation still waiting, because the check this
      // migration shrinks guards the audio facts and only voice may hold one.
      await insertSimulation(client, work, {
        id: dialing,
        position: 3,
        shape: "queued",
        modality: "voice",
      });

      // The upgrade itself, with that work sitting in the tables.
      await writeFile(path.join(asItWas, newest.name), newest.sql);
      const upgraded = await runMigrations(database.url, asItWas);
      expect(upgraded.applied).toEqual([newest.name]);

      // The three columns are gone from the table — asked of the schema
      // rather than of a row, because a column nobody selects any more is
      // not the same fact as a column that does not exist.
      const { rows: left } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'simulation'
            and column_name in ('transcript', 'events', 'metrics')`,
      );
      expect(left).toEqual([]);

      // And the conversations survive losing them, because what the row was
      // ever the record of is the lifecycle: both still read, unchanged.
      const { rows: kept } = await client.query<{
        id: string;
        status: string;
        ending_reason: string | null;
      }>(
        `select id, status, ending_reason from simulation
          where run_id = $1 order by position`,
        [work.run],
      );
      expect(kept).toEqual([
        { id: queued, status: "queued", ending_reason: null },
        { id: landed, status: "completed", ending_reason: "persona_concluded" },
        { id: dialing, status: "queued", ending_reason: null },
      ]);

      // The check that named the three columns shrinks to the audio facts
      // rather than being renamed, so a violation still prints the sentence
      // an operator is searching for — and it still guards them.
      await expect(
        client.query(
          "update simulation set recording_reference = 'r.wav' where id = $1",
          [dialing],
        ),
      ).rejects.toThrow(/simulation_report_only_when_ended/u);

      // And the shrunken check no longer names what is gone. A check holding
      // a dropped column could not exist, so this is what says the shrink
      // happened rather than the drop having been quietly refused.
      const { rows: guards } = await client.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'simulation_report_only_when_ended'`,
      );
      expect(guards).toHaveLength(1);
      expect(guards[0]?.definition).toContain("recording_reference");
      expect(guards[0]?.definition).not.toContain("transcript");
    } finally {
      await client.end();
    }
  });
});

describe("the livekit connection type (0018)", () => {
  let database: EmptyDatabase;
  let beforeLiveKit: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");
  const retellId = newId("con");

  /** A connection row, written straight past the access layer's own gates. */
  async function connectionOfType(id: string, type: string): Promise<void> {
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, $5, $6, 'voice', 'agent-dials-out', '{}'::jsonb)`,
      [id, organizationId, projectId, agentId, `${type}-1`, type],
    );
  }

  beforeAll(async () => {
    database = await createEmptyDatabase("livekit_type");

    // The world as it was: a customer already reaching an agent the ways egma
    // knew, so the widening lands on a table that is not empty.
    beforeLiveKit = await mkdtemp(path.join(os.tmpdir(), "egma-before-0018-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0018") {
        await writeFile(path.join(beforeLiveKit, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeLiveKit);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [agentId, organizationId, projectId],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
      [retellId, organizationId, projectId, agentId],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeLiveKit, { recursive: true, force: true });
    await database.drop();
  });

  it("is what the database refuses until the migration arrives", async () => {
    await expect(connectionOfType(newId("con"), "livekit")).rejects.toThrow(
      /connection_type_allowed/u,
    );
  });

  it("is what is still pending on a database that already holds connections", async () => {
    // Through 0018 and no further, the way the 0017 block above it stops.
    // What this block asserts next — the two checks the one list of types
    // feeds — is true of the schema 0018 left behind and stopped being true of
    // the newest schema the moment a later migration dropped one of them. A
    // migration's own describe is about the upgrade that migration is, so it
    // names the file it is about rather than reading whatever is newest.
    const widening = (await readMigrations()).find((migration) =>
      migration.name.startsWith("0018_"),
    );
    if (widening === undefined) throw new Error("0018 is missing");
    await writeFile(path.join(beforeLiveKit, widening.name), widening.sql);

    const result = await runMigrations(database.url, beforeLiveKit);
    expect(result.applied).toEqual(["0018_livekit_connection_type.sql"]);
  });

  it("adds livekit to the two checks the one list of types feeds, and nothing else", async () => {
    const { rows } = await client.query<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname in ('connection_type_allowed', 'simulation_connection_type_allowed')
        order by conname`,
    );

    expect(rows.map((row) => row.name)).toEqual([
      "connection_type_allowed",
      "simulation_connection_type_allowed",
    ]);
    for (const row of rows) {
      // The whole list rather than a search for "livekit": what a widening
      // must never do is quietly drop a type somebody is already reaching an
      // agent through.
      expect(row.definition).toContain(
        "ARRAY['retell'::text, 'phone'::text, 'livekit'::text]",
      );
    }
  });

  it("leaves the connections that were already there exactly as they were", async () => {
    const { rows } = await client.query<{ id: string; type: string }>(
      "select id, type from connection",
    );
    expect(rows).toEqual([{ id: retellId, type: "retell" }]);
  });

  it("takes a livekit connection once it has run", async () => {
    const livekitId = newId("con");
    await connectionOfType(livekitId, "livekit");

    const { rows } = await client.query<{ type: string }>(
      "select type from connection where id = $1",
      [livekitId],
    );
    expect(rows).toEqual([{ type: "livekit" }]);
  });
});

describe("the connection type leaving the simulation row (0019)", () => {
  let database: EmptyDatabase;
  /** The schema as it stood while the copy was still there, on its own. */
  let beforeTheDrop: string;
  let client: pg.Client;

  const work: ACustomersWork = {
    organization: newId("org"),
    project: newId("prj"),
    agent: newId("agt"),
    connection: newId("con"),
    personaId: newId("prs"),
    personaVersion: newId("prsv"),
    run: newId("run"),
    expected: 2,
  };
  const queued = newId("sim");
  const landed = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("connection_type_drop");
    beforeTheDrop = await mkdtemp(path.join(os.tmpdir(), "egma-before-0019-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0019") {
        await writeFile(path.join(beforeTheDrop, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, beforeTheDrop);

    // A customer's work as the release before this one wrote it: every
    // simulation carrying its own copy of the connection type, which is the
    // column the upgrade takes away underneath them.
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await seedACustomersWork(client, work);
    await insertSimulation(client, work, {
      id: queued,
      position: 1,
      shape: "queued",
    });
    await insertSimulation(client, work, {
      id: landed,
      position: 2,
      shape: "completed",
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(beforeTheDrop, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds conversations", async () => {
    await addHistoricalMigration(
      beforeTheDrop,
      "0019_simulation_connection_type_leaves_the_row.sql",
    );
    const result = await runMigrations(database.url, beforeTheDrop);
    expect(result.applied[0]).toBe(
      "0019_simulation_connection_type_leaves_the_row.sql",
    );
    expect(result.applied.every((name) => name >= "0019")).toBe(true);
  });

  it("takes the check and the column, both of them", async () => {
    // Asked of the schema rather than of a row: a column nothing selects any
    // more is not the same fact as a column that does not exist, and a check
    // left behind on a dropped column could not exist at all — so the two
    // questions together are what say the drop happened as one piece.
    const { rows: left } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'simulation' and column_name = 'connection_type'`,
    );
    expect(left).toEqual([]);

    const { rows: guards } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname = 'simulation_connection_type_allowed'`,
    );
    expect(guards).toEqual([]);
  });

  it("leaves the conversations that were already there exactly as they were", async () => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      ending_reason: string | null;
    }>(
      `select id, status, ending_reason from simulation
        where run_id = $1 order by position`,
      [work.run],
    );
    expect(rows).toEqual([
      { id: queued, status: "queued", ending_reason: null },
      { id: landed, status: "completed", ending_reason: "persona_concluded" },
    ]);
  });

  it("later replaces the legacy connection type check with the explicit axes", async () => {
    const { rows } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname in (
          'connection_type_allowed',
          'connection_agent_platform_allowed',
          'connection_kind_allowed',
          'connection_access_variant_allowed'
        ) order by conname`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "connection_access_variant_allowed",
      "connection_agent_platform_allowed",
      "connection_kind_allowed",
    ]);
  });

  it("keeps modality, which remains separate from the connection kind", async () => {
    // The row's own check names it, and a CHECK cannot join — which is why
    // this column stayed where the legacy type went. A recording on a conversation
    // that was not voice is still refused by the row itself, and the write
    // that proves it names no connection kind at all.
    await expect(
      client.query(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, position, modality, status,
            ending_reason, claimed_by, claimed_at, heartbeat_at, started_at,
            ended_at, recording_reference)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 3, 'chat', 'completed',
            'persona_concluded', 'simulator-blue-1', now(), now(), now(),
            now(), 'r.wav')`,
        [
          newId("sim"),
          work.run,
          work.organization,
          work.project,
          work.agent,
          work.connection,
          work.personaId,
          work.personaVersion,
        ],
      ),
    ).rejects.toThrow(/simulation_audio_facts_are_voice_facts/u);

    const { rows } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname = 'simulation_modality_allowed'`,
    );
    expect(rows).toHaveLength(1);
  });
});

/**
 * Archive, live revisions, the stored variant and the capability record, over a
 * database that already holds agents and connections (0029).
 *
 * Four changes in one migration because they are one change to what an agent
 * and a connection *are*, and every one of them has to land without changing
 * what an installed row means. The sharp cases are the two backfills: a
 * revision every row has to have before anybody can edit one, and a variant
 * that has to be the shape the code would have derived from that row's config
 * the moment before the upgrade ran.
 */
describe("the agent and connection lifecycle over installed data (0029)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const liveAgent = newId("agt");
  const goneAgent = newId("agt");
  const retellConnection = newId("con");
  const keyPairConnection = newId("con");
  const endpointConnection = newId("con");
  const phoneConnection = newId("con");
  /**
   * The sharp row, and the one the first version of this test could not have
   * caught because every connection it wrote hung off the *live* agent: a
   * connection still active under an agent the old release had already
   * soft-deleted. Nothing was wrong with it then — the parent's marker hid it
   * from every read — and everything is wrong with it after Restore exists,
   * because restoring the parent would bring it back live, carrying the
   * provider credential it was sealed with.
   */
  const orphanedChild = newId("con");

  beforeAll(async () => {
    database = await createEmptyDatabase("agent_lifecycle");

    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0029-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0029") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      "insert into project (id, organization_id, name, slug) values ($1, $2, 'Default', 'default')",
      [projectId, organizationId],
    );
    await client.query(
      "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, 'Front desk')",
      [liveAgent, organizationId, projectId],
    );
    // An agent the old release had soft-deleted. Archive is what that always
    // was, so the rename has to carry it across as an archived row rather than
    // leave it behind.
    await client.query(
      `insert into agent (id, organization_id, project_id, name, deleted_at)
       values ($1, $2, $3, 'Retired', now())`,
      [goneAgent, organizationId, projectId],
    );

    const connection = async (
      id: string,
      name: string,
      type: string,
      modality: string,
      topology: string,
      config: string,
      owner: string = liveAgent,
    ) =>
      client.query(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [id, organizationId, projectId, owner, name, type, modality, topology, config],
      );

    await connection(
      retellConnection,
      "retell-1",
      "retell",
      "chat",
      "hosted-broker",
      '{"retellAgentId":"agent_abc"}',
    );
    await connection(
      keyPairConnection,
      "livekit-1",
      "livekit",
      "voice",
      "agent-dials-out",
      '{"url":"wss://acme.livekit.cloud"}',
    );
    await connection(
      endpointConnection,
      "livekit-2",
      "livekit",
      "voice",
      "agent-dials-out",
      '{"url":"wss://acme.livekit.cloud","tokenEndpoint":"https://acme.example/token"}',
    );
    await connection(
      phoneConnection,
      "phone-1",
      "phone",
      "voice",
      "egma-dials-in",
      '{"phoneNumber":"+15551234567"}',
    );
    await connection(
      orphanedChild,
      "retell-1",
      "retell",
      "chat",
      "hosted-broker",
      '{"retellAgentId":"agent_orphan"}',
      goneAgent,
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds agents", async () => {
    const upgrade = (await readMigrations()).find((migration) =>
      migration.name.startsWith("0029_"),
    );
    if (upgrade === undefined) throw new Error("0029 is missing");
    await writeFile(path.join(before, upgrade.name), upgrade.sql);

    const { applied } = await runMigrations(database.url, before);
    expect(applied).toEqual([upgrade.name]);
  });

  it("carries a soft-deleted agent across as the archived agent it always was", async () => {
    const { rows } = await client.query<{ id: string; archived_at: Date | null }>(
      "select id, archived_at from agent order by id",
    );
    const byId = new Map(rows.map((row) => [row.id, row.archived_at]));

    expect(byId.get(liveAgent)).toBeNull();
    // The row is still there and still readable, which is the whole difference
    // between Archive and the deletion this replaced.
    expect(byId.get(goneAgent)).toBeInstanceOf(Date);
  });

  it("archives the live children of an agent that was already archived", async () => {
    const { rows } = await client.query<{ archived_at: Date | null }>(
      "select archived_at from connection where id = $1",
      [orphanedChild],
    );

    // Under the old rule this row was harmless: the parent's marker hid it from
    // every read. Under the new one, Restore brings the parent back — and a
    // child nobody archived would come back live, carrying the provider
    // credential it was sealed with. That is the one thing agent Restore
    // promises cannot happen.
    expect(rows[0]?.archived_at).toBeInstanceOf(Date);
  });

  it("leaves no active connection anywhere under an archived agent", async () => {
    // The property rather than the row: whatever installed data holds, after
    // this migration there is no way to reach an archived agent.
    const { rows } = await client.query<{ id: string }>(
      `select c.id from connection c
         join agent a on a.id = c.agent_id
        where a.archived_at is not null and c.archived_at is null`,
    );
    expect(rows.map((row) => row.id)).toEqual([]);
  });

  it("keeps that child archived when the agent is restored", async () => {
    // Restore writes the agent row and only the agent row, so the child stays
    // where the migration put it. This is the same promise the access-layer
    // tests make for agents archived after the upgrade; asserting it here is
    // what says it also holds for the ones archived before it.
    await client.query(
      "update agent set archived_at = null where id = $1",
      [goneAgent],
    );

    const { rows } = await client.query<{ archived_at: Date | null }>(
      "select archived_at from connection where id = $1",
      [orphanedChild],
    );
    expect(rows[0]?.archived_at).toBeInstanceOf(Date);

    // Put it back, so the assertions after this one still meet the world the
    // migration left behind.
    await client.query(
      "update agent set archived_at = now() where id = $1",
      [goneAgent],
    );
  });

  it("gives every row already there a revision, so the first edit has one to name", async () => {
    for (const table of ["agent", "connection"]) {
      const { rows } = await client.query<{ revision: string }>(
        `select revision from ${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // Opaque, and wearing the same shape the code mints, so nothing
        // downstream has two formats to read.
        expect(row.revision).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
      }
      // Each row's own, never one value shared out.
      const distinct = new Set(rows.map((row) => row.revision));
      expect(distinct.size).toBe(rows.length);
    }
  });

  it("freezes each connection's shape as the discriminator would have read it", async () => {
    const { rows } = await client.query<{ id: string; variant_id: string }>(
      "select id, variant_id from connection",
    );
    const byId = new Map(rows.map((row) => [row.id, row.variant_id]));

    expect(byId.get(retellConnection)).toBe("retell.api_key");
    expect(byId.get(phoneConnection)).toBe("phone.number");
    // The one type that comes in two shapes, told apart exactly as the registry
    // tells them apart: a config naming tokenEndpoint is the endpoint shape and
    // every other livekit config is the key pair. No connection changes
    // meaning; the derivation is simply written down.
    expect(byId.get(keyPairConnection)).toBe("livekit.key_pair");
    expect(byId.get(endpointConnection)).toBe("livekit.token_endpoint");
  });

  it("says of every installed connection that nobody has measured it", async () => {
    const { rows } = await client.query<{
      capability_state: string;
      capabilities_measured: unknown;
      capabilities_supported: unknown;
      capabilities_checked_at: Date | null;
      capability_source: string | null;
    }>(
      "select capability_state, capabilities_measured, capabilities_supported, capabilities_checked_at, capability_source from connection",
    );

    for (const row of rows) {
      // The truth: nothing had ever measured any of them. An empty measured
      // list would have claimed each was checked and every capability found
      // absent, which is a fact about targets nobody has ever reached.
      expect(row.capability_state).toBe("unknown");
      expect(row.capabilities_measured).toBeNull();
      expect(row.capabilities_supported).toBeNull();
      expect(row.capabilities_checked_at).toBeNull();
      expect(row.capability_source).toBeNull();
    }
  });

  it("brings the check that keeps a known state whole", async () => {
    await expect(
      client.query(
        `update connection set capability_state = 'known' where id = $1`,
        [retellConnection],
      ),
    ).rejects.toThrow(/connection_capability_evidence_agrees/u);
  });

  it("keeps the name rules, now released by Archive rather than by deletion", async () => {
    const second = async (id: string) =>
      client.query(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, type, modality, topology, variant_id, config, revision)
         values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', 'retell.api_key', '{}'::jsonb, 'rev_00000000000000000000000001')`,
        [id, organizationId, projectId, liveAgent],
      );

    await expect(second(newId("con"))).rejects.toThrow(
      /connection_agent_id_name_unique/u,
    );

    await client.query("update connection set archived_at = now() where id = $1", [
      retellConnection,
    ]);
    await expect(second(newId("con"))).resolves.toBeDefined();
  });
});

/**
 * A test says which agents it applies to, over a database that already holds
 * tests (0032).
 *
 * **This is the migration whose generated body would have been wrong**, and the
 * two ways it would have been wrong are what this block is for. `ADD COLUMN …
 * NOT NULL` fails outright on a table that holds rows, and a diff moves no
 * data — so every installed test would have arrived at the new schema with no
 * applicable agent, which is the one state the relation exists to rule out.
 *
 * So the seeding here is deliberately awkward: two projects, one with agents
 * and one without, an agent already archived, and a test somebody had already
 * archived themselves. Every one of those is a row the backfill has to treat
 * differently, and an empty database can prove none of it.
 */
describe("tests gaining applicable agents over installed data (0032)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;

  const organizationId = newId("org");
  /** The project that has agents to be linked to. */
  const staffed = newId("prj");
  /** And the one that has none, whose tests have nowhere to run. */
  const bare = newId("prj");

  const liveAgent = newId("agt");
  const secondAgent = newId("agt");
  /** Archived before the upgrade: it must receive no link at all. */
  const goneAgent = newId("agt");

  const rescheduling = newId("tst");
  const reschedulingVersion = newId("tstv");
  /** Somebody archived this one themselves, before any of this existed. */
  const retired = newId("tst");
  const retiredVersion = newId("tstv");
  /** In the project with no agent, so the upgrade has to archive it. */
  const stranded = newId("tst");
  const strandedVersion = newId("tstv");

  beforeAll(async () => {
    database = await createEmptyDatabase("tests_apply_to_agents");

    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0032-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0032") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    for (const [id, slug] of [
      [staffed, "staffed"],
      [bare, "bare"],
    ] as const) {
      // 0031 has already run, so a project carries a live revision of its own.
      await client.query(
        `insert into project (id, organization_id, name, slug, revision)
         values ($1, $2, $3, $3, $4)`,
        [id, organizationId, slug, newId("rev")],
      );
    }

    // 0029 has already run, so agents carry a revision and an archive marker.
    const agent = async (id: string, name: string, project: string, archived: boolean) =>
      client.query(
        `insert into agent (id, organization_id, project_id, name, revision, archived_at)
         values ($1, $2, $3, $4, $5, ${archived ? "now()" : "null"})`,
        [id, organizationId, project, name, newId("rev")],
      );

    await agent(liveAgent, "Front desk", staffed, false);
    await agent(secondAgent, "Front desk v2", staffed, false);
    await agent(goneAgent, "Retired desk", staffed, true);

    const test = async (
      id: string,
      versionId: string,
      name: string,
      project: string,
      archived: boolean,
    ) => {
      await client.query("begin");
      await client.query(
        `insert into test (id, organization_id, project_id, name, current_version_id, deleted_at)
         values ($1, $2, $3, $4, $5, ${archived ? "now()" : "null"})`,
        [id, organizationId, project, name, versionId],
      );
      await client.query(
        `insert into test_version (id, test_id, version, content)
         values ($1, $2, 1, '{"scenario": "Moves a booking", "expectedBehaviors": ["confirms the new time"]}'::jsonb)`,
        [versionId, id],
      );
      await client.query("commit");
    };

    await test(rescheduling, reschedulingVersion, "Reschedules", staffed, false);
    await test(retired, retiredVersion, "An old idea", staffed, true);
    await test(stranded, strandedVersion, "Nowhere to run", bare, false);
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds tests", async () => {
    const upgrade = (await readMigrations()).find((migration) =>
      migration.name.startsWith("0032_"),
    );
    if (upgrade === undefined) throw new Error("0032 is missing");
    await writeFile(path.join(before, upgrade.name), upgrade.sql);

    const { applied } = await runMigrations(database.url, before);
    expect(applied).toEqual([upgrade.name]);
  });

  it("links every existing test to every active agent in its own project", async () => {
    const { rows } = await client.query<{ agent_id: string }>(
      "select agent_id from test_agent where test_id = $1 order by agent_id",
      [rescheduling],
    );
    // Both active agents and neither of them chosen: before this migration any
    // test of a project could be run against any agent of that project, and
    // picking one would be egma authoring somebody's coverage on no evidence.
    expect(rows.map((row) => row.agent_id).sort()).toEqual(
      [liveAgent, secondAgent].sort(),
    );
  });

  it("links no test to an agent that was already archived", async () => {
    const { rows } = await client.query<{ test_id: string }>(
      "select test_id from test_agent where agent_id = $1",
      [goneAgent],
    );
    // A link a run can never use is a promise egma cannot keep, and writing one
    // would make Archive mean nothing on the day the relation arrived.
    expect(rows).toEqual([]);
  });

  it("links an archived test too, so restoring it finds the coverage it would have had", async () => {
    const { rows } = await client.query<{ agent_id: string }>(
      "select agent_id from test_agent where test_id = $1 order by agent_id",
      [retired],
    );
    expect(rows.map((row) => row.agent_id).sort()).toEqual(
      [liveAgent, secondAgent].sort(),
    );
  });

  it("archives the test whose project has no active agent, and says why", async () => {
    const { rows } = await client.query<{
      archived_at: Date | null;
      archive_reason: string | null;
    }>("select archived_at, archive_reason from test where id = $1", [stranded]);

    expect(rows[0]?.archived_at).toBeInstanceOf(Date);
    // The reason is owed to whoever finds it in the archive: they did not do
    // this, and the fix is to link an agent rather than to wonder who removed
    // it.
    expect(rows[0]?.archive_reason).toBe("needs_agent");
  });

  it("keeps that test's history, which is the whole difference from a delete", async () => {
    const { rows } = await client.query<{ id: string; version: number }>(
      "select id, version from test_version where test_id = $1",
      [stranded],
    );
    expect(rows).toEqual([{ id: strandedVersion, version: 1 }]);
  });

  it("leaves a test somebody archived themselves carrying no reason", async () => {
    const { rows } = await client.query<{
      archived_at: Date | null;
      archive_reason: string | null;
    }>("select archived_at, archive_reason from test where id = $1", [retired]);

    expect(rows[0]?.archived_at).toBeInstanceOf(Date);
    // They know why. A reason invented for them would say the upgrade did this.
    expect(rows[0]?.archive_reason).toBeNull();
  });

  it("leaves the test that had a target active", async () => {
    const { rows } = await client.query<{ archived_at: Date | null }>(
      "select archived_at from test where id = $1",
      [rescheduling],
    );
    expect(rows[0]?.archived_at).toBeNull();
  });

  it("gives every test two revisions, each its own, and never the same one twice", async () => {
    const { rows } = await client.query<{
      revision: string;
      applicability_revision: string;
    }>("select revision, applicability_revision from test");

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.revision).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(row.applicability_revision).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
      // A test whose two tokens matched would accept an edit written against
      // one in place of the other, which is the confusion two tokens exist to
      // prevent.
      expect(row.revision).not.toBe(row.applicability_revision);
    }
    const minted = new Set(
      rows.flatMap((row) => [row.revision, row.applicability_revision]),
    );
    expect(minted.size).toBe(rows.length * 2);
  });

  it("refuses a link between a test and an agent of another project", async () => {
    // The tenancy triangle, one level across: the composite key means a
    // cross-project link cannot be written at all, whatever writes it.
    await expect(
      client.query(
        "insert into test_agent (test_id, agent_id, project_id) values ($1, $2, $3)",
        [stranded, liveAgent, bare],
      ),
    ).rejects.toThrow(/test_agent_agent_project_fk/u);
  });

  it("refuses an archive reason on a test nothing archived", async () => {
    await expect(
      client.query(
        "update test set archive_reason = 'needs_agent' where id = $1",
        [rescheduling],
      ),
    ).rejects.toThrow(/test_archive_reason_needs_an_archive/u);
  });
});

/**
 * Runs written before egma froze a grading plan, and what the upgrade may say
 * about them.
 *
 * **The rule is that nothing is invented, and after the grader redesign that
 * rule swallows the whole file.** This migration used to capture a
 * `migration_snapshot` for every run with work still outstanding, built out of
 * the project's authored graders, their priorities, what each version read and
 * which modalities it scored, the graders a test named directly, and the
 * expected-behaviors built-in as a rowless item with a reserved key. Every one
 * of those retired: `grader.priority` is dropped by `0025`, `test_grader` by
 * `0027`, `reads` and `modalities` never exist, and the built-in is an ordinary
 * running copy. There is nothing left to read and no shape left to write it in
 * — and `0026` deletes every grader row on an upgraded instance in any case, so
 * a snapshot taken here would name graders that are gone.
 *
 * So **every old run says `not_recorded`**, which is exactly what that state is
 * for: this run predates frozen plans, and egma will not reconstruct one from
 * today's graders. What is under test is that the row lands for every run,
 * whatever state it is in, and that an unrecorded plan holds nothing — no
 * groups, no credentials, and no moment, because a plan and the moment it was
 * captured are one fact.
 */
describe("grading plans over installed runs (0033)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");
  const connectionId = newId("con");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const testId = newId("tst");
  const testVersionId = newId("tstv");

  /** Still conducting when the upgrade landed. */
  const movingRun = newId("run");
  const movingSimulation = newId("sim");
  /** Finished long ago, with nothing left to judge. */
  const settledRun = newId("run");
  const settledSimulation = newId("sim");
  /** Conducted before a simulation could pin a test at all. */
  const testlessRun = newId("run");
  const testlessSimulation = newId("sim");

  beforeAll(async () => {
    database = await createEmptyDatabase("grading_plans");

    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0033-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0033") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $2, 'Default', 'default', $3)`,
      [projectId, organizationId, newId("rev")],
    );
    await client.query(
      `insert into agent (id, organization_id, project_id, name, revision)
       values ($1, $2, $3, 'Front desk', $4)`,
      [agentId, organizationId, projectId, newId("rev")],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality, topology, variant_id, config, revision)
       values ($1, $2, $3, $4, 'retell-1', 'retell', 'chat', 'hosted-broker', 'retell', '{"retellAgentId":"agent_abc"}'::jsonb, $5)`,
      [connectionId, organizationId, projectId, agentId, newId("rev")],
    );

    // The project's judge, migrated into its own credential by 0030 — which is
    // what a plan may point at, and the reason this migration comes after it.
    // A retired identifier used only to model the database before 0037. It is
    // deliberately not part of the current public id vocabulary.
    const credentialId = "jcr_01M01JADGE0000000000000000";
    await client.query(
      `insert into judge_credential
         (id, organization_id, label, provider, credentials, credentials_hint, revision)
       values ($1, $2, 'Acme default', 'openai', 'sealed', 'WXYZ', $3)`,
      [credentialId, organizationId, newId("rev")],
    );
    await client.query(
      `insert into judge_configuration
         (project_id, organization_id, provider, model, source, credential_id)
       values ($1, $2, 'openai', 'gpt-4.1-mini', 'credential', $3)`,
      [projectId, organizationId, credentialId],
    );

    await client.query("begin");
    await client.query(
      `insert into persona (id, organization_id, project_id, name, current_version_id, revision)
       values ($1, $2, $3, 'Impatient Rita', $4, $5)`,
      [personaId, organizationId, projectId, personaVersionId, newId("rev")],
    );
    await client.query(
      `insert into persona_version (id, persona_id, version, traits)
       values ($1, $2, 1, '{"personality":"Plain","language":"en-US"}'::jsonb)`,
      [personaVersionId, personaId],
    );
    await client.query("commit");

    await client.query("begin");
    await client.query(
      `insert into test (id, organization_id, project_id, name, current_version_id, revision, applicability_revision)
       values ($1, $2, $3, 'Reschedules', $4, $5, $6)`,
      [testId, organizationId, projectId, testVersionId, newId("rev"), newId("rev")],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $2, 1, '{"scenario":"Moves a booking","expectedBehaviors":["confirms the new time"]}'::jsonb)`,
      [testVersionId, testId],
    );
    await client.query("commit");

    const run = async (
      id: string,
      status: string,
      finished: boolean,
    ): Promise<void> => {
      await client.query(
        `insert into run
           (id, organization_id, project_id, agent_id, connection_id, status, triggered_via,
            pinned_test_versions, requested_personas, connection_snapshot, mock_tool_snapshot,
            expected_simulation_count, completed_count, failed_count, canceled_count,
            started_at, finished_at)
         values ($1, $2, $3, $4, $5, $6, 'manual',
                 '{"testVersionIds":[]}'::jsonb, '{"personaIds":[]}'::jsonb,
                 '{"type":"retell","modality":"chat","topology":"hosted-broker","environment":null,"config":{}}'::jsonb,
                 '{"defaults":[],"overrides":{}}'::jsonb,
                 1, ${finished ? "1" : "null"}, ${finished ? "0" : "null"},
                 ${finished ? "0" : "null"}, now(), ${finished ? "now()" : "null"})`,
        [id, organizationId, projectId, agentId, connectionId, status],
      );
    };

    const simulation = async (
      id: string,
      runId: string,
      status: string,
      pinned: boolean,
    ): Promise<void> => {
      await client.query(
        `insert into simulation
           (id, run_id, organization_id, project_id, agent_id, connection_id,
            persona_id, persona_version_id, test_id, test_version_id,
            position, modality, status, started_at, ended_at, ending_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text, $10::text,
                 1, 'chat', $11,
                 ${status === "queued" ? "null" : "now()"},
                 ${status === "completed" ? "now()" : "null"},
                 ${status === "completed" ? "'persona_concluded'" : "null"})`,
        [
          id,
          runId,
          organizationId,
          projectId,
          agentId,
          connectionId,
          personaId,
          personaVersionId,
          // A conversation written before a simulation could pin a test at all
          // carries neither half of the pin, which is the row the testless
          // group exists for.
          pinned ? testId : null,
          pinned ? testVersionId : null,
          status,
        ],
      );
    };

    await run(movingRun, "running", false);
    await simulation(movingSimulation, movingRun, "queued", true);

    await run(settledRun, "completed", true);
    await simulation(settledSimulation, settledRun, "completed", true);

    await run(testlessRun, "running", false);
    await simulation(testlessSimulation, testlessRun, "queued", false);
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("is what is still pending on a database that already holds runs", async () => {
    const upgrade = (await readMigrations()).find((migration) =>
      migration.name.startsWith("0033_"),
    );
    if (upgrade === undefined) throw new Error("0033 is missing");
    await writeFile(path.join(before, upgrade.name), upgrade.sql);

    const { applied } = await runMigrations(database.url, before);
    expect(applied).toEqual([upgrade.name]);
  });

  it("records no plan for any old run, whatever state it is in", async () => {
    const { rows } = await client.query<{ run_id: string; state: string }>(
      "select run_id, state from grading_plan order by run_id",
    );
    const byRun = new Map(rows.map((row) => [row.run_id, row.state]));

    // A run still conducting, a run finished long ago, and a run conducted
    // before a simulation could pin a test at all. Nothing separates them here:
    // none of the three was judged against a plan anybody wrote down, and
    // reconstructing one would put a sentence on an old run claiming it was
    // judged by things that may not have existed when it ran.
    expect(byRun.get(movingRun)).toBe("not_recorded");
    expect(byRun.get(testlessRun)).toBe("not_recorded");
    expect(byRun.get(settledRun)).toBe("not_recorded");
    // Every run gets a row. A run with no row at all would be a page unable to
    // tell "nobody wrote this down" from "nobody has looked yet".
    expect(rows).toHaveLength(3);
  });

  it("leaves every unrecorded plan holding nothing at all", async () => {
    const { rows } = await client.query<{
      groups: unknown;
      credentials: unknown;
      captured_at: string | null;
    }>(
      `select groups, judge_credential_ids as credentials, captured_at
       from grading_plan order by run_id`,
    );
    for (const row of rows) {
      expect(row.groups).toEqual([]);
      expect(row.credentials).toEqual([]);
      // No plan, and therefore no moment: the two are one fact, and
      // `grading_plan_recorded_plans_carry_their_moment` holds them together.
      expect(row.captured_at).toBeNull();
    }
  });

  /**
   * **Three proofs about a captured snapshot's shape used to stand here.** They
   * held that a pinned simulation got a `version` group carrying the
   * expected-behaviors built-in beside the project's authored graders, that a
   * simulation with no test version got the one `legacy_testless` group, and
   * that a captured plan indexed the judge credentials it needed so an archive
   * could refuse. The migration captures nothing now, so all three describe a
   * row this file can no longer produce. The shapes they proved are proved
   * where plans are still written — at run start, by the run routes' own tests
   * — and a `legacy_testless` group is not written anywhere any more.
   */

  it("gives every finished run a skipped count of zero, because nothing was skipped before it could be", async () => {
    const { rows } = await client.query<{ skipped_count: number | null }>(
      "select skipped_count from run where id = $1",
      [settledRun],
    );
    expect(rows[0]?.skipped_count).toBe(0);
  });
});

describe("persona availability over installed references (0037)", () => {
  type Fixture = {
    readonly organizationId: string;
    readonly firstProjectId: string;
    readonly secondProjectId: string;
    readonly firstPersonaId: string;
    readonly secondPersonaId: string;
    readonly firstTestId: string;
    readonly secondTestId: string;
    readonly firstTestVersionId: string;
  };

  async function beforePersonaLibrary(label: string): Promise<{
    readonly database: EmptyDatabase;
    readonly directory: string;
    readonly client: pg.Client;
    readonly upgrade: { readonly name: string; readonly sql: string };
  }> {
    const database = await createEmptyDatabase(label);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "egma-before-0037-"),
    );
    const migrations = await readMigrations();
    for (const migration of migrations) {
      if (migration.name < "0037") {
        await writeFile(path.join(directory, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, directory);
    const upgrade = migrations.find((migration) =>
      migration.name.startsWith("0037_"),
    );
    if (upgrade === undefined) throw new Error("0037 is missing");
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    return { database, directory, client, upgrade };
  }

  async function installedTestLink(
    client: pg.Client,
    foreignPersona: boolean,
  ): Promise<Fixture> {
    const organizationId = newId("org");
    const firstProjectId = newId("prj");
    const secondProjectId = newId("prj");
    const firstPersonaId = newId("prs");
    const firstPersonaVersionId = newId("prsv");
    const secondPersonaId = newId("prs");
    const secondPersonaVersionId = newId("prsv");
    const firstTestId = newId("tst");
    const firstTestVersionId = newId("tstv");
    const secondTestId = newId("tst");
    const secondTestVersionId = newId("tstv");

    await client.query(
      "insert into organization (id, name, slug) values ($1, 'Acme', $2)",
      [organizationId, `acme-${organizationId}`],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $3, 'First', 'first', $5),
              ($2, $3, 'Second', 'second', $4)`,
      [
        firstProjectId,
        secondProjectId,
        organizationId,
        newId("rev"),
        newId("rev"),
      ],
    );

    await client.query("begin");
    await client.query(
      `insert into persona
         (id, organization_id, project_id, name, current_version_id, revision)
       values ($1, $5, $3, 'First persona', $6, $8),
              ($2, $5, $4, 'Second persona', $7, $9)`,
      [
        firstPersonaId,
        secondPersonaId,
        firstProjectId,
        secondProjectId,
        organizationId,
        firstPersonaVersionId,
        secondPersonaVersionId,
        newId("rev"),
        newId("rev"),
      ],
    );
    await client.query(
      `insert into persona_version (id, persona_id, version, traits)
       values
         ($1, $3, 1, '{"personality":"Plain","language":"en-US","manner":"Warm","patience":"Waits once","accent":"Glaswegian","backgroundNoise":"A busy kitchen","underFriction":"Asks to escalate","voice":{"provider":"elevenlabs","voiceId":"old-voice","speed":1}}'::jsonb),
         ($2, $4, 1, '{"personality":"Plain","language":"en-US","manner":"Warm","patience":"Waits once","accent":"Glaswegian","backgroundNoise":"A busy kitchen","underFriction":"Asks to escalate","voice":{"provider":"elevenlabs","voiceId":"old-voice","speed":1}}'::jsonb)`,
      [
        firstPersonaVersionId,
        secondPersonaVersionId,
        firstPersonaId,
        secondPersonaId,
      ],
    );
    await client.query("commit");

    await client.query("begin");
    await client.query(
      `insert into test
         (id, organization_id, project_id, name, current_version_id,
          revision, applicability_revision)
       values ($1, $5, $3, 'First test', $6, $8, $10),
              ($2, $5, $4, 'Second test', $7, $9, $11)`,
      [
        firstTestId,
        secondTestId,
        firstProjectId,
        secondProjectId,
        organizationId,
        firstTestVersionId,
        secondTestVersionId,
        newId("rev"),
        newId("rev"),
        newId("rev"),
        newId("rev"),
      ],
    );
    await client.query(
      `insert into test_version (id, test_id, version, content)
       values ($1, $3, 1, '{}'::jsonb), ($2, $4, 1, '{}'::jsonb)`,
      [
        firstTestVersionId,
        secondTestVersionId,
        firstTestId,
        secondTestId,
      ],
    );
    await client.query(
      `insert into test_persona (test_version_id, persona_id, position)
       values ($1, $2, 1)`,
      [
        firstTestVersionId,
        foreignPersona ? secondPersonaId : firstPersonaId,
      ],
    );
    await client.query("commit");

    return {
      organizationId,
      firstProjectId,
      secondProjectId,
      firstPersonaId,
      secondPersonaId,
      firstTestId,
      secondTestId,
      firstTestVersionId,
    };
  }

  function postgresCause(error: unknown): {
    readonly code?: unknown;
    readonly constraint?: unknown;
  } {
    let current = error;
    for (let depth = 0; depth < 8; depth += 1) {
      if (typeof current !== "object" || current === null) return {};
      if ("code" in current) {
        return current as { readonly code?: unknown; readonly constraint?: unknown };
      }
      current = "cause" in current ? current.cause : undefined;
    }
    return {};
  }

  it("refuses an installed link to a persona outside the test project", async () => {
    const prepared = await beforePersonaLibrary("persona_link_validation");
    try {
      await installedTestLink(prepared.client, true);
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      let failure: unknown;
      try {
        await runMigrations(prepared.database.url, prepared.directory);
      } catch (error) {
        failure = error;
      }
      expect(postgresCause(failure)).toMatchObject({
        code: "23503",
        constraint: "test_persona_availability",
      });
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("refuses an installed default persona owned by another project", async () => {
    const prepared = await beforePersonaLibrary("persona_default_validation");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      await prepared.client.query(
        "update project set default_persona_id = $1 where id = $2",
        [fixture.secondPersonaId, fixture.firstProjectId],
      );
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      let failure: unknown;
      try {
        await runMigrations(prepared.database.url, prepared.directory);
      } catch (error) {
        failure = error;
      }
      expect(postgresCause(failure)).toMatchObject({
        code: "23503",
        constraint: "project_default_persona_availability",
      });
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("refuses an installed default persona that is already archived", async () => {
    const prepared = await beforePersonaLibrary("persona_default_archived");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      await prepared.client.query(
        "update project set default_persona_id = $1 where id = $2",
        [fixture.firstPersonaId, fixture.firstProjectId],
      );
      await prepared.client.query(
        "update persona set archived_at = now() where id = $1",
        [fixture.firstPersonaId],
      );
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      let failure: unknown;
      try {
        await runMigrations(prepared.database.url, prepared.directory);
      } catch (error) {
        failure = error;
      }
      expect(postgresCause(failure)).toMatchObject({
        code: "23503",
        constraint: "project_default_persona_availability",
      });
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("accepts Custom and Egma-provided default personas", async () => {
    const prepared = await beforePersonaLibrary("persona_default_valid");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      await prepared.client.query(
        "update project set default_persona_id = $1 where id = $2",
        [fixture.firstPersonaId, fixture.firstProjectId],
      );
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      await runMigrations(prepared.database.url, prepared.directory);

      const globalPersonaId = newId("prs");
      const globalVersionId = newId("prsv");
      await prepared.client.query("begin");
      await prepared.client.query(
        `insert into persona
           (id, organization_id, project_id, name, current_version_id, revision)
         values ($1, null, null, 'Egma persona', $2, $3)`,
        [globalPersonaId, globalVersionId, newId("rev")],
      );
      await prepared.client.query(
        `insert into persona_version (id, persona_id, version, traits, models)
         values (
           $1,
           $2,
           1,
           '{"personality":"Plain","language":"en-US"}'::jsonb,
           '{"llm":{"provider":"openai","model":"gpt-4o-mini"},"stt":{"provider":"deepgram","model":"nova-3-general"},"tts":{"provider":"cartesia","model":"sonic-3.5","voiceId":"5ee9feff-1265-424a-9d7f-8e4d431a12c7","speed":1}}'::jsonb
         )`,
        [globalVersionId, globalPersonaId],
      );
      await prepared.client.query("commit");

      await prepared.client.query(
        "update project set default_persona_id = $1 where id = $2",
        [globalPersonaId, fixture.firstProjectId],
      );
      await prepared.client.query(
        "update project set default_persona_id = $1 where id = $2",
        [fixture.firstPersonaId, fixture.firstProjectId],
      );
      const { rows } = await prepared.client.query<{
        default_persona_id: string | null;
      }>("select default_persona_id from project where id = $1", [
        fixture.firstProjectId,
      ]);
      expect(rows[0]?.default_persona_id).toBe(fixture.firstPersonaId);
    } finally {
      await prepared.client.query("rollback").catch(() => undefined);
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("does not let later ownership moves invalidate a valid link", async () => {
    const prepared = await beforePersonaLibrary("persona_link_immutability");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );
      await runMigrations(prepared.database.url, prepared.directory);

      await expect(
        prepared.client.query(
          "update test_version set test_id = $1 where id = $2",
          [fixture.secondTestId, fixture.firstTestVersionId],
        ),
      ).rejects.toThrow(/test version cannot move between tests/);
      await expect(
        prepared.client.query(
          "update test set project_id = $1 where id = $2",
          [fixture.secondProjectId, fixture.firstTestId],
        ),
      ).rejects.toThrow(/test ownership cannot change/);
      await expect(
        prepared.client.query(
          "update test set organization_id = $1 where id = $2",
          [newId("org"), fixture.firstTestId],
        ),
      ).rejects.toThrow(/test ownership cannot change/);
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("moves technical voice into required models and removes old platform owners", async () => {
    const prepared = await beforePersonaLibrary("persona_model_cutover");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      for (const name of [
        "persona_model_provider",
        "speech_to_text_model",
        "text_to_speech_voice",
        "voice_activity_provider",
        "media_backend",
        "carrier_trunk_address",
        "carrier_trunk_number",
      ]) {
        await prepared.client.query(
          `insert into platform_setting (id, name, value, hint)
           values ($1, $2, 'sealed', 'hint')`,
          [newId("pfs"), name],
        );
      }
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      await runMigrations(prepared.database.url, prepared.directory);

      const versions = await prepared.client.query<{
        traits: unknown;
        models: unknown;
      }>(
        `select traits, models from persona_version
          where persona_id in ($1, $2)
          order by persona_id`,
        [fixture.firstPersonaId, fixture.secondPersonaId],
      );
      expect(versions.rows).toHaveLength(2);
      for (const row of versions.rows) {
        expect(row.traits).toEqual({
          personality: "Plain",
          language: "en-US",
          manner: "Warm",
          patience: "Waits once",
          accent: "Glaswegian",
          backgroundNoise: "A busy kitchen",
          underFriction: "Asks to escalate",
        });
        expect(row.models).toEqual({
          llm: { provider: "openai", model: "gpt-4o-mini" },
          stt: { provider: "openai", model: "gpt-live-transcribe" },
          tts: {
            provider: "cartesia",
            model: "sonic-3.5",
            voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
            speed: 1,
          },
        });
      }

      const remaining = await prepared.client.query<{ name: string }>(
        "select name from platform_setting order by name",
      );
      expect(remaining.rows).toEqual([
        { name: "carrier_trunk_address" },
        { name: "carrier_trunk_number" },
      ]);

      await expect(
        prepared.client.query(
          `insert into platform_setting (id, name, value, hint)
           values ($1, 'speech_to_text_model', 'sealed', 'hint')`,
          [newId("pfs")],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "platform_setting_name_allowed",
      });

      const validModels = RECOMMENDED_PERSONA_MODELS;

      for (const [offset, entry] of PROVIDER_CATALOG.entries()) {
        const models =
          entry.job === "llm"
            ? {
                ...validModels,
                llm: { provider: entry.provider, model: entry.model },
              }
            : entry.job === "stt"
              ? {
                  ...validModels,
                  stt: { provider: entry.provider, model: entry.model },
                }
              : {
                  ...validModels,
                  tts: {
                    ...validModels.tts,
                    provider: entry.provider,
                    model: entry.model,
                    voiceId: entry.recommendedVoiceId,
                  },
                };
        await prepared.client.query(
          `insert into persona_version (id, persona_id, version, traits, models)
           values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            newId("prsv"),
            fixture.firstPersonaId,
            10 + offset,
            JSON.stringify({ personality: "Plain", language: "en-US" }),
            JSON.stringify(models),
          ],
        );
      }

      await expect(
        prepared.client.query(
          `insert into persona_version (id, persona_id, version, traits, models)
           values ($1, $2, 2, $3::jsonb, $4::jsonb)`,
          [
            newId("prsv"),
            fixture.firstPersonaId,
            JSON.stringify({ personality: "Plain", language: "en-US" }),
            JSON.stringify({
              ...validModels,
              stt: { provider: "openai", model: "nova-3-general" },
            }),
          ],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "persona_version_models_valid",
      });
      await expect(
        prepared.client.query(
          `insert into persona_version (id, persona_id, version, traits, models)
           values ($1, $2, 2, $3::jsonb, $4::jsonb)`,
          [
            newId("prsv"),
            fixture.firstPersonaId,
            JSON.stringify({
              personality: "Plain",
              language: "en-US",
              voice: { provider: "cartesia", voiceId: "second-owner", speed: 1 },
            }),
            JSON.stringify(validModels),
          ],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "persona_version_traits_valid",
      });

      for (const [offset, speed] of [
        SPEED_RANGE.slowest,
        SPEED_RANGE.fastest,
      ].entries()) {
        await prepared.client.query(
          `insert into persona_version (id, persona_id, version, traits, models)
           values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            newId("prsv"),
            fixture.firstPersonaId,
            2 + offset,
            JSON.stringify({ personality: "Plain", language: "en-US" }),
            JSON.stringify({
              ...validModels,
              tts: { ...validModels.tts, speed },
            }),
          ],
        );
      }

      const justOutside = 0.0001;
      for (const [offset, speed] of [
        SPEED_RANGE.slowest - justOutside,
        SPEED_RANGE.fastest + justOutside,
      ].entries()) {
        await expect(
          prepared.client.query(
            `insert into persona_version (id, persona_id, version, traits, models)
             values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
            [
              newId("prsv"),
              fixture.firstPersonaId,
              4 + offset,
              JSON.stringify({ personality: "Plain", language: "en-US" }),
              JSON.stringify({
                ...validModels,
                tts: { ...validModels.tts, speed },
              }),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "persona_version_models_valid",
        });
      }

      await expect(
        prepared.client.query(
          `update persona_version
              set models = jsonb_set(
                models,
                '{stt}',
                '{"provider":"deepgram","model":"nova-3-general"}'::jsonb
              )
            where persona_id = $1`,
          [fixture.firstPersonaId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "persona_version_semantics_immutable",
      });

      const authorId = newId("usr");
      await prepared.client.query(
        `insert into "user" (id, email) values ($1, $2)`,
        [authorId, `${authorId}@example.com`],
      );
      await prepared.client.query(
        "update persona_version set created_by = $1 where persona_id = $2 and version = 1",
        [authorId, fixture.firstPersonaId],
      );
      await prepared.client.query(`delete from "user" where id = $1`, [authorId]);
      const authors = await prepared.client.query<{ created_by: string | null }>(
        "select created_by from persona_version where persona_id = $1 and version = 1",
        [fixture.firstPersonaId],
      );
      expect(authors.rows).toEqual([{ created_by: null }]);
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it.each([
    {
      label: "routing half",
      names: ["carrier_trunk_address"],
    },
    {
      label: "SIP credential half",
      names: [
        "carrier_trunk_address",
        "carrier_trunk_number",
        "carrier_trunk_username",
      ],
    },
  ])("refuses an installed carrier $label", async ({ label, names }) => {
    const prepared = await beforePersonaLibrary(
      `carrier_${label.replaceAll(" ", "_")}`,
    );
    try {
      for (const name of names) {
        await prepared.client.query(
          `insert into platform_setting (id, name, value, hint)
           values ($1, $2, 'sealed', 'hint')`,
          [newId("pfs"), name],
        );
      }
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      let failure: unknown;
      try {
        await runMigrations(prepared.database.url, prepared.directory);
      } catch (error) {
        failure = error;
      }
      expect(postgresCause(failure)).toMatchObject({
        code: "23514",
        constraint: "platform_setting_carrier_complete",
      });
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("installs the Egma-provided default and makes every project pointer required", async () => {
    const prepared = await beforePersonaLibrary("persona_required_default");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );

      await runMigrations(prepared.database.url, prepared.directory);

      const defaultPersonaId = "prs_01M0E4EVJ6ECGVJEA4NSBTC0CC";
      const projects = await prepared.client.query<{
        default_persona_id: string;
      }>(
        `select default_persona_id from project
          where id in ($1, $2)
          order by id`,
        [fixture.firstProjectId, fixture.secondProjectId],
      );
      expect(projects.rows).toEqual([
        { default_persona_id: defaultPersonaId },
        { default_persona_id: defaultPersonaId },
      ]);

      const installed = await prepared.client.query<{
        traits: unknown;
      }>(
        `select pv.traits
           from persona p
           join persona_version pv on pv.id = p.current_version_id
          where p.id = $1
            and p.organization_id is null
            and p.project_id is null`,
        [defaultPersonaId],
      );
      expect(installed.rows[0]?.traits).toEqual({
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        manner: "Clear, natural, and conversational.",
        patience: "Starts patient and gives the agent time to explain.",
        accent: "Neutral American English.",
        backgroundNoise: "None.",
        underFriction:
          "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
      });

      const column = await prepared.client.query<{
        is_nullable: string;
        column_default: string | null;
      }>(
        `select is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'project'
            and column_name = 'default_persona_id'`,
      );
      expect(column.rows[0]).toMatchObject({
        is_nullable: "NO",
      });
      expect(column.rows[0]?.column_default).toContain(defaultPersonaId);

      await expect(
        prepared.client.query("delete from persona where id = $1", [
          defaultPersonaId,
        ]),
      ).rejects.toSatisfy(
        (error) => errorCodeOf(error) === POSTGRES_ERROR.restrictViolation,
      );
    } finally {
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });

  it("moves grader execution to pinned version models and removes project judge storage", async () => {
    const prepared = await beforePersonaLibrary("grader_model_cutover");
    try {
      const fixture = await installedTestLink(prepared.client, false);
      const modelLibraryId = newId("grl");
      const codeLibraryId = newId("grl");
      const modelGraderId = newId("grd");
      const codeGraderId = newId("grd");
      const modelVersionId = newId("grv");
      const codeVersionId = newId("grv");
      const planId = newId("gpl");

      await prepared.client.query("begin");
      await prepared.client.query(
        `insert into grader_library
           (id, name, type, prompt, params, output_definition)
         values
           ($1, 'Migration model judge', 'llm_as_judge', 'Judge it', '{}'::jsonb, '{}'::jsonb),
           ($2, 'Migration code judge', 'code', null, '{}'::jsonb, null)`,
        [modelLibraryId, codeLibraryId],
      );
      await prepared.client.query(
        `insert into grader
           (id, organization_id, project_id, library_id, name, type, current_version_id)
         values
           ($1, $5, $6, $3, 'Model judge', 'llm_as_judge', $7),
           ($2, $5, $6, $4, 'Code judge', 'code', $8)`,
        [
          modelGraderId,
          codeGraderId,
          modelLibraryId,
          codeLibraryId,
          fixture.organizationId,
          fixture.firstProjectId,
          modelVersionId,
          codeVersionId,
        ],
      );
      // Both shapes were legal before 0037: model-judged versions could hold
      // no choice, and code versions could hold a model they would never use.
      await prepared.client.query(
        `insert into grader_version
           (id, grader_id, version, config, judge_model)
         values
           ($1, $3, 1, '{"assertions":[]}'::jsonb, null),
           ($2, $4, 1, '{"assertions":[]}'::jsonb,
             '{"provider":"openai","model":"legacy-model"}'::jsonb)`,
        [modelVersionId, codeVersionId, modelGraderId, codeGraderId],
      );
      await prepared.client.query("commit");

      const installedGroups = [
        {
          tag: "version",
          items: [
            {
              graderId: modelGraderId,
              graderVersionId: modelVersionId,
              judge: {
                tag: "configured",
                source: "credential",
                provider: "openai",
                model: "legacy-model",
              },
            },
            {
              graderId: codeGraderId,
              graderVersionId: codeVersionId,
              judge: { tag: "unavailable", reason: "judge_not_configured" },
            },
          ],
        },
      ];
      // The plan's JSON has no database foreign key to a version, but its run
      // id does. An orphan run is enough for this migration-only fixture and
      // avoids recreating the whole run graph that this test does not inspect.
      await prepared.client.query("set session_replication_role = replica");
      try {
        await prepared.client.query(
          `insert into grading_plan
             (id, run_id, organization_id, project_id, state, captured_at,
              groups, judge_credential_ids)
           values ($1, $2, $3, $4, 'run_start', now(), $5::jsonb, '[]'::jsonb)`,
          [
            planId,
            newId("run"),
            fixture.organizationId,
            fixture.firstProjectId,
            JSON.stringify(installedGroups),
          ],
        );
      } finally {
        await prepared.client.query("set session_replication_role = origin");
      }

      await writeFile(
        path.join(prepared.directory, prepared.upgrade.name),
        prepared.upgrade.sql,
      );
      await runMigrations(prepared.database.url, prepared.directory);

      const versions = await prepared.client.query<{
        id: string;
        judge_model: unknown;
        library_id: string;
        library_version: number;
      }>(
        `select id, judge_model, library_id, library_version from grader_version
          where id in ($1, $2) order by id`,
        [modelVersionId, codeVersionId],
      );
      expect(
        Object.fromEntries(
          versions.rows.map((row) => [row.id, row.judge_model]),
        ),
      ).toEqual({
        [modelVersionId]: { provider: "openai", model: "gpt-4o-mini" },
        [codeVersionId]: null,
      });
      expect(
        Object.fromEntries(
          versions.rows.map((row) => [
            row.id,
            [row.library_id, row.library_version],
          ]),
        ),
      ).toEqual({
        [modelVersionId]: [modelLibraryId, 1],
        [codeVersionId]: [codeLibraryId, 1],
      });

      const definitions = await prepared.client.query<{
        library_id: string;
        prompt: string | null;
      }>(
        `select library_id, prompt from grader_library_version
          where library_id in ($1, $2) order by library_id`,
        [modelLibraryId, codeLibraryId],
      );
      expect(Object.fromEntries(
        definitions.rows.map((row) => [row.library_id, row.prompt]),
      )).toEqual({
        [modelLibraryId]: "Judge it",
        [codeLibraryId]: null,
      });

      // The database accepts every LLM pair from the executable catalog. If a
      // catalog entry is added without changing the migration constraint, this
      // upgrade proof fails instead of allowing authoring and storage to drift.
      for (const [offset, entry] of PROVIDERS_BY_JOB.llm.entries()) {
        await prepared.client.query(
          `insert into grader_version
             (id, grader_id, version, library_id, library_version, config, judge_model)
           values ($1, $2, $3, $4, 1, '{}'::jsonb, $5::jsonb)`,
          [
            newId("grv"),
            modelGraderId,
            10 + offset,
            modelLibraryId,
            JSON.stringify({ provider: entry.provider, model: entry.model }),
          ],
        );
      }
      await expect(
        prepared.client.query(
          `insert into grader_version
             (id, grader_id, version, library_id, library_version, config, judge_model)
           values ($1, $2, 99, $3, 1, '{}'::jsonb,
             '{"provider":"openai","model":"not-cataloged"}'::jsonb)`,
          [newId("grv"), modelGraderId, modelLibraryId],
        ),
      ).rejects.toThrow(/grader_version_judge_model_allowed/u);

      const plan = await prepared.client.query<{ groups: unknown }>(
        "select groups from grading_plan where id = $1",
        [planId],
      );
      const groups = plan.rows[0]?.groups as Array<{
        items: Array<Record<string, unknown>>;
      }>;
      expect(groups[0]?.items.every((item) => !("judge" in item))).toBe(true);
      expect(JSON.stringify(groups)).not.toMatch(
        /credential|source|unavailable|legacy-model/u,
      );

      const removedTables = await prepared.client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('judge_configuration', 'judge_credential')`,
      );
      expect(removedTables.rows).toEqual([]);
      const planColumns = await prepared.client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'grading_plan'
            and column_name = 'judge_credential_ids'`,
      );
      expect(planColumns.rows).toEqual([]);

      await expect(
        prepared.client.query(
          "update grader_version set judge_model = null where id = $1",
          [modelVersionId],
        ),
      ).rejects.toThrow(/needs one model/u);
      await expect(
        prepared.client.query(
          `update grader_version
              set judge_model = '{"provider":"openai","model":"not-cataloged"}'::jsonb
            where id = $1`,
          [modelVersionId],
        ),
      ).rejects.toThrow(/judgment cannot change/u);
      await expect(
        prepared.client.query(
          "update grader_library_version set prompt = 'changed in place' where library_id = $1 and version = 1",
          [modelLibraryId],
        ),
      ).rejects.toThrow(/definition version cannot change/u);
      await expect(
        prepared.client.query(
          `update grader_version
              set config = '{"assertions":[{"changed":1}]}'::jsonb
            where id = $1`,
          [modelVersionId],
        ),
      ).rejects.toThrow(/judgment cannot change/u);
      await expect(
        prepared.client.query(
          "update grader_library set type = 'code' where id = $1",
          [modelLibraryId],
        ),
      ).rejects.toThrow(/type cannot change/u);
    } finally {
      await prepared.client.query("rollback").catch(() => undefined);
      await prepared.client.end();
      await rm(prepared.directory, { recursive: true, force: true });
      await prepared.database.drop();
    }
  });
});

describe("the direct Monitoring cutover (0038)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;
  let applied: readonly string[];
  let frozenFinishedAt: Date;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const agentId = newId("agt");

  const reaches = [
    {
      name: "Retell chat",
      connectionId: newId("con"),
      runId: newId("run"),
      type: "retell",
      modality: "chat",
      topology: "hosted-broker",
      variantId: "retell.api_key",
      config: { retellAgentId: "agent_retell_chat" },
      expected: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
      },
    },
    {
      name: "Generic phone",
      connectionId: newId("con"),
      runId: newId("run"),
      type: "phone",
      modality: "voice",
      topology: "egma-dials-in",
      variantId: "phone.number",
      config: { phoneNumber: "+15551234567" },
      expected: {
        agentPlatform: null,
        connectionKind: "phone_number",
        accessVariant: "phone_number.public_e164",
      },
    },
    {
      name: "LiveKit project credentials",
      connectionId: newId("con"),
      runId: newId("run"),
      type: "livekit",
      modality: "voice",
      topology: "agent-dials-out",
      variantId: "livekit.key_pair",
      config: {
        url: "wss://project.example.test",
        metadata: '{"run":"old"}',
      },
      expected: {
        agentPlatform: "livekit_agents",
        connectionKind: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
      },
    },
    {
      name: "LiveKit token endpoint",
      connectionId: newId("con"),
      runId: newId("run"),
      type: "livekit",
      modality: "voice",
      topology: "agent-dials-out",
      variantId: "livekit.token_endpoint",
      config: {
        url: "wss://endpoint.example.test",
        tokenEndpoint: "https://auth.example.test/livekit-token",
      },
      expected: {
        agentPlatform: "livekit_agents",
        connectionKind: "livekit_room",
        accessVariant: "livekit_room.customer_token_endpoint",
      },
    },
  ] as const;

  const removedRetellVoice = {
    connectionId: newId("con"),
    runId: newId("run"),
  };

  /**
   * A run that has already reported its numbers.
   *
   * `guard_run_lifecycle` refuses every update to a run whose `finished_at` is
   * set, so 0038's snapshot backfill only meets that refusal where a database
   * holds history. Every other run in this file is `pending` and every database
   * this migration met before production was empty — which is how the backfill
   * reached production, raised the guard, and rolled the deploy back without one
   * test noticing. This row is that history, and the reason 0038 lifts the guard
   * around its own statement and puts it straight back.
   *
   * It rides the LiveKit token-endpoint connection, so the branch reading
   * `tokenEndpoint` out of the frozen config is exercised on a frozen row too.
   */
  const finishedRun = {
    id: newId("run"),
    reach: reaches[3],
    counts: { completed: 3, failed: 1, canceled: 0, skipped: 0 },
  } as const;

  const oldProductionJob = {
    id: newId("gjb"),
    traceId: "a".repeat(32),
  };
  const oldProductionClaim = {
    // Literal rather than minted: the prefix belonged to a table this history
    // still holds and the release under test removes.
    id: `ptc_${"A".repeat(26)}`,
    traceId: "b".repeat(32),
    callId: "call_before_monitoring_cutover",
  };

  async function connectionAndRun(input: {
    readonly name: string;
    readonly connectionId: string;
    readonly runId: string;
    readonly type: string;
    readonly modality: string;
    readonly topology: string;
    readonly variantId: string;
    readonly config: Readonly<Record<string, string>>;
  }): Promise<void> {
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, type, modality,
          topology, variant_id, config, revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        input.connectionId,
        organizationId,
        projectId,
        agentId,
        input.name,
        input.type,
        input.modality,
        input.topology,
        input.variantId,
        JSON.stringify(input.config),
        newId("rev"),
      ],
    );
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, pinned_test_versions, requested_personas,
          connection_snapshot, mock_tool_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb, $7::jsonb,
          $8::jsonb, $9::jsonb, 1)`,
      [
        input.runId,
        organizationId,
        projectId,
        agentId,
        input.connectionId,
        JSON.stringify({ testVersionIds: [] }),
        JSON.stringify({ personaIds: [] }),
        JSON.stringify({
          type: input.type,
          modality: input.modality,
          topology: input.topology,
          environment: null,
          config: input.config,
        }),
        JSON.stringify({ defaults: [], overrides: {} }),
      ],
    );
  }

  beforeAll(async () => {
    database = await createEmptyDatabase("direct_monitoring_cutover");
    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0038-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0038") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug) values ($1, 'Cutover', 'cutover')`,
      [organizationId],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $2, 'Cutover', 'cutover', $3)`,
      [projectId, organizationId, newId("rev")],
    );
    await client.query(
      `insert into agent (id, organization_id, project_id, name, revision)
       values ($1, $2, $3, 'Cutover agent', $4)`,
      [agentId, organizationId, projectId, newId("rev")],
    );
    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, trace_id, first_span_at,
          last_span_at, last_seen_at, root_closed_at, status)
       values ($1, $2, $3, 'production', $4, now(), now(), now(), now(), 'pending')`,
      [
        oldProductionJob.id,
        organizationId,
        projectId,
        oldProductionJob.traceId,
      ],
    );

    for (const reach of reaches) await connectionAndRun(reach);
    await connectionAndRun({
      name: "Unrepresentable Retell voice",
      connectionId: removedRetellVoice.connectionId,
      runId: removedRetellVoice.runId,
      type: "retell",
      modality: "voice",
      topology: "hosted-broker",
      variantId: "retell.api_key",
      config: { retellAgentId: "agent_retell_voice" },
    });

    // Frozen before 0038 runs: the four counts land with `finished_at`, as
    // `run_counts_written_together` requires, and the snapshot is still written
    // in the old vocabulary.
    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, pinned_test_versions, requested_personas,
          connection_snapshot, mock_tool_snapshot, expected_simulation_count,
          started_at, finished_at,
          completed_count, failed_count, canceled_count, skipped_count)
       values ($1, $2, $3, $4, $5, 'completed', 'manual', $6::jsonb, $7::jsonb,
          $8::jsonb, $9::jsonb, 4,
          now() - interval '1 hour', now() - interval '30 minutes',
          $10, $11, $12, $13)`,
      [
        finishedRun.id,
        organizationId,
        projectId,
        agentId,
        finishedRun.reach.connectionId,
        JSON.stringify({ testVersionIds: [] }),
        JSON.stringify({ personaIds: [] }),
        JSON.stringify({
          type: finishedRun.reach.type,
          modality: finishedRun.reach.modality,
          topology: finishedRun.reach.topology,
          environment: null,
          config: finishedRun.reach.config,
        }),
        JSON.stringify({ defaults: [], overrides: {} }),
        finishedRun.counts.completed,
        finishedRun.counts.failed,
        finishedRun.counts.canceled,
        finishedRun.counts.skipped,
      ],
    );
    // Read back rather than computed here, so the assertion after the migration
    // compares against the exact instant the row was frozen at.
    const { rows: frozen } = await client.query<{ finished_at: Date }>(
      "select finished_at from run where id = $1",
      [finishedRun.id],
    );
    frozenFinishedAt = frozen[0]!.finished_at;

    await client.query(
      `insert into production_trace_claim
         (id, organization_id, project_id, connection_id, trace_id,
          provider_call_id, transport, payload, ended_at, status, claimed_at)
       values ($1, $2, $3, $4, $5, $6, 'pull', '{}', now(), 'claimed', now())`,
      [
        oldProductionClaim.id,
        organizationId,
        projectId,
        reaches[0].connectionId,
        oldProductionClaim.traceId,
        oldProductionClaim.callId,
      ],
    );
    await client.query(
      `insert into retell_webhook_refusal (id, reason)
       values ($1, 'bad_signature')`,
      [`rwr_${"A".repeat(26)}`],
    );

    await addHistoricalMigration(before, "0038_parched_goblin_queen.sql");
    ({ applied } = await runMigrations(database.url, before));
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("starts with the Monitoring cutover on a populated 0037 database", () => {
    expect(applied).toEqual([
      "0038_parched_goblin_queen.sql",
      "0039_lean_quentin_quire.sql",
    ]);
  });

  it("converts every supported connection and its frozen run snapshot", async () => {
    const { rows: connections } = await client.query<{
      id: string;
      agent_platform: string | null;
      connection_kind: string;
      access_variant: string;
    }>(
      `select id, agent_platform, connection_kind, access_variant
         from connection order by id`,
    );
    const connectionById = new Map(connections.map((row) => [row.id, row]));

    const { rows: runs } = await client.query<{
      id: string;
      connection_snapshot: Record<string, unknown>;
    }>("select id, connection_snapshot from run order by id");
    const runById = new Map(
      runs.map((row) => [row.id, row.connection_snapshot]),
    );

    for (const reach of reaches) {
      expect(connectionById.get(reach.connectionId)).toEqual({
        id: reach.connectionId,
        agent_platform: reach.expected.agentPlatform,
        connection_kind: reach.expected.connectionKind,
        access_variant: reach.expected.accessVariant,
      });
      expect(runById.get(reach.runId)).toEqual({
        agentPlatform: reach.expected.agentPlatform,
        connectionKind: reach.expected.connectionKind,
        accessVariant: reach.expected.accessVariant,
        modality: reach.modality,
        topology: reach.topology,
        environment: null,
        config: reach.config,
      });
    }
  });

  it("reaches the frozen snapshot of a run that had already finished", async () => {
    const { rows } = await client.query<{
      connection_snapshot: Record<string, unknown>;
    }>("select connection_snapshot from run where id = $1", [finishedRun.id]);

    expect(rows[0]?.connection_snapshot).toEqual({
      agentPlatform: finishedRun.reach.expected.agentPlatform,
      connectionKind: finishedRun.reach.expected.connectionKind,
      accessVariant: finishedRun.reach.expected.accessVariant,
      modality: finishedRun.reach.modality,
      topology: finishedRun.reach.topology,
      environment: null,
      config: finishedRun.reach.config,
    });
  });

  it("changes a finished run's vocabulary and none of the answers it reported", async () => {
    const { rows } = await client.query<{
      status: string;
      finished_at: Date;
      completed_count: number;
      failed_count: number;
      canceled_count: number;
      skipped_count: number;
    }>(
      `select status, finished_at, completed_count, failed_count,
              canceled_count, skipped_count
         from run where id = $1`,
      [finishedRun.id],
    );

    expect(rows[0]).toEqual({
      status: "completed",
      finished_at: frozenFinishedAt,
      completed_count: finishedRun.counts.completed,
      failed_count: finishedRun.counts.failed,
      canceled_count: finishedRun.counts.canceled,
      skipped_count: finishedRun.counts.skipped,
    });
  });

  /**
   * The guard is lifted for one statement, never taught an exception. Proving
   * the lift ended is what stops a later edit leaving it off: without this, a
   * migration that dropped the `ENABLE TRIGGER` line would still pass every
   * other assertion here while quietly unguarding the table for good.
   */
  it("puts the lifecycle guard back, so a finished header is still written once", async () => {
    await expect(
      client.query(`update "run" set "status" = 'canceled' where "id" = $1`, [
        finishedRun.id,
      ]),
    ).rejects.toThrow(
      /is finished, and a finished run's header is written once/,
    );

    const { rows } = await client.query<{ tgenabled: string }>(
      "select tgenabled from pg_trigger where tgname = 'run_lifecycle_guard'",
    );
    expect(rows).toEqual([{ tgenabled: "O" }]);
  });

  it("deletes the old unrepresentable Retell voice connection and its run", async () => {
    const { rows } = await client.query<{
      connection: string | null;
      run: string | null;
    }>(
      `select
         (select id from connection where id = $1) as connection,
         (select id from run where id = $2) as run`,
      [removedRetellVoice.connectionId, removedRetellVoice.runId],
    );
    expect(rows).toEqual([{ connection: null, run: null }]);
  });

  it("removes old production jobs and claims so their identities can be used again", async () => {
    const { rows: jobs } = await client.query<{ id: string }>(
      "select id from grading_job where id = $1",
      [oldProductionJob.id],
    );
    const { rows: claims } = await client.query<{ id: string }>(
      "select id from production_trace_claim where provider_call_id = $1",
      [oldProductionClaim.callId],
    );
    expect(jobs).toEqual([]);
    expect(claims).toEqual([]);

    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, trace_id, first_span_at,
          last_span_at, last_seen_at, root_closed_at, status)
       values ($1, $2, $3, 'production', $4, now(), now(), now(), now(), 'pending')`,
      [newId("gjb"), organizationId, projectId, oldProductionJob.traceId],
    );
    await client.query(
       `insert into production_trace_claim
         (id, organization_id, project_id, trace_id, provider_call_id,
          platform_agent_id, payload, ended_at, status, claimed_at)
       values ($1, $2, $3, $4, $5, 'agent_retell_chat', '{}', now(), 'claimed', now())`,
      [
        `ptc_${"B".repeat(26)}`,
        organizationId,
        projectId,
        oldProductionClaim.traceId,
        oldProductionClaim.callId,
      ],
    );
  });

  it("removes webhook state and creates only the new Monitoring schema", async () => {
    const { rows: tables } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'retell_webhook_refusal',
            'monitoring_setup',
            'retell_monitored_agent',
            'production_trace_claim',
            'retell_ingestion_failure'
          ) order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "monitoring_setup",
      "production_trace_claim",
      "retell_ingestion_failure",
      "retell_monitored_agent",
    ]);

    const { rows: leaseColumns } = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public'
          and table_name = 'retell_ingestion_failure'
          and column_name in ('replay_lease_owner', 'replay_lease_expires_at')
        order by column_name`,
    );
    expect(leaseColumns).toEqual([
      { column_name: "replay_lease_expires_at", is_nullable: "YES" },
      { column_name: "replay_lease_owner", is_nullable: "YES" },
    ]);

    const { rows: legacyColumns } = await client.query<{
      column_name: string;
    }>(
      `select column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = 'connection'
          and column_name in (
            'type', 'variant_id', 'watch_production', 'production_cursor',
            'webhook_registered_at', 'webhook_delivered_at'
          )`,
    );
    expect(legacyColumns).toEqual([]);
  });
});

describe("the clean test-suite cutover (0040)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;
  let applied: readonly string[];
  let cutoverStartedAt: number;
  let cutoverFinishedAt: number;

  const organizationId = newId("org");
  const projectWithTests = newId("prj");
  const emptyProject = newId("prj");
  const userId = newId("usr");
  const agentId = newId("agt");
  const connectionId = newId("con");
  const personaId = newId("prs");
  const personaVersionId = newId("prsv");
  const activeTestId = newId("tst");
  const activeVersionId = newId("tstv");
  const hiddenTestId = newId("tst");
  const hiddenVersionId = newId("tstv");
  const oldRunId = newId("run");
  const oldSimulationId = newId("sim");
  const simulationJobId = newId("gjb");
  const productionJobId = newId("gjb");

  beforeAll(async () => {
    database = await createEmptyDatabase("test_suite_cutover");
    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0040-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0040") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug) values ($1, 'Cutover', 'suite-cutover')`,
      [organizationId],
    );
    await client.query(
      `insert into "user" (id, email, email_verified)
       values ($1, 'suite-cutover@example.test', true)`,
      [userId],
    );
    for (const [id, slug] of [
      [projectWithTests, "with-tests"],
      [emptyProject, "empty"],
    ] as const) {
      await client.query(
        `insert into project (id, organization_id, name, slug, revision)
         values ($1, $2, $3, $3, $4)`,
        [id, organizationId, slug, newId("rev")],
      );
    }
    await client.query(
      `insert into agent (id, organization_id, project_id, name, revision)
       values ($1, $2, $3, 'Front desk', $4)`,
      [agentId, organizationId, projectWithTests, newId("rev")],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, agent_platform,
          connection_kind, modality, topology, access_variant, config,
          capability_state, capabilities_measured, capabilities_supported,
          capabilities_checked_at, capability_source, revision)
       values ($1, $2, $3, $4, 'Chat', 'retell', 'retell_chat_api', 'chat',
          'hosted-broker', 'retell_chat_api.api_key',
          '{"retellAgentId":"agent_cutover"}'::jsonb, 'known',
          '["raw_audio"]'::jsonb, '["raw_audio"]'::jsonb, now(),
          'retell_chat_api', $5)`,
      [
        connectionId,
        organizationId,
        projectWithTests,
        agentId,
        newId("rev"),
      ],
    );

    await client.query("begin");
    await client.query(
      `insert into persona
         (id, organization_id, project_id, name, current_version_id, revision)
       values ($1, $2, $3, 'Caller', $4, $5)`,
      [
        personaId,
        organizationId,
        projectWithTests,
        personaVersionId,
        newId("rev"),
      ],
    );
    await client.query(
      `insert into persona_version (id, persona_id, version, traits, models)
       values ($1, $2, 1, $3::jsonb, $4::jsonb)`,
      [
        personaVersionId,
        personaId,
        JSON.stringify({ personality: "calm", language: "English" }),
        JSON.stringify(RECOMMENDED_PERSONA_MODELS),
      ],
    );
    await client.query("commit");

    const insertTest = async (
      id: string,
      versionId: string,
      name: string,
      hidden: boolean,
    ) => {
      await client.query("begin");
      await client.query(
        `insert into test
           (id, organization_id, project_id, name, current_version_id,
            revision, applicability_revision, archived_at)
         values ($1, $2, $3, $4, $5, $6, $7,
            ${hidden ? "now()" : "null"})`,
        [
          id,
          organizationId,
          projectWithTests,
          name,
          versionId,
          newId("rev"),
          newId("rev"),
        ],
      );
      await client.query(
        `insert into test_version (id, test_id, version, content)
         values ($1, $2, 1, $3::jsonb)`,
        [
          versionId,
          id,
          JSON.stringify({
            scenario: "A booking must move",
            expectedBehaviors: ["confirms the new time"],
            requiredCapabilities: ["raw_audio"],
          }),
        ],
      );
      await client.query("commit");
      await client.query(
        `insert into test_agent (test_id, agent_id, project_id)
         values ($1, $2, $3)`,
        [id, agentId, projectWithTests],
      );
    };
    await insertTest(activeTestId, activeVersionId, "Active", false);
    await insertTest(hiddenTestId, hiddenVersionId, "Hidden", true);

    await client.query(
      `insert into run
         (id, organization_id, project_id, agent_id, connection_id, status,
          triggered_via, pinned_test_versions, requested_personas,
          connection_snapshot, mock_tool_snapshot, expected_simulation_count)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', $6::jsonb,
          $7::jsonb, $8::jsonb, $9::jsonb, 1)`,
      [
        oldRunId,
        organizationId,
        projectWithTests,
        agentId,
        connectionId,
        JSON.stringify({ testVersionIds: [activeVersionId] }),
        JSON.stringify({ personaIds: [personaId] }),
        JSON.stringify({
          agentPlatform: "retell",
          connectionKind: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          topology: "hosted-broker",
          environment: null,
          config: { retellAgentId: "agent_cutover" },
        }),
        JSON.stringify({ defaults: [], overrides: {} }),
      ],
    );
    await client.query(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, test_id, test_version_id, position,
          modality, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'chat', 'queued')`,
      [
        oldSimulationId,
        oldRunId,
        organizationId,
        projectWithTests,
        agentId,
        connectionId,
        personaId,
        personaVersionId,
        activeTestId,
        activeVersionId,
      ],
    );
    await client.query(
      `insert into grading_plan
         (id, run_id, organization_id, project_id, state, captured_at, groups)
       values ($1, $2, $3, $4, 'run_start', now(), '[]'::jsonb)`,
      [newId("gpl"), oldRunId, organizationId, projectWithTests],
    );
    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, simulation_id, status)
       values ($1, $2, $3, 'simulation', $4, 'pending')`,
      [simulationJobId, organizationId, projectWithTests, oldSimulationId],
    );
    await client.query(
      `insert into grading_job
         (id, organization_id, project_id, source, trace_id, first_span_at,
          last_span_at, last_seen_at, root_closed_at, status)
       values ($1, $2, $3, 'production', $4, now(), now(), now(), now(), 'pending')`,
      [productionJobId, organizationId, projectWithTests, "c".repeat(32)],
    );
    await client.query(
      `insert into idempotent_operation
         (organization_id, project_id, actor_id, operation, idempotency_key,
          request_digest, result_id)
       values ($1, $2, $3, 'start_run', 'lost-answer', 'digest', $4)`,
      [organizationId, projectWithTests, userId, oldRunId],
    );

    const migration = (await readMigrations()).find((one) =>
      one.name.startsWith("0040_"),
    );
    if (migration === undefined) throw new Error("0040 is missing");
    await writeFile(path.join(before, migration.name), migration.sql);
    cutoverStartedAt = Date.now();
    ({ applied } = await runMigrations(database.url, before));
    cutoverFinishedAt = Date.now();
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("applies one clean cutover", () => {
    expect(applied).toEqual(["0040_test_suites.sql"]);
  });

  it("creates one ordinary Default suite only for the project with tests", async () => {
    const { rows } = await client.query<{
      id: string;
      project_id: string;
      name: string;
      deleted_at: Date | null;
    }>("select id, project_id, name, deleted_at from test_suite order by project_id");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: projectWithTests,
      name: "Default",
      deleted_at: null,
    });
    expect(rows[0]?.id).toMatch(/^ste_[0-9A-HJKMNP-TV-Z]{26}$/u);
    const bits = idBits(rows[0]?.id ?? "");
    expect(Number((bits >> 76n) & 0xfn)).toBe(7);
    expect(Number((bits >> 62n) & 0x3n)).toBe(0b10);
    expect(mintedAt(rows[0]?.id ?? "").getTime()).toBeGreaterThanOrEqual(
      cutoverStartedAt,
    );
    expect(mintedAt(rows[0]?.id ?? "").getTime()).toBeLessThanOrEqual(
      cutoverFinishedAt,
    );
    expect(rows.some((row) => row.project_id === emptyProject)).toBe(false);

    const { rows: helpers } = await client.query<{ helper: string | null }>(
      "select to_regprocedure('_migration_0040_test_suite_id()')::text as helper",
    );
    expect(helpers).toEqual([{ helper: null }]);
  });

  it("keeps active and hidden tests in that required suite and removes capability content", async () => {
    const { rows } = await client.query<{
      id: string;
      suite_id: string;
      deleted_at: Date | null;
      content: Record<string, unknown>;
    }>(
      `select t.id, t.suite_id, t.deleted_at, v.content
         from test t join test_version v on v.id = t.current_version_id
        order by t.id`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.suite_id)).size).toBe(1);
    expect(rows.find((row) => row.id === activeTestId)?.deleted_at).toBeNull();
    expect(rows.find((row) => row.id === hiddenTestId)?.deleted_at).not.toBeNull();
    expect(rows.every((row) => !("requiredCapabilities" in row.content))).toBe(true);
  });

  it("removes old simulation control-plane state and its start ledger", async () => {
    for (const table of [
      "run",
      "simulation",
      "grading_plan",
      "idempotent_operation",
    ]) {
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from ${table}`,
      );
      expect(rows).toEqual([{ count: "0" }]);
    }
    const { rows: simulationJobs } = await client.query<{ id: string }>(
      "select id from grading_job where id = $1",
      [simulationJobId],
    );
    expect(simulationJobs).toEqual([]);
  });

  it("preserves production grading work", async () => {
    const { rows } = await client.query<{ id: string; source: string }>(
      "select id, source from grading_job where id = $1",
      [productionJobId],
    );
    expect(rows).toEqual([{ id: productionJobId, source: "production" }]);
  });
});

describe("the Retell polling-control cutover (0041)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;
  let cutoverStartedAt: Date;
  let cutoverFinishedAt: Date;

  const organizationId = newId("org");
  const projectId = newId("prj");
  // Literal ids, because 0042 takes both prefixes out of the shipped minter:
  // the rows this cutover reads are ones a build before 0042 wrote.
  const setupId = `mns_${"A".repeat(26)}`;
  const importingAgent = `rma_${"A".repeat(26)}`;
  const pollingAgent = `rma_${"B".repeat(26)}`;
  const oldClaim = { id: `ptc_${"A".repeat(26)}`, callId: "call_before_it" };
  const oldFailure = { id: `rif_${"A".repeat(26)}`, callId: "call_lost" };

  beforeAll(async () => {
    database = await createEmptyDatabase("retell_polling_control_cutover");
    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0041-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0041") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug) values ($1, 'Polling', 'polling')`,
      [organizationId],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $2, 'Polling', 'polling', $3)`,
      [projectId, organizationId, newId("rev")],
    );
    await client.query(
      `insert into monitoring_setup
         (id, organization_id, project_id, agent_platform, strategy,
          credentials, credentials_hint)
       values ($1, $2, $3, 'retell', 'retell_api_polling', 'sealed', 'key1')`,
      [setupId, organizationId, projectId],
    );

    // The two states the old build could leave a selected agent in: one paused
    // part-way through an import with a cursor and a live lease, and one
    // settled into regular polling with a paused daily reconciliation window
    // waiting beside it.
    await client.query(
      `insert into retell_monitored_agent
         (id, monitoring_setup_id, organization_id, project_id,
          platform_agent_id, platform_agent_name, state, scan_kind, scan_from,
          scan_through, pagination_key, pagination_trail, completed_through,
          next_regular_poll_at, next_poll_at, next_reconciliation_at,
          lease_owner, lease_expires_at)
       values ($1, $2, $3, $4, 'agent_importing', 'Importing', 'importing',
          'historical_import', now() - interval '30 days', now(), 'page-7',
          '["page-1","page-7"]', null, now() + interval '30 seconds', now(),
          now() + interval '1 day', 'lease-owner-uuid',
          now() + interval '90 seconds')`,
      [importingAgent, setupId, organizationId, projectId],
    );
    await client.query(
      `insert into retell_monitored_agent
         (id, monitoring_setup_id, organization_id, project_id,
          platform_agent_id, platform_agent_name, state, pagination_trail,
          reconciliation_from, reconciliation_through,
          reconciliation_pagination_key, reconciliation_pagination_trail,
          reconciliation_needs_regular, completed_through,
          next_regular_poll_at, next_poll_at, next_reconciliation_at)
       values ($1, $2, $3, $4, 'agent_polling', 'Polling', 'active', '[]',
          now() - interval '30 days', now() - interval '2 hours', 'recon-page',
          '["recon-page"]', true, now() - interval '2 hours',
          now() + interval '30 seconds', now() + interval '30 seconds',
          now() + interval '22 hours')`,
      [pollingAgent, setupId, organizationId, projectId],
    );

    await client.query(
      `insert into production_trace_claim
         (id, organization_id, project_id, trace_id, provider_call_id,
          platform_agent_id, payload, ended_at, status, claimed_at, written_at)
       values ($1, $2, $3, $4, $5, 'agent_polling',
          '{"call_id":"call_before_it"}', now(), 'written', now(), now())`,
      [oldClaim.id, organizationId, projectId, "c".repeat(32), oldClaim.callId],
    );
    await client.query(
      `insert into retell_ingestion_failure
         (id, organization_id, project_id, retell_monitored_agent_id,
          provider_call_id, error_kind, payload, attempts, status,
          last_attempt_at)
       values ($1, $2, $3, $4, $5, 'malformed_provider_call', '{}', 3, 'open',
          now())`,
      [
        oldFailure.id,
        organizationId,
        projectId,
        pollingAgent,
        oldFailure.callId,
      ],
    );

    const cutover = (await readMigrations()).find(
      (migration) => migration.name === "0041_retell_polling_control.sql",
    );
    if (cutover === undefined) throw new Error("missing migration 0041");
    await writeFile(path.join(before, cutover.name), cutover.sql);

    cutoverStartedAt = new Date();
    await runMigrations(database.url, before);
    cutoverFinishedAt = new Date();
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("removes the payload claim and the per-call failure tables", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('production_trace_claim', 'retell_ingestion_failure')`,
    );
    expect(rows).toEqual([]);
  });

  it("removes every reconciliation column and leaves one next-poll time", async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'retell_monitored_agent'`,
    );
    const columns = rows.map((row) => row.column_name);
    for (const gone of [
      "reconciliation_from",
      "reconciliation_through",
      "reconciliation_pagination_key",
      "reconciliation_pagination_trail",
      "reconciliation_needs_regular",
      "next_regular_poll_at",
      "next_reconciliation_at",
    ]) {
      expect(columns).not.toContain(gone);
    }
    expect(columns).toEqual(
      expect.arrayContaining([
        "next_poll_at",
        "regular_floor_at",
        "import_generation",
      ]),
    );
  });

  it("leaves no scan kind naming a scan this build cannot run", async () => {
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'retell_monitored_agent_scan_kind_allowed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("historical_import");
    expect(rows[0]?.definition).toContain("regular");
    expect(rows[0]?.definition).not.toContain("reconciliation");
  });

  it("resets every selected agent to a regular poll due at the cutover, floored there", async () => {
    const { rows } = await client.query<{
      id: string;
      scan_kind: string | null;
      scan_from: Date | null;
      scan_through: Date | null;
      pagination_key: string | null;
      pagination_trail: string;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      completed_through: Date;
      next_poll_at: Date;
      regular_floor_at: Date;
      import_generation: number;
    }>(
      `select id, scan_kind, scan_from, scan_through, pagination_key,
              pagination_trail, lease_owner, lease_expires_at,
              completed_through, next_poll_at, regular_floor_at,
              import_generation
         from retell_monitored_agent order by platform_agent_id`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scan_kind).toBeNull();
      expect(row.scan_from).toBeNull();
      expect(row.scan_through).toBeNull();
      expect(row.pagination_key).toBeNull();
      expect(row.pagination_trail).toBe("[]");
      expect(row.lease_owner).toBeNull();
      expect(row.lease_expires_at).toBeNull();
      expect(row.import_generation).toBe(1);
      for (const instant of [
        row.completed_through,
        row.next_poll_at,
        row.regular_floor_at,
      ]) {
        expect(instant.getTime()).toBeGreaterThanOrEqual(
          cutoverStartedAt.getTime() - 1_000,
        );
        expect(instant.getTime()).toBeLessThanOrEqual(
          cutoverFinishedAt.getTime() + 1_000,
        );
      }
      // The floor is what stops the first window's five-minute overlap
      // reaching behind the release, so the two are the same instant.
      expect(row.regular_floor_at.getTime()).toBe(
        row.completed_through.getTime(),
      );
    }
  });

  it("holds transient call state to one schedule and a bounded budget", async () => {
    await client.query(
      `insert into retell_call_retry
         (id, organization_id, project_id, retell_monitored_agent_id,
          provider_call_id, error_kind, attempts, last_attempt_at,
          next_attempt_at)
       values ($1, $2, $3, $4, 'call_retrying', 'provider_call_refused', 1,
          now(), now() + interval '30 seconds')`,
      [newId("rcr"), organizationId, projectId, pollingAgent],
    );
    await expect(
      client.query(
        `insert into retell_call_retry
           (id, organization_id, project_id, retell_monitored_agent_id,
            provider_call_id, error_kind, attempts, last_attempt_at,
            next_attempt_at, expires_at)
         values ($1, $2, $3, $4, 'call_both', 'provider_call_refused', 1,
            now(), now(), now())`,
        [newId("rcr"), organizationId, projectId, pollingAgent],
      ),
    ).rejects.toMatchObject({ constraint: "retell_call_retry_one_schedule" });
    await expect(
      client.query(
        `insert into retell_call_retry
           (id, organization_id, project_id, retell_monitored_agent_id,
            provider_call_id, error_kind, attempts, last_attempt_at,
            next_attempt_at)
         values ($1, $2, $3, $4, 'call_over_budget', 'provider_call_refused',
            5, now(), now())`,
        [newId("rcr"), organizationId, projectId, pollingAgent],
      ),
    ).rejects.toMatchObject({
      constraint: "retell_call_retry_attempts_bounded",
    });
  });

  it("takes a selected agent's transient call state with it", async () => {
    await client.query("delete from retell_monitored_agent where id = $1", [
      pollingAgent,
    ]);
    const { rows } = await client.query<{ count: string }>(
      "select count(*)::text as count from retell_call_retry",
    );
    expect(rows).toEqual([{ count: "0" }]);
  });
});

describe("agents own platform monitoring (0042)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  // Literal ids, because 0042 takes both prefixes out of the shipped minter:
  // the rows this cutover reads are ones a build before 0042 wrote.
  const setupId = `mns_${"A".repeat(26)}`;
  const selectedAgent = `rma_${"A".repeat(26)}`;
  const frontDesk = newId("agt");
  const backOffice = newId("agt");
  const chatConnection = newId("con");
  const phoneConnection = newId("con");

  beforeAll(async () => {
    database = await createEmptyDatabase("agents_own_platform_monitoring");
    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0042-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0042") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug) values ($1, 'Owning', 'owning')`,
      [organizationId],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $2, 'Owning', 'owning', $3)`,
      [projectId, organizationId, newId("rev")],
    );

    // Two installed agents, each with a description and a revision, because
    // this cutover drops both columns out from under rows that hold them.
    for (const [id, name] of [
      [frontDesk, "Front desk"],
      [backOffice, "Back office"],
    ]) {
      await client.query(
        `insert into agent
           (id, organization_id, project_id, name, description, revision)
         values ($1, $2, $3, $4, 'Written before the cutover', $5)`,
        [id, organizationId, projectId, name, newId("rev")],
      );
    }

    // Two connection kinds, so the rename has more than one value to carry
    // and a column of one repeated value cannot pass for a carried one.
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, agent_platform,
          connection_kind, modality, topology, access_variant, config, revision)
       values ($1, $2, $3, $4, 'Chat', 'retell', 'retell_chat_api', 'chat',
          'hosted-broker', 'retell_chat_api.api_key',
          '{"retellAgentId":"agent_installed"}'::jsonb, $5)`,
      [chatConnection, organizationId, projectId, frontDesk, newId("rev")],
    );
    await client.query(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, agent_platform,
          connection_kind, modality, topology, access_variant, config, revision)
       values ($1, $2, $3, $4, 'Line', 'retell', 'phone_number', 'voice',
          'egma-dials-in', 'phone_number.public_e164',
          '{"e164":"+15550000000"}'::jsonb, $5)`,
      [phoneConnection, organizationId, projectId, backOffice, newId("rev")],
    );

    // The whole of what the old build owned: a setup object, one selected
    // agent under it, and a retry row hanging off that agent mid-flight.
    await client.query(
      `insert into monitoring_setup
         (id, organization_id, project_id, agent_platform, strategy,
          credentials, credentials_hint)
       values ($1, $2, $3, 'retell', 'retell_api_polling', 'sealed', 'key1')`,
      [setupId, organizationId, projectId],
    );
    await client.query(
      `insert into retell_monitored_agent
         (id, monitoring_setup_id, organization_id, project_id,
          platform_agent_id, platform_agent_name, state, pagination_trail,
          completed_through, next_poll_at, regular_floor_at)
       values ($1, $2, $3, $4, 'agent_installed', 'Installed', 'active', '[]',
          now(), now(), now())`,
      [selectedAgent, setupId, organizationId, projectId],
    );
    await client.query(
      `insert into retell_call_retry
         (id, organization_id, project_id, retell_monitored_agent_id,
          provider_call_id, error_kind, attempts, last_attempt_at,
          next_attempt_at)
       values ($1, $2, $3, $4, 'call_mid_flight', 'provider_call_refused', 1,
          now(), now() + interval '30 seconds')`,
      [newId("rcr"), organizationId, projectId, selectedAgent],
    );

    const cutover = (await readMigrations()).find(
      (migration) =>
        migration.name === "0042_agents_own_platform_monitoring.sql",
    );
    if (cutover === undefined) throw new Error("missing migration 0042");
    await writeFile(path.join(before, cutover.name), cutover.sql);
    await runMigrations(database.url, before);
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("takes the setup object and its selected agents out of the store", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('monitoring_setup', 'retell_monitored_agent')`,
    );
    expect(rows).toEqual([]);
    const state = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = 'monitoring_state'`,
    );
    expect(state.rows).toHaveLength(1);
  });

  it("carries every connection kind across to the renamed column", async () => {
    const { rows } = await client.query<{
      name: string;
      connection_type: string;
    }>("select name, connection_type from connection order by name");
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'connection'`,
    );
    expect(rows).toEqual([
      { name: "Chat", connection_type: "retell_chat_api" },
      { name: "Line", connection_type: "phone_number" },
    ]);
    // The rename is in place, and the two columns the connection no longer
    // owns went with it: the platform now sits on the agent, and concurrent
    // edits are last-writer-wins.
    const held = columns.rows.map((row) => row.column_name);
    expect(held).not.toContain("connection_kind");
    expect(held).not.toContain("agent_platform");
    expect(held).not.toContain("revision");
  });

  it("names the surviving connection type under the column that holds it", async () => {
    const { rows } = await client.query<{ conname: string }>(
      `select conname from pg_constraint
        where conname in ('connection_kind_allowed', 'connection_type_allowed',
                          'connection_agent_platform_allowed')`,
    );
    expect(rows.map((row) => row.conname)).toEqual(["connection_type_allowed"]);
  });

  it("gives every installed agent the binding, switched off", async () => {
    const { rows } = await client.query<{
      name: string;
      agent_platform: string | null;
      platform_agent_id: string | null;
      monitoring_api_key: string | null;
      monitoring_api_key_hint: string | null;
      pull_production_calls: boolean;
    }>(
      `select name, agent_platform, platform_agent_id, monitoring_api_key,
              monitoring_api_key_hint, pull_production_calls
         from agent order by name`,
    );
    expect(rows).toEqual([
      {
        name: "Back office",
        agent_platform: null,
        platform_agent_id: null,
        monitoring_api_key: null,
        monitoring_api_key_hint: null,
        pull_production_calls: false,
      },
      {
        name: "Front desk",
        agent_platform: null,
        platform_agent_id: null,
        monitoring_api_key: null,
        monitoring_api_key_hint: null,
        pull_production_calls: false,
      },
    ]);
    // Nothing is carried from the selected-agent rows: an installed agent is
    // unbound and not pulling until a person pastes a key onto it.
    const gone = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'agent'
          and column_name in ('description', 'revision')`,
    );
    expect(gone.rows).toEqual([]);
  });

  it("empties the transient call state it re-keys to the agent", async () => {
    const { rows } = await client.query<{ count: string }>(
      "select count(*)::text as count from retell_call_retry",
    );
    // Minutes of retry budget and a marker that expires in fifteen, both
    // naming a row that stops existing here. The poller rebuilds what it
    // still needs on its next turn.
    expect(rows).toEqual([{ count: "0" }]);
    const keyed = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'retell_call_retry'
          and column_name in ('agent_id', 'retell_monitored_agent_id')`,
    );
    expect(keyed.rows.map((row) => row.column_name)).toEqual(["agent_id"]);
  });

  it("refuses a switch on that is not a whole binding", async () => {
    const halfBound = newId("agt");
    await client.query(
      `insert into agent (id, organization_id, project_id, name)
       values ($1, $2, $3, 'Half bound')`,
      [halfBound, organizationId, projectId],
    );
    await expect(
      client.query(
        `update agent set agent_platform = 'retell',
            platform_agent_id = 'agent_half', pull_production_calls = true
          where id = $1`,
        [halfBound],
      ),
    ).rejects.toMatchObject({ constraint: "agent_pull_needs_binding" });
    // The key and its hint travel together, whichever way round they are set.
    await expect(
      client.query(
        `update agent set agent_platform = 'retell', monitoring_api_key = 'sealed'
          where id = $1`,
        [halfBound],
      ),
    ).rejects.toMatchObject({ constraint: "agent_monitoring_key_hint_agrees" });
  });

  it("lets only one switched-on agent name one platform agent", async () => {
    const pulling = newId("agt");
    const second = newId("agt");
    for (const [id, name] of [
      [pulling, "Pulling"],
      [second, "Second"],
    ]) {
      await client.query(
        `insert into agent
           (id, organization_id, project_id, name, agent_platform,
            platform_agent_id, monitoring_api_key, monitoring_api_key_hint)
         values ($1, $2, $3, $4, 'retell', 'agent_shared', 'sealed', 'key1')`,
        [id, organizationId, projectId, name],
      );
    }
    // Both may name it while stopped: the index is partial, so it only ever
    // speaks about the agents actually pulling.
    await client.query(
      "update agent set pull_production_calls = true where id = $1",
      [pulling],
    );
    await expect(
      client.query(
        "update agent set pull_production_calls = true where id = $1",
        [second],
      ),
    ).rejects.toMatchObject({ constraint: "agent_pulled_platform_agent_unique" });
  });
});

describe("the required agent platform cutover (0044)", () => {
  let database: EmptyDatabase;
  let before: string;
  let client: pg.Client;

  const organizationId = newId("org");
  const projectId = newId("prj");
  const bareAgent = newId("agt");
  const retellAgent = newId("agt");
  const liveKitAgent = newId("agt");

  beforeAll(async () => {
    database = await createEmptyDatabase("required_agent_platform");
    before = await mkdtemp(path.join(os.tmpdir(), "egma-before-0044-"));
    for (const migration of await readMigrations()) {
      if (migration.name < "0044") {
        await writeFile(path.join(before, migration.name), migration.sql);
      }
    }
    await runMigrations(database.url, before);

    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug)
       values ($1, 'Platform cutover', 'platform-cutover')`,
      [organizationId],
    );
    await client.query(
      `insert into project (id, organization_id, name, slug, revision)
       values ($1, $2, 'Platform cutover', 'platform-cutover', $3)`,
      [projectId, organizationId, newId("rev")],
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(before, { recursive: true, force: true });
    await database.drop();
  });

  it("stops on an old agent whose platform cannot be recovered", async () => {
    await client.query(
      `insert into agent (id, organization_id, project_id, name)
       values ($1, $2, $3, 'Needs reset')`,
      [bareAgent, organizationId, projectId],
    );

    await expect(runMigrations(database.url)).rejects.toThrow(
      /migration 0044_require_agent_platform\.sql failed/,
    );

    const recorded = await client.query<{ count: string }>(
      `select count(*)::text as count from egma_meta.migration
        where name = '0044_require_agent_platform.sql'`,
    );
    expect(recorded.rows).toEqual([{ count: "0" }]);
  });

  it("applies after the reset and normalizes the shipped LiveKit value", async () => {
    await client.query("delete from agent where id = $1", [bareAgent]);
    await client.query(
      `insert into agent
         (id, organization_id, project_id, name, agent_platform)
       values
         ($1, $3, $4, 'Retell', 'retell'),
         ($2, $3, $4, 'LiveKit', 'livekit_agents')`,
      [retellAgent, liveKitAgent, organizationId, projectId],
    );

    const result = await runMigrations(database.url);
    expect(result.applied).toEqual(["0044_require_agent_platform.sql"]);

    const agents = await client.query<{
      name: string;
      agent_platform: string;
    }>("select name, agent_platform from agent order by name");
    expect(agents.rows).toEqual([
      { name: "LiveKit", agent_platform: "livekit" },
      { name: "Retell", agent_platform: "retell" },
    ]);

    const columns = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent'
          and column_name = 'agent_platform'`,
    );
    expect(columns.rows).toEqual([{ is_nullable: "NO" }]);
  });
});
