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
const RUN_CONCURRENCY = "0001_run_concurrency.sql";
const PERSONA_CONTROLS = "0002_melodic_switch.sql";
const PERSONA_BACKGROUND = "0003_persona_background_sound.sql";
const PERSONA_INTERRUPTION = "0004_persona_interruptions.sql";
const SHIPPED_BASELINE_HASH =
  "ea57d012e674f136f4ef74930865a8ccfeafaebcf92d7f628ce53e8deddc084a";
const CURRENT_MIGRATIONS = [
  BASELINE,
  RUN_CONCURRENCY,
  PERSONA_CONTROLS,
  PERSONA_BACKGROUND,
  PERSONA_INTERRUPTION,
];
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

describe("the Postgres migration chain", () => {
  it("keeps the shipped baseline and preserves organization data on repeated boot", async () => {
    const migrations = await readMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual(CURRENT_MIGRATIONS);
    expect(migrations.find((migration) => migration.name === BASELINE)?.hash).toBe(
      SHIPPED_BASELINE_HASH,
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

  it("preserves provider keys and scheduled cancellation on repeated boot", async () => {
    await runMigrations(database.url);
    const organizationId = newId("org");
    const revision = newId("rev");
    const cancelAt = new Date("2026-10-07T12:34:56.000Z");
    await store.sql(
      "insert into organization (id, name, slug) values ($1, 'Acme', 'acme')",
      [organizationId],
    );
    await store.sql(
      `insert into cloud_plan
        (id, code, name, fee_micros, web_call_overage_micros_per_minute, phone_overage_micros_per_minute)
        values ($1, 'pro', 'Pro', 10000000, 10000, 20000)`,
      [newId("cpl")],
    );
    await store.sql(
      `insert into cloud_billing_account
        (id, organization_id, plan_code, period_anchor, activated_at, stripe_cancel_at)
        values ($1, $2, 'pro', now(), now(), $3)`,
      [newId("cba"), organizationId, cancelAt],
    );
    await store.sql(
      `insert into provider_key
        (organization_id, provider, credentials, hint, revision)
        values ($1, 'openai', 'sealed-test-envelope', '••••abcd', $2)`,
      [organizationId, revision],
    );

    expect(await runMigrations(database.url)).toEqual({
      applied: [],
      alreadyApplied: CURRENT_MIGRATIONS,
    });
    expect((await store.sql(
      "select organization_id, provider, credentials, hint, revision from provider_key",
    )).rows).toEqual([{
      organization_id: organizationId,
      provider: "openai",
      credentials: "sealed-test-envelope",
      hint: "••••abcd",
      revision,
    }]);
    expect((await store.sql(
      "select stripe_cancel_at from cloud_billing_account",
    )).rows).toEqual([{ stripe_cancel_at: cancelAt }]);
    expect((await store.sql(
      "select is_nullable from information_schema.columns where table_name = 'cloud_billing_account' and column_name = 'stripe_cancel_at'",
    )).rows).toEqual([{ is_nullable: "YES" }]);
  });

  it("upgrades a database that already has the production baseline", async () => {
    const baseline = await readFile(
      path.join(MIGRATIONS_DIRECTORY, BASELINE),
      "utf8",
    );
    await writeFile(path.join(directory, BASELINE), baseline);
    expect(await runMigrations(database.url, directory)).toEqual({
      applied: [BASELINE],
      alreadyApplied: [],
    });
    const organizationId = newId("org");
    await store.sql(
      "insert into organization (id, name, slug) values ($1, 'Before migration', 'before-migration')",
      [organizationId],
    );
    const runIds = [newId("run"), newId("run")];
    await store.sql("set session_replication_role = replica");
    try {
      for (const [index, modality] of ["voice", "chat"].entries()) {
        await store.sql(
          `insert into run
            (id, organization_id, project_id, suite_id, agent_id, connection_id,
             status, triggered_via, connection_snapshot, expected_simulation_count,
             completed_count, failed_count, canceled_count, started_at, finished_at,
             grading_plan)
           values ($1, $2, $3, $4, $5, $6, 'completed', 'manual', $7, 1,
                   1, 0, 0, now(), now(), $8)`,
          [
            runIds[index],
            organizationId,
            newId("prj"),
            newId("ste"),
            newId("agt"),
            newId("con"),
            { modality },
            { capturedAt: "2026-09-10T00:00:00.000Z", groups: [] },
          ],
        );
      }
    } finally {
      await store.sql("set session_replication_role = origin");
    }

    expect(await runMigrations(database.url)).toEqual({
      applied: [RUN_CONCURRENCY, PERSONA_CONTROLS, PERSONA_BACKGROUND, PERSONA_INTERRUPTION],
      alreadyApplied: [BASELINE],
    });
    expect((await store.sql("select id from organization where id = $1", [organizationId])).rows)
      .toEqual([{ id: organizationId }]);
    expect(
      (
        await store.sql(`select connection_snapshot->>'modality' as modality, concurrency
          from run where id = any($1::text[]) order by modality`, [runIds])
      ).rows,
    ).toEqual([
      { modality: "chat", concurrency: 10 },
      { modality: "voice", concurrency: 4 },
    ]);
    expect(
      (
        await store.sql(`select column_default, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'run' and column_name = 'concurrency'`)
      ).rows,
    ).toEqual([{ column_default: "4", is_nullable: "NO" }]);
    expect(
      (await store.sql("select name from egma_meta.migration order by name")).rows,
    ).toEqual(CURRENT_MIGRATIONS.map((name) => ({ name })));
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
