import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DIRECTORY, runMigrations } from "../src/migrate.ts";
import {
  createEmptyDatabase,
  openSingleConnection,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

const UNDER_TEST = "0009_simplify_control_plane_tables.sql";
const configured = newId("org");
const savedEmpty = newId("org");
const unconfigured = newId("org");
const project = newId("prj");
const user = newId("usr");
const agent = newId("agt");
const connection = newId("con");
const suite = newId("ste");
const run = newId("run");
const organizationUpdatedAt = new Date("2026-08-01T00:00:00.000Z");
const settingsUpdatedAt = new Date("2026-08-02T00:00:00.000Z");

let database: EmptyDatabase;
let store: SingleConnection;
let directory: string | undefined;
let originalRun: unknown;

beforeAll(async () => {
  database = await createEmptyDatabase("table_simplification");
  directory = await mkdtemp(path.join(tmpdir(), "egma-before-table-simplification-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST).sort();
  for (const name of earlier) {
    await cp(path.join(MIGRATIONS_DIRECTORY, name), path.join(directory, name));
  }
  await runMigrations(database.url, directory);
  store = await openSingleConnection(database.url);

  for (const [id, name] of [[configured, "configured"], [savedEmpty, "saved-empty"], [unconfigured, "unconfigured"]]) {
    await store.sql("insert into organization (id,name,slug,updated_at) values ($1,$2,$2,$3)", [id, name, organizationUpdatedAt]);
  }
  await store.sql("insert into organization_settings (organization_id,retention_days,data_residency,updated_at) values ($1,30,'us',$3),($2,null,null,$3)", [configured, savedEmpty, settingsUpdatedAt]);
  await store.sql('insert into "user" (id,email) values ($1,\'table-migration@example.test\')', [user]);
  await store.sql("insert into project (id,organization_id,name,slug,revision) values ($1,$2,'Project','project',$3)", [project, configured, newId("rev")]);
  await store.sql("insert into agent (id,organization_id,project_id,name,agent_platform) values ($1,$2,$3,'Agent','retell')", [agent, configured, project]);
  await store.sql("insert into connection (id,organization_id,project_id,agent_id,name,connection_type,access_variant,modality,topology,config) values ($1,$2,$3,$4,'Connection','retell_chat_api','retell_chat_api.api_key','chat','hosted-broker','{}')", [connection, configured, project, agent]);
  await store.sql("insert into test_suite (id,organization_id,project_id,name) values ($1,$2,$3,'Suite')", [suite, configured, project]);
  await store.sql("insert into run (id,organization_id,project_id,suite_id,agent_id,connection_id,status,triggered_via,triggered_by,connection_snapshot,expected_simulation_count,grading_plan) values ($1,$2,$3,$4,$5,$6,'pending','manual',$7,'{}',1,$8)", [run, configured, project, suite, agent, connection, user, JSON.stringify({ capturedAt: organizationUpdatedAt.toISOString(), groups: [] })]);
  await store.sql("insert into idempotent_operation (organization_id,project_id,actor_id,operation,idempotency_key,request_digest,result_id) values ($1,$2,$3,'start_run','old-key','old-digest',$4)", [configured, project, user, run]);
  originalRun = (await store.sql("select to_jsonb(r) as value from run r where id = $1", [run])).rows[0]?.value;
});

afterAll(async () => {
  await store?.sql("rollback").catch(() => undefined);
  await store?.close();
  await database?.drop();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

describe("the control-plane table simplification", () => {
  it("can roll back the cutover without losing the old settings or receipts", async () => {
    const migration = await readFile(path.join(MIGRATIONS_DIRECTORY, UNDER_TEST), "utf8");
    await store.sql("begin");
    try {
      await store.sql(migration);
    } finally {
      await store.sql("rollback");
    }
    expect((await store.sql("select retention_days,data_residency,updated_at from organization_settings where organization_id = $1", [configured])).rows)
      .toEqual([{ retention_days: 30, data_residency: "us", updated_at: settingsUpdatedAt }]);
    expect((await store.sql("select result_id from idempotent_operation")).rows).toEqual([{ result_id: run }]);
  });

  it("moves saved settings, preserves unset settings and runs, and removes both tables", async () => {
    if (directory === undefined) throw new Error("the migration directory was not prepared");
    await cp(path.join(MIGRATIONS_DIRECTORY, UNDER_TEST), path.join(directory, UNDER_TEST));
    expect((await runMigrations(database.url, directory)).applied).toEqual([UNDER_TEST]);

    for (const [id, retentionDays, dataResidency, updatedAt] of [
      [configured, 30, "us", settingsUpdatedAt],
      [savedEmpty, null, null, settingsUpdatedAt],
      [unconfigured, null, null, null],
    ]) {
      expect((await store.sql("select retention_days,data_residency,settings_updated_at,updated_at from organization where id = $1", [id])).rows).toEqual([{
        retention_days: retentionDays,
        data_residency: dataResidency,
        settings_updated_at: updatedAt,
        updated_at: organizationUpdatedAt,
      }]);
    }
    expect((await store.sql("select to_jsonb(r) as value from run r where id = $1", [run])).rows[0]?.value).toEqual(originalRun);
    expect((await store.sql("select to_regclass('organization_settings') as settings,to_regclass('idempotent_operation') as receipts")).rows)
      .toEqual([{ settings: null, receipts: null }]);
    expect((await runMigrations(database.url, directory)).applied).toEqual([]);
  });
});
