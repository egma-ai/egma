import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MIGRATIONS_DIRECTORY,
  readMigrations,
  runMigrations,
} from "../src/migrate.ts";
import {
  createEmptyDatabase,
  openSingleConnection,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

const BASELINE = "0000_baseline.sql";
const CURRENT_MIGRATIONS = [BASELINE, "0001_provider_keys.sql"];
let database: EmptyDatabase;
let store: SingleConnection;
let directory: string;

beforeEach(async () => {
  database = await createEmptyDatabase("baseline");
  store = await openSingleConnection(database.url);
  directory = await mkdtemp(path.join(tmpdir(), "egma-baseline-"));
});
afterEach(async () => {
  await store.close();
  await database.drop();
  await rm(directory, { recursive: true, force: true });
});

describe("the fresh Postgres baseline", () => {
  it("installs the baseline and provider keys and keeps organization data on repeated boot", async () => {
    expect((await readMigrations()).map((migration) => migration.name)).toEqual(
      CURRENT_MIGRATIONS,
    );
    expect(await runMigrations(database.url)).toEqual({
      applied: CURRENT_MIGRATIONS,
      alreadyApplied: [],
    });
    const id = newId("org");
    await store.sql(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [id],
    );
    expect(await runMigrations(database.url)).toEqual({
      applied: [],
      alreadyApplied: CURRENT_MIGRATIONS,
    });
    expect((await store.sql("select id, name from organization")).rows).toEqual(
      [{ id, name: "Acme" }],
    );
    expect(
      (await store.sql("select name from egma_meta.migration")).rows,
    ).toEqual(CURRENT_MIGRATIONS.map((name) => ({ name })));
  });

  it("adds provider keys to an installed baseline without changing existing organizations", async () => {
    await writeFile(
      path.join(directory, BASELINE),
      await readFile(path.join(MIGRATIONS_DIRECTORY, BASELINE), "utf8"),
    );
    await runMigrations(database.url, directory);
    const id = newId("org");
    await store.sql(
      "insert into organization (id,name,slug) values ($1,'Before keys','before-keys')",
      [id],
    );
    expect(await runMigrations(database.url)).toEqual({
      applied: ["0001_provider_keys.sql"],
      alreadyApplied: [BASELINE],
    });
    expect((await store.sql("select id,name from organization")).rows).toEqual([
      { id, name: "Before keys" },
    ]);
    expect((await store.sql("select * from provider_key")).rows).toEqual([]);
  });

  it("applies once when API instances boot concurrently", async () => {
    const results = await Promise.all([
      runMigrations(database.url),
      runMigrations(database.url),
      runMigrations(database.url),
    ]);
    expect(results.flatMap((result) => result.applied)).toEqual(
      CURRENT_MIGRATIONS,
    );
    expect(
      results.filter((result) => result.alreadyApplied.includes(BASELINE)),
    ).toHaveLength(2);
  });

  it("rolls back failed installation before recording the baseline and retries cleanly", async () => {
    const sql = await readFile(
      path.join(MIGRATIONS_DIRECTORY, BASELINE),
      "utf8",
    );
    await writeFile(
      path.join(directory, BASELINE),
      `${sql}\nselect * from baseline_failure_probe;`,
    );
    await expect(runMigrations(database.url, directory)).rejects.toThrow(
      `migration ${BASELINE} failed`,
    );
    expect(
      (
        await store.sql(
          "select tablename from pg_tables where schemaname = 'public'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await store.sql("select name from egma_meta.migration")).rows,
    ).toEqual([]);
    await writeFile(path.join(directory, BASELINE), sql);
    expect((await runMigrations(database.url, directory)).applied).toEqual([
      BASELINE,
    ]);
  });

  it("refuses a changed applied baseline", async () => {
    await runMigrations(database.url);
    const sql = await readFile(
      path.join(MIGRATIONS_DIRECTORY, BASELINE),
      "utf8",
    );
    await writeFile(
      path.join(directory, BASELINE),
      `${sql}\n-- changed checksum\n`,
    );
    await writeFile(
      path.join(directory, CURRENT_MIGRATIONS[1]!),
      await readFile(
        path.join(MIGRATIONS_DIRECTORY, CURRENT_MIGRATIONS[1]!),
        "utf8",
      ),
    );
    await expect(runMigrations(database.url, directory)).rejects.toThrow(
      "changed since it was applied",
    );
    expect(
      (await store.sql("select name from egma_meta.migration order by name"))
        .rows,
    ).toEqual(CURRENT_MIGRATIONS.map((name) => ({ name })));
  });

  it("refuses unknown recorded history even when the baseline matches", async () => {
    await runMigrations(database.url);
    await store.sql(
      "insert into egma_meta.migration (name, hash) values ('9999_unknown.sql', 'unknown')",
    );
    await expect(runMigrations(database.url)).rejects.toThrow(
      "database records migrations that this build does not contain",
    );
    expect(
      (await store.sql("select name from egma_meta.migration order by name"))
        .rows,
    ).toEqual(
      [...CURRENT_MIGRATIONS, "9999_unknown.sql"].map((name) => ({ name })),
    );
  });

  it("installs validated constraints and enabled custom execution guards", async () => {
    await runMigrations(database.url);
    expect(
      (
        await store.sql(`select conname from pg_constraint
        where connamespace = 'public'::regnamespace and not convalidated`)
      ).rows,
    ).toEqual([]);
    expect(
      (
        await store.sql(`select tgname from pg_trigger
        where not tgisinternal and tgenabled <> 'O'`)
      ).rows,
    ).toEqual([]);
    const { rows } = await store.sql<{ tgname: string }>(
      "select tgname from pg_trigger where not tgisinternal",
    );
    expect(rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "run_lifecycle_guard",
        "simulation_lifecycle_guard",
        "run_grading_plan_guard",
        "grading_job_selection_immutable_guard",
        "persona_version_semantics_immutable_guard",
        "test_suite_membership_immutable",
      ]),
    );
  });
});
