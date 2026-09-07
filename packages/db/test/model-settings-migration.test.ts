import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DIRECTORY, runMigrations } from "../src/migrate.ts";
import {
  createEmptyDatabase,
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

/**
 * The one-time model-settings cutover over a populated pre-cutover database.
 * Fixtures use the historical SQL shape, never today's authoring APIs or
 * catalog defaults. The rollback and retained rows are observed through SQL;
 * the committed cutover uses the same migration runner as application boot.
 */
const UNDER_TEST = "0008_model_settings_and_versioning.sql";
const sharedPersona = "prs_01M0E4EVJ6ECGVJEA4NSBTC0CC";
const sharedExpected = "grl_01M01MH8KAE8ZB19B0YJ7Z7EYW";
const sharedLatency = "grl_01M0TQE5HBE1X9PDN9HFJC987Q";
const organization = newId("org");
const otherOrganization = newId("org");
const project = newId("prj");
const siblingProject = newId("prj");
const foreignProject = newId("prj");
const user = newId("usr");
const agent = newId("agt");
const connection = newId("con");
const suite = newId("ste");
const test = newId("tst");
const testVersion = newId("tstv");
const customPersona = { id: newId("prs"), v1: newId("prsv"), v2: newId("prsv") };
const archivedPersona = { id: newId("prs"), version: newId("prsv") };
const legacyCustomGrader = newId("grl");
const codeAssociation = newId("grd");
const legacyRun = newId("run");
const legacySimulation = newId("sim");

// These are this migration's fixed initialization values. A future catalog
// release must not change what an old migration writes on a fresh deployment.
const CANONICAL_SETTINGS = {
  llm_provider: "openai",
  llm_model: "gpt-5.6-terra",
  stt_provider: "openai",
  stt_model: "gpt-live-transcribe",
  tts_provider: "cartesia",
  tts_model: "sonic-3.5",
  tts_voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
  tts_speed: 1,
};
const CODE_CONTRACT = [{
  key: "maximum_response_time_ms", label: "Maximum response time (p90)",
  valueType: "integer", defaultValue: 3000, unit: "milliseconds",
  minimum: 0, maximum: 60000,
}];
const CODE_SETTINGS = { maximum_response_time_ms: 1234 };
const SCOPE = { simulations: [{ kind: "all" }], production: null };
const RETAINED_TABLES = [
  "organization", "organization_settings", "project", "user", "membership",
  "api_key", "agent", "connection", "test_suite", "test", "test_version", "test_persona",
] as const;
const LEGACY_TABLES = [
  ...RETAINED_TABLES, "persona", "persona_version", "grader_definition",
  "grader_definition_version", "project_grader", "run", "simulation",
  "run_event", "grading_plan", "grading_job", "idempotent_operation",
] as const;

let database: EmptyDatabase;
let store: SingleConnection;
let migrationDirectory: string | undefined;
let legacyRows: Record<string, unknown[]>;
let rolledBackRows: Record<string, unknown[]>;
let applied: readonly string[];

async function rowsOf(table: string): Promise<unknown[]> {
  // Callers name fixed tables above, not user input.
  const { rows } = await store.sql<{ value: unknown }>(
    `select to_jsonb(held) as value from "${table}" held order by to_jsonb(held)::text`,
  );
  return rows.map((row) => row.value);
}

async function readTables(tables: readonly string[]): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) rows[table] = await rowsOf(table);
  return rows;
}

async function refuses(
  statement: string,
  values: readonly unknown[] = [],
  code: string = POSTGRES_ERROR.checkViolation,
): Promise<void> {
  await expect(store.sql(statement, values)).rejects.toSatisfy((error) => errorCodeOf(error) === code);
}

async function seedOldRows(): Promise<void> {
  await store.sql("insert into organization (id,name,slug) values ($1,'Kept organization','kept'),($2,'Other organization','other')", [organization, otherOrganization]);
  await store.sql("insert into organization_settings (organization_id,retention_days,data_residency) values ($1,30,'us')", [organization]);
  for (const [id, owner, name] of [[project, organization, "first"], [siblingProject, organization, "sibling"], [foreignProject, otherOrganization, "foreign"]]) {
    await store.sql("insert into project (id,organization_id,name,slug,revision) values ($1,$2,$3,$3,$4)", [id, owner, name, newId("rev")]);
  }
  await store.sql('insert into "user" (id,email) values ($1,\'migration-test@example.test\')', [user]);
  await store.sql("insert into membership (id,organization_id,user_id,role) values ($1,$2,$3,'admin')", [newId("mbr"), organization, user]);
  // Fake opaque credential bytes are enough to prove retention. This test does
  // not need a real provider key or the current encryption implementation.
  await store.sql("insert into api_key (id,organization_id,project_id,scope,hash,prefix,display_suffix,created_by_user_id) values ($1,$2,$3,'project','fake-key-hash','egma_sk_','test',$4)", [newId("key"), organization, project, user]);
  await store.sql("insert into agent (id,organization_id,project_id,name,agent_platform,monitoring_api_key,monitoring_api_key_hint) values ($1,$2,$3,'Kept agent','retell','fake-sealed-monitoring-key','test')", [agent, organization, project]);
  await store.sql("insert into connection (id,organization_id,project_id,agent_id,name,connection_type,access_variant,modality,topology,config,credentials,credentials_hint) values ($1,$2,$3,$4,'Kept connection','retell_chat_api','retell_chat_api.api_key','chat','hosted-broker','{\"retellAgentId\":\"agent_kept\"}','fake-sealed-connection-key','test')", [connection, organization, project, agent]);

  await store.sql("begin");
  await store.sql("insert into persona (id,organization_id,project_id,name,current_version_id) values ($1,$2,$3,'Kept custom',$4),($5,$2,$6,'Kept archived',$7)", [customPersona.id, organization, project, customPersona.v2, archivedPersona.id, siblingProject, archivedPersona.version]);
  for (const [id, personaId, version, personality] of [
    [customPersona.v1, customPersona.id, 1, "Original behavior."],
    [customPersona.v2, customPersona.id, 2, "Current behavior."],
    [archivedPersona.version, archivedPersona.id, 1, "Archived behavior."],
  ]) {
    await store.sql(`insert into persona_version
      (id,persona_id,version,identity_name,personality,language,llm_provider,llm_model,
       stt_provider,stt_model,tts_provider,tts_model,tts_voice_id,tts_speed)
      values ($1,$2,$3,'Sam',$4,'en-US','openai','old-llm','deepgram','old-stt',
        'cartesia','old-tts','old-voice',0.8)`, [id, personaId, version, personality]);
  }
  await store.sql("commit");
  await store.sql("update persona set archived_at='2026-08-01T00:00:00Z' where id=$1", [archivedPersona.id]);

  await store.sql("insert into test_suite (id,organization_id,project_id,name) values ($1,$2,$3,'Kept suite')", [suite, organization, project]);
  await store.sql("begin");
  await store.sql("insert into test (id,organization_id,project_id,suite_id,name,current_version_id,revision) values ($1,$2,$3,$4,'Kept test',$5,$6)", [test, organization, project, suite, testVersion, newId("rev")]);
  await store.sql(`insert into test_version (id,test_id,version,content,mock_tools,env)
    values ($1,$2,1,'{"scenario":"Ask about an appointment.","expectedBehaviors":["Answers clearly."]}',
      '[{"tool":"calendar","answer":{"slots":[]}}]','{"retell_dynamic_variables":{"caller":"Sam"}}')`, [testVersion, test]);
  await store.sql("insert into test_persona (test_version_id,persona_id,position) values ($1,$2,1),($1,$3,2)", [testVersion, sharedPersona, customPersona.id]);
  await store.sql("commit");

  await store.sql("begin");
  for (const [id, owner, type, contract] of [
    [sharedExpected, null, "llm_as_judge", []],
    [sharedLatency, null, "code", CODE_CONTRACT],
    [legacyCustomGrader, organization, "llm_as_judge", []],
  ]) {
    await store.sql("insert into grader_definition (id,organization_id,name,scope_editable) values ($1,$2,$3,true)", [id, owner, type === "code" ? "Response latency" : "Expected behaviors"]);
    await store.sql("insert into grader_definition_version (definition_id,version,type,prompt,parameter_contract,modalities,judge_model) values ($1,1,$2,$3,$4,'[\"chat\",\"voice\"]',$5)", [id, type, type === "code" ? null : "Old prompt", JSON.stringify(contract), type === "code" ? null : '{"provider":"openai","model":"old-model"}']);
  }
  await store.sql("commit");
  for (const [id, definition, projectId, settings] of [
    [codeAssociation, sharedLatency, project, CODE_SETTINGS],
    [newId("grd"), sharedExpected, project, {}],
    [newId("grd"), legacyCustomGrader, project, {}],
    [newId("grd"), sharedLatency, siblingProject, {}],
  ]) {
    await store.sql("insert into project_grader (id,organization_id,project_id,grader_definition_id,scope,parameter_values,pass_threshold) values ($1,$2,$3,$4,$5,$6,0.8)", [id, organization, projectId, definition, JSON.stringify(SCOPE), JSON.stringify(settings)]);
  }
  await store.sql("insert into run (id,organization_id,project_id,suite_id,agent_id,connection_id,status,triggered_via,connection_snapshot,expected_simulation_count) values ($1,$2,$3,$4,$5,$6,'pending','manual','{}',1)", [legacyRun, organization, project, suite, agent, connection]);
  await store.sql("insert into simulation (id,run_id,organization_id,project_id,agent_id,connection_id,persona_id,persona_version_id,test_id,test_version_id,position,modality,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'chat','queued')", [legacySimulation, legacyRun, organization, project, agent, connection, customPersona.id, customPersona.v2, test, testVersion]);
  await store.sql("insert into run_event (run_id,seq,organization_id,project_id,kind,status) values ($1,1,$2,$3,'run','pending')", [legacyRun, organization, project]);
  await store.sql("insert into grading_plan (id,run_id,organization_id,project_id,state,captured_at,groups) values ($1,$2,$3,$4,'run_start',now(),'[]')", [`gpl_${newId("run").slice(4)}`, legacyRun, organization, project]);
  await store.sql("insert into grading_job (id,organization_id,project_id,source,simulation_id,trace_id,trace_started_at,run_id,entries,status) values ($1,$2,$3,'simulation',$4,'legacy-trace',now(),$5,'[{\"parameterValues\":{}}]','pending')", [newId("gjb"), organization, project, legacySimulation, legacyRun]);
  await store.sql("insert into idempotent_operation (organization_id,project_id,actor_id,operation,idempotency_key,request_digest,result_id) values ($1,$2,$3,'start_run','migration-proof','digest',$4)", [organization, project, user, legacyRun]);
}

beforeAll(async () => {
  database = await createEmptyDatabase("model_settings_migration");
  migrationDirectory = await mkdtemp(path.join(tmpdir(), "egma-before-model-settings-"));
  const earlier = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && name < UNDER_TEST).sort();
  expect(earlier).toContain("0000_baseline.sql");
  expect(earlier).toContain("0007_test_owned_mock_tools.sql");
  for (const name of earlier) await cp(path.join(MIGRATIONS_DIRECTORY, name), path.join(migrationDirectory, name));
  await runMigrations(database.url, migrationDirectory);
  store = await openSingleConnection(database.url);
  await seedOldRows();
  legacyRows = await readTables(LEGACY_TABLES);

  const migration = await readFile(path.join(MIGRATIONS_DIRECTORY, UNDER_TEST), "utf8");
  await store.sql("begin");
  try {
    await store.sql(migration);
  } finally {
    await store.sql("rollback");
  }
  rolledBackRows = await readTables(LEGACY_TABLES);
  await cp(path.join(MIGRATIONS_DIRECTORY, UNDER_TEST), path.join(migrationDirectory, UNDER_TEST));
  ({ applied } = await runMigrations(database.url, migrationDirectory));
});

afterAll(async () => {
  await store?.sql("rollback").catch(() => undefined);
  await store?.close();
  await database?.drop();
  if (migrationDirectory !== undefined) await rm(migrationDirectory, { recursive: true, force: true });
});

describe("the model settings migration over existing work", () => {
  it("rolls back the complete cutover, then records exactly one migration on commit", async () => {
    expect(rolledBackRows).toEqual(legacyRows);
    expect(applied).toEqual([UNDER_TEST]);
    expect((await runMigrations(database.url, migrationDirectory)).applied).toEqual([]);
  });

  it("keeps tenancy, credentials, connections and authored tests byte-for-byte", async () => {
    for (const table of RETAINED_TABLES) expect(await rowsOf(table), table).toEqual(legacyRows[table]);
  });

  it("keeps all persona identities and historical behavior versions", async () => {
    expect(await rowsOf("persona_definition")).toEqual(legacyRows.persona);
    const { rows } = await store.sql<{ value: Record<string, unknown> }>(
      "select to_jsonb(v) - 'parameter_contract' as value from persona_definition_version v order by id",
    );
    const oldVersions = legacyRows.persona_version as Record<string, unknown>[];
    const withoutModels = oldVersions.map((old) => Object.fromEntries(Object.entries(old)
      .filter(([key]) => !(key in CANONICAL_SETTINGS))))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(rows.map((row) => row.value)).toEqual(withoutModels);
  });

  it("keeps shared grader cores and valid code policy, clearing incompatible ownership and settings", async () => {
    const { rows: definitions } = await store.sql("select id,project_id from grader_definition order by id");
    expect(definitions).toEqual([sharedExpected, sharedLatency].sort().map((id) => ({ id, project_id: null })));
    const oldVersions = legacyRows.grader_definition_version as Record<string, unknown>[];
    const retained = oldVersions.filter((row) => row.definition_id !== legacyCustomGrader)
      .map(({ judge_model: _removed, ...row }) => row)
      .sort((a, b) => String(a.definition_id).localeCompare(String(b.definition_id)));
    const { rows: versions } = await store.sql<{ value: unknown }>(
      "select to_jsonb(v) as value from grader_definition_version v order by definition_id,version",
    );
    expect(versions.map((row) => row.value)).toEqual(retained);
    const oldPolicies = legacyRows.project_grader as Record<string, unknown>[];
    expect(await rowsOf("project_grader")).toEqual(oldPolicies.filter((row) => row.id === codeAssociation));
  });

  it("clears disposable execution and its receipts without leaving obsolete tables", async () => {
    for (const table of ["run", "simulation", "run_event", "grading_job", "idempotent_operation"]) {
      expect(await rowsOf(table), table).toEqual([]);
    }
    const { rows } = await store.sql("select to_regclass('persona') as persona,to_regclass('persona_version') as version,to_regclass('grading_plan') as plan");
    expect(rows).toEqual([{ persona: null, version: null, plan: null }]);
  });

  it("initializes complete settings once for custom and selected shared personas", async () => {
    const { rows } = await store.sql<{ id: string; project_id: string; persona_definition_id: string; parameter_values: unknown }>(
      "select id,project_id,persona_definition_id,parameter_values from project_persona order by project_id,persona_definition_id",
    );
    expect(rows.map(({ id: _id, ...row }) => row)).toEqual([
      { project_id: project, persona_definition_id: sharedPersona, parameter_values: CANONICAL_SETTINGS },
      { project_id: project, persona_definition_id: customPersona.id, parameter_values: CANONICAL_SETTINGS },
      { project_id: siblingProject, persona_definition_id: archivedPersona.id, parameter_values: CANONICAL_SETTINGS },
    ].sort((a, b) => a.project_id.localeCompare(b.project_id) || a.persona_definition_id.localeCompare(b.persona_definition_id)));
    for (const row of rows) expect(row.id).toMatch(/^ppr_[0-9A-HJKMNP-TV-Z]{26}$/);
    const { rows: contracts } = await store.sql<{ defaults: unknown }>(`select
      (select jsonb_object_agg(item->>'key',item->'defaultValue') from jsonb_array_elements(parameter_contract) item) as defaults
      from persona_definition_version`);
    for (const row of contracts) expect(row.defaults).toEqual(CANONICAL_SETTINGS);
  });

  it("leaves all constraints validated and all user triggers enabled", async () => {
    expect((await store.sql("select conname from pg_constraint where connamespace='public'::regnamespace and not convalidated")).rows).toEqual([]);
    expect((await store.sql("select tgname from pg_trigger where not tgisinternal and tgenabled='D'")).rows).toEqual([]);
  });
});

describe("the migrated settings and execution guards", () => {
  it.each([
    ["missing key", { ...CANONICAL_SETTINGS, llm_model: undefined }],
    ["unknown key", { ...CANONICAL_SETTINGS, unexpected: true }],
    ["wrong type", { ...CANONICAL_SETTINGS, tts_speed: "1" }],
    ["below the speed range", { ...CANONICAL_SETTINGS, tts_speed: 0.59 }],
    ["above the speed range", { ...CANONICAL_SETTINGS, tts_speed: 1.51 }],
    ["empty voice", { ...CANONICAL_SETTINGS, tts_voice_id: " " }],
  ])("refuses persona settings with %s", async (_label, values) => {
    await refuses("update project_persona set parameter_values=$1 where persona_definition_id=$2", [JSON.stringify(values), customPersona.id]);
  });

  it("accepts a custom nonempty voice without a second provider registry", async () => {
    const values = { ...CANONICAL_SETTINGS, tts_voice_id: "customer-defined-voice" };
    await store.sql("update project_persona set parameter_values=$1 where persona_definition_id=$2", [JSON.stringify(values), customPersona.id]);
    const { rows } = await store.sql("select parameter_values from project_persona where persona_definition_id=$1", [customPersona.id]);
    expect(rows).toEqual([{ parameter_values: values }]);
  });

  it("refuses ownership changes and cross-project persona associations", async () => {
    await refuses("update project_persona set project_id=$1 where persona_definition_id=$2", [siblingProject, customPersona.id]);
    for (const [owner, projectId, personaId] of [[organization, siblingProject, customPersona.id], [organization, foreignProject, sharedPersona]]) {
      await refuses("insert into project_persona (id,organization_id,project_id,persona_definition_id,parameter_values) values ($1,$2,$3,$4,$5)", [newId("ppr"), owner, projectId, personaId, JSON.stringify(CANONICAL_SETTINGS)], POSTGRES_ERROR.foreignKeyViolation);
    }
    await refuses("update grader_definition set organization_id=$1,project_id=$2 where id=$3", [organization, project, sharedExpected]);
    await refuses("insert into grader_definition (id,organization_id,name,scope_editable) values ($1,$2,'Half owner',true)", [newId("grl"), organization]);
  });

  it("refuses invalid numeric grader settings and changes to saved core meaning", async () => {
    for (const values of [{}, { maximum_response_time_ms: 1.5 }, { maximum_response_time_ms: -1 }, { maximum_response_time_ms: "1234" }]) {
      await refuses("update project_grader set parameter_values=$1 where id=$2", [JSON.stringify(values), codeAssociation]);
    }
    await refuses("update persona_definition_version set personality='Changed' where id=$1", [customPersona.v1]);
    await refuses("insert into persona_definition_version (id,persona_id,version,identity_name,personality,language,parameter_contract) values ($1,$2,99,'Sam','Plain','en-US','[]')", [newId("prsv"), customPersona.id]);
    await refuses("update grader_definition_version set prompt='Changed' where definition_id=$1", [sharedExpected], POSTGRES_ERROR.raiseException);
  });

  it("requires a complete run plan at insertion and freezes selection while claims and retries advance", async () => {
    const runId = newId("run");
    const simulationId = newId("sim");
    const jobId = newId("gjb");
    const entry = {
      projectGraderId: codeAssociation, graderDefinitionId: sharedLatency,
      graderDefinitionVersion: 1, graderPassThreshold: 0.8, parameterValues: CODE_SETTINGS,
      definition: { definitionId: sharedLatency, definitionVersion: 1, type: "code", prompt: null, parameterContract: CODE_CONTRACT, modalities: ["chat", "voice"] },
    };
    const plan = { capturedAt: "2026-09-01T00:00:00.000Z", groups: [{
      tag: "test", testId: test, testVersionId: testVersion,
      items: [{ kind: "project_grader", projectGraderId: codeAssociation,
        graderDefinitionId: sharedLatency, graderDefinitionVersion: 1,
        graderName: "Response latency", passThreshold: 0.8,
        parameterValues: CODE_SETTINGS, definition: entry.definition }],
    }] };
    const insertRun = `insert into run (id,organization_id,project_id,suite_id,agent_id,connection_id,
      status,triggered_via,connection_snapshot,expected_simulation_count,grading_plan)
      values ($1,$2,$3,$4,$5,$6,'pending','manual','{}',1,$7)`;
    const runValues = [runId, organization, project, suite, agent, connection];
    await refuses(insertRun, [...runValues, null]);
    await refuses(insertRun, [...runValues, "{}"]);
    await store.sql(insertRun, [...runValues, JSON.stringify(plan)]);
    await refuses("update run set grading_plan=$1 where id=$2", [JSON.stringify({ ...plan, groups: [] }), runId]);
    await store.sql(`insert into simulation (id,run_id,organization_id,project_id,agent_id,connection_id,
      persona_id,persona_version_id,test_id,test_version_id,position,modality,status,persona_parameter_values)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'chat','queued',$11)`,
    [simulationId, runId, organization, project, agent, connection, customPersona.id, customPersona.v2, test, testVersion, JSON.stringify(CANONICAL_SETTINGS)]);
    await refuses("update simulation set persona_parameter_values='{}' where id=$1", [simulationId]);
    await refuses("update simulation set persona_version_id=$1 where id=$2", [customPersona.v1, simulationId]);
    await store.sql("update simulation set status='claimed',claimed_by='worker',claimed_at=now(),heartbeat_at=now() where id=$1", [simulationId]);
    expect((await store.sql("select status,persona_parameter_values from simulation where id=$1", [simulationId])).rows)
      .toEqual([{ status: "claimed", persona_parameter_values: CANONICAL_SETTINGS }]);

    await store.sql("insert into grading_job (id,organization_id,project_id,source,trace_id,trace_started_at,entries,status) values ($1,$2,$3,'production','new-trace',now(),$4,'pending')", [jobId, organization, project, JSON.stringify([entry])]);
    await refuses("update grading_job set entries=$1 where id=$2", [JSON.stringify([{ ...entry, parameterValues: {} }]), jobId]);
    await store.sql("update grading_job set status='claimed',claimed_by='grader',claimed_at=now(),heartbeat_at=now(),attempts=attempts+1 where id=$1", [jobId]);
    await store.sql("update grading_job set status='pending',claimed_by=null,claimed_at=null,heartbeat_at=null where id=$1", [jobId]);
    expect((await store.sql("select status,attempts,entries from grading_job where id=$1", [jobId])).rows)
      .toEqual([{ status: "pending", attempts: 1, entries: [entry] }]);
    expect((await store.sql("select grading_plan from run where id=$1", [runId])).rows).toEqual([{ grading_plan: plan }]);
  });
});

describe("the retired Response latency parameter", () => {
  it("discards an old valid association while retaining the shared core and its version", async () => {
    const oldDatabase = await createEmptyDatabase("old_latency_settings_migration");
    let oldStore: SingleConnection | undefined;
    let oldDirectory: string | undefined;
    const oldContract = CODE_CONTRACT.map((parameter) => ({
      ...parameter,
      key: "maximum_average_response_time_ms",
      label: "Maximum average response time",
    }));
    const oldSettings = { maximum_average_response_time_ms: 1234 };
    try {
      oldDirectory = await mkdtemp(path.join(tmpdir(), "egma-before-old-latency-"));
      const earlier = (await readdir(MIGRATIONS_DIRECTORY))
        .filter((name) => name.endsWith(".sql") && name < UNDER_TEST).sort();
      for (const name of earlier) await cp(path.join(MIGRATIONS_DIRECTORY, name), path.join(oldDirectory, name));
      await runMigrations(oldDatabase.url, oldDirectory);
      oldStore = await openSingleConnection(oldDatabase.url);
      await oldStore.sql("insert into organization (id,name,slug) values ($1,'Old latency organization','old-latency')", [organization]);
      await oldStore.sql("insert into project (id,organization_id,name,slug,revision) values ($1,$2,'Old latency project','old-latency',$3)", [project, organization, newId("rev")]);
      await oldStore.sql("begin");
      await oldStore.sql("insert into grader_definition (id,name,scope_editable) values ($1,'Response latency',true)", [sharedLatency]);
      await oldStore.sql("insert into grader_definition_version (definition_id,version,type,prompt,parameter_contract,modalities,judge_model) values ($1,1,'code',null,$2,'[\"chat\",\"voice\"]',null)", [sharedLatency, JSON.stringify(oldContract)]);
      await oldStore.sql("commit");
      await oldStore.sql("insert into project_grader (id,organization_id,project_id,grader_definition_id,scope,parameter_values,pass_threshold) values ($1,$2,$3,$4,$5,$6,0.8)", [codeAssociation, organization, project, sharedLatency, JSON.stringify(SCOPE), JSON.stringify(oldSettings)]);

      // This is not a malformed-settings cleanup: the old integer value has
      // the exact declared key and satisfies that installed core's bounds.
      const { rows: before } = await oldStore.sql(`select
        pg.parameter_values = jsonb_build_object(v.parameter_contract->0->>'key', 1234)
        and v.parameter_contract->0->>'valueType' = 'integer'
        and jsonb_typeof(pg.parameter_values->'maximum_average_response_time_ms') = 'number'
        and 1234 between (v.parameter_contract->0->>'minimum')::numeric
          and (v.parameter_contract->0->>'maximum')::numeric as matches_contract
        from project_grader pg join grader_definition_version v
          on v.definition_id=pg.grader_definition_id and v.version=1
        where pg.id=$1`, [codeAssociation]);
      expect(before).toEqual([{ matches_contract: true }]);

      await cp(path.join(MIGRATIONS_DIRECTORY, UNDER_TEST), path.join(oldDirectory, UNDER_TEST));
      expect((await runMigrations(oldDatabase.url, oldDirectory)).applied).toEqual([UNDER_TEST]);
      expect((await oldStore.sql("select id from project_grader")).rows).toEqual([]);
      const { rows: retained } = await oldStore.sql(`select d.id,d.current_definition_version,v.version,v.parameter_contract
        from grader_definition d join grader_definition_version v on v.definition_id=d.id`);
      expect(retained).toEqual([{
        id: sharedLatency, current_definition_version: 1, version: 1, parameter_contract: oldContract,
      }]);
    } finally {
      await oldStore?.sql("rollback").catch(() => undefined);
      await oldStore?.close();
      await oldDatabase.drop();
      if (oldDirectory !== undefined) await rm(oldDirectory, { recursive: true, force: true });
    }
  });
});
