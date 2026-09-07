import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLICKHOUSE_MIGRATIONS_DIRECTORY,
  runClickHouseMigrations,
} from "../src/clickhouse/migrate.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";

const BASELINE = "0000_baseline.sql";
const UNDER_TEST = "0001_executed_grade_settings.sql";
const SEPARATOR = "--> statement-breakpoint";
const migrationPath = path.join(CLICKHOUSE_MIGRATIONS_DIRECTORY, UNDER_TEST);
const migration = await readFile(migrationPath, "utf8");
const statements = migration.split(SEPARATOR)
  .filter((statement) => statement.replace(/--[^\n]*/g, "").trim() !== "");
const boundaries = Array.from({ length: statements.length + 1 }, (_, at) => at);

const TRACE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT_SPAN = "1111111111111111";
const GRADE = {
  organization_id: "organization",
  project_id: "project",
  source: "production",
  trace_id: TRACE,
  trace_started_at: "2026-09-01 00:00:00.000000",
  run_id: "",
  project_grader_id: "project-grader",
  grader_definition_id: "shared-grader",
  grader_definition_version: 1,
  score: 1,
  details: { rationale: "The agent answered clearly." },
  grader_pass_threshold: 0.8,
  grading_sequence: 1,
  graded_at: "2026-09-01 00:01:00.000000",
};

type Column = {
  readonly name: string;
  readonly type: string;
  readonly default_kind: string;
  readonly default_expression: string;
};

function columnsOf(store: MigratedTraceStore, table: "grades" | "production_grading_plans") {
  return store.rows<Column>(`select name,type,default_kind,default_expression
    from system.columns where database=currentDatabase() and table='${table}' order by position`);
}

async function appendProductionReceipt(store: MigratedTraceStore): Promise<void> {
  await store.command(`insert into production_grading_plans
    (organization_id,project_id,trace_id,trace_started_at,plan_hash,entries)
    values ('organization','project','${TRACE}','2026-09-01 00:00:00.000000',
      '${"a".repeat(32)}',[('project-grader','shared-grader',1,0.8,'{}')])`);
}

async function seedOldRows(store: MigratedTraceStore): Promise<void> {
  const span = {
    organization_id: "organization", project_id: "project", trace_id: TRACE,
    source: "production", emitter: "agent", environment: "test",
    started_at: "2026-09-01 00:00:00.000000", duration_ns: "1000000000",
    agent_platform: "retell", connection_type: "retell_chat_api",
    provider_call_id: "kept-call", payload: "{}",
  };
  await store.append("spans", [
    { ...span, span_id: ROOT_SPAN, parent_span_id: "", kind: "conversation", name: "conversation", text: "" },
    { ...span, span_id: "2222222222222222", parent_span_id: ROOT_SPAN, kind: "turn:persona", name: "caller", text: "Can I book an appointment?" },
    { ...span, span_id: "3333333333333333", parent_span_id: ROOT_SPAN, kind: "turn:agent", name: "agent", text: "Yes. Which day works for you?" },
  ]);
  await store.append("grades", [GRADE]);
  await appendProductionReceipt(store);
}

/**
 * ClickHouse records a migration only after its last statement. A failed boot
 * can therefore leave any prefix applied, including the entire SQL file with
 * no ledger entry. Each case builds that state through the real runner, then
 * retries the unchanged release file against populated historical storage.
 */
describe.each(boundaries)("executed grade settings after %i completed statements", (completed) => {
  it("resumes the cutover and keeps trace evidence and later writes intact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "egma-grade-settings-migration-"));
    let store: MigratedTraceStore | undefined;
    try {
      await cp(path.join(CLICKHOUSE_MIGRATIONS_DIRECTORY, BASELINE), path.join(directory, BASELINE));
      store = await createMigratedTraceStore(`grade_settings_boundary_${completed}`, directory);
      await seedOldRows(store);
      const spansBefore = await store.rows("select * from spans final order by span_id");
      const turnsBefore = await store.rows("select * from turns final order by span_id");
      expect(spansBefore).toHaveLength(3);
      expect(turnsBefore).toHaveLength(2);
      expect(await store.rows("select toUInt32(count()) as count from grades")).toEqual([{ count: 1 }]);
      expect(await store.rows("select toUInt32(count()) as count from production_grading_plans")).toEqual([{ count: 1 }]);
      const gradeColumns = await columnsOf(store, "grades");
      const receiptColumns = await columnsOf(store, "production_grading_plans");
      expect(gradeColumns.some((column) => column.name === "parameter_values")).toBe(false);

      const interruption = `migration proof stopped after ${completed} statements`;
      await writeFile(path.join(directory, UNDER_TEST), [
        ...statements.slice(0, completed),
        `SELECT throwIf(1, '${interruption}');`,
      ].join(`\n${SEPARATOR}\n`));
      await expect(runClickHouseMigrations(store.url, directory)).rejects.toMatchObject({
        cause: { message: expect.stringContaining(interruption) },
      });
      expect(await store.rows("select name from egma_meta_migration final order by name"))
        .toEqual([{ name: BASELINE }]);

      // The failed file has no recorded hash. A retry sees the release's full
      // contents and must tolerate every statement that already took effect.
      await cp(migrationPath, path.join(directory, UNDER_TEST));
      expect((await runClickHouseMigrations(store.url, directory)).applied).toEqual([UNDER_TEST]);
      expect(await store.rows("select toUInt32(count()) as count from grades")).toEqual([{ count: 0 }]);
      expect(await store.rows("select toUInt32(count()) as count from production_grading_plans")).toEqual([{ count: 0 }]);
      expect(await store.rows("select * from spans final order by span_id")).toEqual(spansBefore);
      expect(await store.rows("select * from turns final order by span_id")).toEqual(turnsBefore);
      expect(await columnsOf(store, "production_grading_plans")).toEqual(receiptColumns);
      const migratedColumns = await columnsOf(store, "grades");
      expect(migratedColumns.filter((column) => column.name !== "parameter_values")).toEqual(gradeColumns);
      expect(migratedColumns.find((column) => column.name === "parameter_values"))
        .toEqual({ name: "parameter_values", type: "String", default_kind: "", default_expression: "" });

      const parameters = JSON.stringify({ llm_provider: "openai", llm_model: "chosen-model" });
      await store.append("grades", [
        { ...GRADE, parameter_values: parameters },
        { ...GRADE, grading_sequence: 2, score: null, details: { error: "The provider timed out." }, parameter_values: parameters },
      ]);
      await appendProductionReceipt(store);
      const newGrades = await store.rows("select grading_sequence,score,parameter_values from grades order by grading_sequence");
      expect(newGrades).toEqual([
        { grading_sequence: 1, score: 1, parameter_values: parameters },
        { grading_sequence: 2, score: null, parameter_values: parameters },
      ]);
      const newReceipt = await store.rows("select * from production_grading_plans");
      expect(newReceipt).toHaveLength(1);
      expect((await runClickHouseMigrations(store.url, directory)).applied).toEqual([]);
      expect(await store.rows("select grading_sequence,score,parameter_values from grades order by grading_sequence")).toEqual(newGrades);
      expect(await store.rows("select * from production_grading_plans")).toEqual(newReceipt);

      // The materialized transcript remains live after the storage cutover.
      await store.append("spans", [{
        organization_id: "organization", project_id: "project", trace_id: TRACE,
        span_id: "4444444444444444", parent_span_id: ROOT_SPAN,
        started_at: "2026-09-01 00:00:03.000000", kind: "turn:persona", text: "Tuesday, please.",
      }]);
      expect(await store.rows("select text_preview from turns final where span_id='4444444444444444'"))
        .toEqual([{ text_preview: "Tuesday, please." }]);
    } finally {
      await store?.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
