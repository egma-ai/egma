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
const SEPARATOR = "--> statement-breakpoint";
const migrationPath = path.join(CLICKHOUSE_MIGRATIONS_DIRECTORY, BASELINE);
const migration = await readFile(migrationPath, "utf8");
const statements = migration
  .split(SEPARATOR)
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

function columnsOf(
  store: MigratedTraceStore,
  table: "grades" | "production_grading_plans",
) {
  return store.rows<Column>(`select name,type,default_kind,default_expression
    from system.columns where database=currentDatabase() and table='${table}' order by position`);
}

async function appendProductionReceipt(
  store: MigratedTraceStore,
): Promise<void> {
  await store.command(`insert into production_grading_plans
    (organization_id,project_id,trace_id,trace_started_at,plan_hash,entries)
    values ('organization','project','${TRACE}','2026-09-01 00:00:00.000000',
      '${"a".repeat(32)}',[('project-grader','shared-grader',1,0.8,'{}')])`);
}

async function seedCurrentRows(store: MigratedTraceStore): Promise<void> {
  const span = {
    organization_id: "organization",
    project_id: "project",
    trace_id: TRACE,
    source: "production",
    emitter: "agent",
    environment: "test",
    started_at: "2026-09-01 00:00:00.000000",
    duration_ns: "1000000000",
    agent_platform: "retell",
    connection_type: "retell_chat_api",
    provider_call_id: "kept-call",
    payload: "{}",
    usage_identity_hash: "evidence",
    usage_received_at: "2026-09-01 00:00:01.000000",
    usage_occurred_at: "2026-09-01 00:00:00.000000",
    usage_provider: "openai",
    usage_model: "chosen-model",
    usage_payment_source: "platform",
    usage_quantities: { tokens: 10 },
    usage_priced_by: { tokens: "price-current" },
    usage_amount_micros: 100,
  };
  await store.append("spans", [
    {
      ...span,
      span_id: ROOT_SPAN,
      parent_span_id: "",
      kind: "conversation",
      name: "conversation",
      text: "",
    },
    {
      ...span,
      span_id: "2222222222222222",
      parent_span_id: ROOT_SPAN,
      kind: "turn:persona",
      name: "caller",
      text: "Can I book an appointment?",
    },
    {
      ...span,
      span_id: "3333333333333333",
      parent_span_id: ROOT_SPAN,
      kind: "turn:agent",
      name: "agent",
      text: "Yes. Which day works for you?",
    },
  ]);
  await store.append("grades", [
    {
      ...GRADE,
      parameter_values: JSON.stringify({
        llm_provider: "openai",
        llm_model: "chosen-model",
      }),
    },
  ]);
  await appendProductionReceipt(store);
}

/** An interrupted baseline has no ledger row, so every completed prefix must replay safely. */
describe.each(boundaries)(
  "ClickHouse baseline after %i completed statements",
  (completed) => {
    it("creates the current schema and resumes without losing current data", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "egma-clickhouse-baseline-"),
      );
      let store: MigratedTraceStore | undefined;
      try {
        store = await createMigratedTraceStore(
          `ch_baseline_${completed}`,
          directory,
        );
        const interruption = `baseline proof stopped after ${completed} statements`;
        await writeFile(
          path.join(directory, BASELINE),
          [
            ...statements.slice(0, completed),
            `SELECT throwIf(1, '${interruption}');`,
          ].join(`\n${SEPARATOR}\n`),
        );
        await expect(
          runClickHouseMigrations(store.url, directory),
        ).rejects.toMatchObject({
          cause: { message: expect.stringContaining(interruption) },
        });
        expect(
          await store.rows("select name from egma_meta_migration final"),
        ).toEqual([]);
        if (completed === statements.length) await seedCurrentRows(store);
        await cp(migrationPath, path.join(directory, BASELINE));
        expect(
          (await runClickHouseMigrations(store.url, directory)).applied,
        ).toEqual([BASELINE]);
        if (completed !== statements.length) await seedCurrentRows(store);
        expect(
          await store.rows("select name from egma_meta_migration final"),
        ).toEqual([{ name: BASELINE }]);
        expect(
          (await columnsOf(store, "grades")).find(
            (column) => column.name === "parameter_values",
          ),
        ).toEqual({
          name: "parameter_values",
          type: "String",
          default_kind: "",
          default_expression: "",
        });
        expect(
          await store.rows(
            "select sorting_key,primary_key,partition_key from system.tables where database=currentDatabase() and name='spans'",
          ),
        ).toEqual([
          {
            sorting_key:
              "organization_id, project_id, trace_id, span_id, usage_identity_hash, usage_received_at",
            primary_key: "organization_id, project_id, trace_id",
            partition_key: "toYYYYMM(started_at)",
          },
        ]);
        const spans = await store.rows(
          "select * from spans final order by span_id",
        );
        const turns = await store.rows(
          "select * from turns final order by span_id",
        );
        const grades = await store.rows("select * from grades");
        const plans = await store.rows(
          "select * from production_grading_plans",
        );
        expect(spans).toHaveLength(3);
        expect(turns).toHaveLength(2);
        expect(grades).toHaveLength(1);
        expect(plans).toHaveLength(1);
        expect(
          (await runClickHouseMigrations(store.url, directory)).applied,
        ).toEqual([]);
        expect(
          await store.rows("select * from spans final order by span_id"),
        ).toEqual(spans);
        expect(
          await store.rows("select * from turns final order by span_id"),
        ).toEqual(turns);
        expect(await store.rows("select * from grades")).toEqual(grades);
        expect(
          await store.rows("select * from production_grading_plans"),
        ).toEqual(plans);
        await store.append("spans", [
          {
            organization_id: "organization",
            project_id: "project",
            trace_id: TRACE,
            span_id: "4444444444444444",
            parent_span_id: ROOT_SPAN,
            started_at: "2026-09-01 00:00:03.000000",
            kind: "turn:persona",
            text: "Tuesday, please.",
          },
        ]);
        expect(
          await store.rows(
            "select text_preview from turns final where span_id='4444444444444444'",
          ),
        ).toEqual([{ text_preview: "Tuesday, please." }]);
      } finally {
        await store?.drop();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
