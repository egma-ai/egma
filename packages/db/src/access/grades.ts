import { createHash } from "node:crypto";

import { TupleParam } from "@clickhouse/client";

import { traceStore } from "../clickhouse/client.ts";
import { currentGrades } from "../grading/results.ts";
import type { GradeResult } from "../grading/results.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";

export type GradeSource = "simulation" | "production";

export type GradeAssertion = {
  readonly key: string;
  readonly score?: number | undefined;
  readonly rationale?: string | undefined;
  readonly citedSpanIds?: readonly string[] | undefined;
  readonly error?: string | undefined;
};

export type GradeDetails = {
  readonly rationale?: string | undefined;
  readonly assertions?: readonly GradeAssertion[] | undefined;
  readonly error?: string | undefined;
} & Readonly<Record<string, unknown>>;

export type NewGrade = {
  readonly source: GradeSource;
  readonly traceId: string;
  readonly traceStartedAtMicroseconds: bigint;
  readonly runId: string;
  readonly projectGraderId: string;
  readonly graderDefinitionId: string;
  readonly graderDefinitionVersion: number;
  readonly score: number | null;
  readonly details: GradeDetails;
  readonly graderPassThreshold: number;
  /** Internal attempt order. This is not part of the public grade contract. */
  readonly gradingSequence: number;
  readonly gradedAtMicroseconds: bigint;
};

export type RecordedGrade = NewGrade & {
  readonly traceStartedAt: string;
  readonly gradedAt: string;
};

export type CurrentGrade = RecordedGrade & { readonly result: GradeResult };

export type TraceGrades = {
  readonly history: readonly RecordedGrade[];
  readonly current: readonly CurrentGrade[];
};

/** The small part of a current simulation grade needed by batch state reads. */
export type CurrentSimulationGradeFact = {
  readonly traceId: string;
  readonly runId: string;
  readonly projectGraderId: string;
  readonly errored: boolean;
};

export type TraceGradeRef = {
  readonly source: GradeSource;
  readonly traceId: string;
  readonly runId?: string | undefined;
};

export type AppendedGrades = {
  readonly appended: number;
  readonly batches: number;
};

export type ProductionGradingPlanEntry = {
  readonly projectGraderId: string;
  readonly graderDefinitionId: string;
  readonly graderDefinitionVersion: number;
  readonly graderPassThreshold: number;
  readonly parameterValues: Readonly<Record<string, unknown>>;
};

export type NewProductionGradingPlan = {
  readonly traceId: string;
  readonly traceStartedAtMicroseconds: bigint;
  readonly entries: readonly ProductionGradingPlanEntry[];
};

export type ProductionGradingPlan = NewProductionGradingPlan & {
  readonly traceStartedAt: string;
  /** Lowercase hexadecimal SHA-256; ClickHouse stores the raw 32 bytes. */
  readonly planHash: string;
};

export class ProductionGradingPlanConflictError extends Error {
  override readonly name = "ProductionGradingPlanConflictError";
}

const GRADES_TABLE = "grades";
const PRODUCTION_PLANS_TABLE = "production_grading_plans";
const MAXIMUM_ROWS_PER_INSERT = 5_000;
const MILLION = 1_000_000n;

function asDateTime64(microseconds: bigint): string {
  let seconds = microseconds / MILLION;
  let remainder = microseconds % MILLION;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLION;
  }
  const whole = new Date(Number(seconds) * 1_000).toISOString().slice(0, 19);
  return `${whole.replace("T", " ")}.${remainder.toString().padStart(6, "0")}`;
}

function rfc3339(microseconds: bigint): string {
  return `${asDateTime64(microseconds).replace(" ", "T")}Z`;
}

function normalized(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number from 0 through 1`);
  }
}

function validate(grade: NewGrade): void {
  if (grade.score !== null) normalized(grade.score, "score");
  normalized(grade.graderPassThreshold, "graderPassThreshold");
  if (
    !Number.isInteger(grade.graderDefinitionVersion) ||
    grade.graderDefinitionVersion < 1 ||
    grade.graderDefinitionVersion > 0xffff_ffff
  ) {
    throw new RangeError("graderDefinitionVersion must fit UInt32");
  }
  if (
    !Number.isInteger(grade.gradingSequence) ||
    grade.gradingSequence < 1 ||
    grade.gradingSequence > 0xffff_ffff
  ) {
    throw new RangeError("gradingSequence must fit positive UInt32");
  }
  if (grade.score === null && !grade.details.error) {
    throw new TypeError("a null-score grade must include details.error");
  }
  if (grade.source === "simulation" && grade.runId === "") {
    throw new TypeError("a simulation grade must name its run");
  }
  if (grade.source === "production" && grade.runId !== "") {
    throw new TypeError("a production grade cannot name a run");
  }
  for (const assertion of grade.details.assertions ?? []) {
    if (assertion.score !== undefined) normalized(assertion.score, "assertion score");
  }
}

type StoredAssertion = {
  readonly key: string;
  readonly score?: number | undefined;
  readonly rationale?: string | undefined;
  readonly cited_span_ids?: readonly string[] | undefined;
  readonly error?: string | undefined;
};

type StoredDetails = {
  readonly rationale?: string | undefined;
  readonly assertions?: readonly StoredAssertion[] | undefined;
  readonly error?: string | undefined;
  readonly [key: string]: unknown;
};

function storedDetails(details: GradeDetails): StoredDetails {
  return {
    ...details,
    ...(details.assertions === undefined
      ? {}
      : {
          assertions: details.assertions.map(({ citedSpanIds, ...assertion }) => ({
            ...assertion,
            ...(citedSpanIds === undefined ? {} : { cited_span_ids: [...citedSpanIds] }),
          })),
        }),
  };
}

function detailsOf(details: StoredDetails): GradeDetails {
  return {
    ...details,
    ...(details.assertions === undefined
      ? {}
      : {
          assertions: details.assertions.map(({ cited_span_ids, ...assertion }) => ({
            ...assertion,
            ...(cited_span_ids === undefined ? {} : { citedSpanIds: cited_span_ids }),
          })),
        }),
  };
}

function projectOf(auth: AuthContext): string {
  if (auth.projectId === undefined || auth.projectId === "") {
    throw new TypeError("grade access requires a project-scoped context");
  }
  return auth.projectId;
}

function canonicalEntries(
  entries: readonly ProductionGradingPlanEntry[],
): readonly ProductionGradingPlanEntry[] {
  const byProjectGrader = new Set<string>();
  const canonical = entries.map((entry) => ({
    ...entry,
    parameterValues: canonicalParameterValues(entry.parameterValues),
  }));
  for (const entry of canonical) {
    if (entry.projectGraderId === "" || entry.graderDefinitionId === "") {
      throw new TypeError("a production grading-plan entry must name its grader");
    }
    if (byProjectGrader.has(entry.projectGraderId)) {
      throw new TypeError("a production grading plan cannot select one project grader twice");
    }
    byProjectGrader.add(entry.projectGraderId);
    normalized(entry.graderPassThreshold, "graderPassThreshold");
    if (
      !Number.isInteger(entry.graderDefinitionVersion) ||
      entry.graderDefinitionVersion < 1 ||
      entry.graderDefinitionVersion > 0xffff_ffff
    ) {
      throw new RangeError("graderDefinitionVersion must fit UInt32");
    }
  }

  return canonical.sort((left, right) => {
    const leftKey = JSON.stringify([
      left.projectGraderId,
      left.graderDefinitionId,
      left.graderDefinitionVersion,
      left.graderPassThreshold,
      left.parameterValues,
    ]);
    const rightKey = JSON.stringify([
      right.projectGraderId,
      right.graderDefinitionId,
      right.graderDefinitionVersion,
      right.graderPassThreshold,
      right.parameterValues,
    ]);
    return leftKey.localeCompare(rightKey);
  });
}

function canonicalParameterValues(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("production grading-plan settings must be an object");
  }
  const answer = Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, value[key]]),
  );
  const encoded = JSON.stringify(answer);
  if (encoded === undefined) {
    throw new TypeError("production grading-plan settings must be JSON values");
  }
  const decoded: unknown = JSON.parse(encoded);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("production grading-plan settings must be a JSON object");
  }
  return decoded as Readonly<Record<string, unknown>>;
}

function planHash(entries: readonly ProductionGradingPlanEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => [
      entry.projectGraderId,
      entry.graderDefinitionId,
      entry.graderDefinitionVersion,
      entry.graderPassThreshold,
      entry.parameterValues,
    ])))
    .digest("hex");
}

function rowFor(auth: AuthContext, grade: NewGrade): Record<string, unknown> {
  validate(grade);
  return {
    organization_id: auth.organizationId,
    project_id: projectOf(auth),
    source: grade.source,
    trace_id: grade.traceId,
    trace_started_at: asDateTime64(grade.traceStartedAtMicroseconds),
    run_id: grade.runId,
    project_grader_id: grade.projectGraderId,
    grader_definition_id: grade.graderDefinitionId,
    grader_definition_version: grade.graderDefinitionVersion,
    score: grade.score,
    details: storedDetails(grade.details),
    grader_pass_threshold: grade.graderPassThreshold,
    grading_sequence: grade.gradingSequence,
    graded_at: asDateTime64(grade.gradedAtMicroseconds),
  };
}

export async function appendGrades(
  auth: AuthContext,
  grades: readonly NewGrade[],
): Promise<AppendedGrades> {
  if (grades.length === 0) return { appended: 0, batches: 0 };
  const rows = grades.map((grade) => rowFor(auth, grade));
  let batches = 0;
  for (let at = 0; at < rows.length; at += MAXIMUM_ROWS_PER_INSERT) {
    await traceStore().insert({
      table: GRADES_TABLE,
      values: rows.slice(at, at + MAXIMUM_ROWS_PER_INSERT),
      format: "JSONEachRow",
    });
    batches += 1;
  }
  return { appended: rows.length, batches };
}

type GradeRow = {
  readonly source: GradeSource;
  readonly trace_id: string;
  readonly trace_started_at_micros: string;
  readonly run_id: string;
  readonly project_grader_id: string;
  readonly grader_definition_id: string;
  readonly grader_definition_version: number;
  readonly score: number | null;
  readonly details: StoredDetails;
  readonly grader_pass_threshold: number;
  readonly grading_sequence: number;
  readonly graded_at_micros: string;
};

function gradeOf(row: GradeRow): RecordedGrade {
  const traceStartedAtMicroseconds = BigInt(row.trace_started_at_micros);
  const gradedAtMicroseconds = BigInt(row.graded_at_micros);
  return {
    source: row.source,
    traceId: row.trace_id,
    traceStartedAtMicroseconds,
    traceStartedAt: rfc3339(traceStartedAtMicroseconds),
    runId: row.run_id,
    projectGraderId: row.project_grader_id,
    graderDefinitionId: row.grader_definition_id,
    graderDefinitionVersion: Number(row.grader_definition_version),
    score: row.score === null ? null : Number(row.score),
    details: detailsOf(row.details),
    graderPassThreshold: Number(row.grader_pass_threshold),
    gradingSequence: Number(row.grading_sequence),
    gradedAtMicroseconds,
    gradedAt: rfc3339(gradedAtMicroseconds),
  };
}

export async function readTraceGrades(
  auth: AuthContext,
  ref: TraceGradeRef,
): Promise<TraceGrades> {
  authorize(auth, "read", here(auth));
  if (ref.source === "simulation" && (ref.runId === undefined || ref.runId === "")) {
    throw new TypeError("reading simulation grades requires the run");
  }
  if (ref.source === "production" && ref.runId !== undefined) {
    throw new TypeError("reading production grades cannot name a run");
  }
  const answered = await traceStore().query({
    query: `select
              source,
              trace_id,
              toString(toUnixTimestamp64Micro(trace_started_at)) as trace_started_at_micros,
              run_id,
              project_grader_id,
              grader_definition_id,
              grader_definition_version,
              score,
              details,
              grader_pass_threshold,
              grading_sequence,
              toString(toUnixTimestamp64Micro(graded_at)) as graded_at_micros
            from ${GRADES_TABLE}
            where organization_id = {organization_id:String}
              and project_id = {project_id:String}
              and source = {source:String}
              and trace_id = {trace_id:String}
              and ${ref.source === "simulation" ? "run_id = {run_id:String}" : "run_id = ''"}
            order by project_grader_id, grading_sequence, graded_at`,
    query_params: {
      organization_id: auth.organizationId,
      project_id: projectOf(auth),
      source: ref.source,
      trace_id: ref.traceId,
      ...(ref.runId === undefined ? {} : { run_id: ref.runId }),
    },
    format: "JSONEachRow",
  });
  const history = (await answered.json<GradeRow>()).map(gradeOf);
  return { history, current: currentGrades(history) };
}

/**
 * Read one current row per simulation trace and project grader.
 *
 * This is the batch door for run headers and simulation pages. It deliberately
 * returns no grade details: those pages only need to know whether every item in
 * the frozen plan has a result, and whether one of those results is an error.
 */
export async function readCurrentSimulationGradeFacts(
  auth: AuthContext,
  selection:
    | { readonly runIds: readonly string[] }
    | { readonly traceIds: readonly string[] },
): Promise<readonly CurrentSimulationGradeFact[]> {
  authorize(auth, "read", here(auth));
  const values = "runIds" in selection ? selection.runIds : selection.traceIds;
  if (values.length === 0) return [];

  const answered = await traceStore().query({
    query: `select
              trace_id,
              run_id,
              project_grader_id,
              argMax(
                isNull(score),
                tuple(grading_sequence, graded_at)
              ) as errored
            from ${GRADES_TABLE}
            where organization_id = {organization_id:String}
              ${auth.projectId === undefined
                ? ""
                : "and project_id = {project_id:String}"}
              and source = 'simulation'
              and ${"runIds" in selection
                ? "run_id in {values:Array(String)}"
                : "trace_id in {values:Array(String)}"}
            group by trace_id, run_id, project_grader_id`,
    query_params: {
      organization_id: auth.organizationId,
      ...(auth.projectId === undefined ? {} : { project_id: auth.projectId }),
      values: [...new Set(values)],
    },
    format: "JSONEachRow",
  });
  const rows = await answered.json<{
    readonly trace_id: string;
    readonly run_id: string;
    readonly project_grader_id: string;
    readonly errored: number | boolean;
  }>();
  return rows.map((row) => ({
    traceId: row.trace_id,
    runId: row.run_id,
    projectGraderId: row.project_grader_id,
    errored: row.errored === true || Number(row.errored) === 1,
  }));
}

type ProductionPlanRow = {
  readonly trace_id: string;
  readonly trace_started_at_micros: string;
  readonly plan_hash: string;
  readonly entries: readonly (
    | {
        readonly project_grader_id: string;
        readonly grader_definition_id: string;
        readonly grader_definition_version: number;
        readonly grader_pass_threshold: number;
        readonly parameter_values: string;
      }
    | readonly [string, string, number, number, string]
  )[];
};

function entryOf(
  row: ProductionPlanRow["entries"][number],
): ProductionGradingPlanEntry {
  if ("project_grader_id" in row) {
    return {
      projectGraderId: row.project_grader_id,
      graderDefinitionId: row.grader_definition_id,
      graderDefinitionVersion: Number(row.grader_definition_version),
      graderPassThreshold: Number(row.grader_pass_threshold),
      parameterValues: parameterValuesOf(row.parameter_values),
    };
  }
  return {
    projectGraderId: row[0],
    graderDefinitionId: row[1],
    graderDefinitionVersion: Number(row[2]),
    graderPassThreshold: Number(row[3]),
    parameterValues: parameterValuesOf(row[4]),
  };
}

function parameterValuesOf(value: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("production grading plan has unreadable parameter values");
  }
  return canonicalParameterValues(
    parsed as Readonly<Record<string, unknown>>,
  );
}

function productionPlanOf(row: ProductionPlanRow): ProductionGradingPlan {
  const traceStartedAtMicroseconds = BigInt(row.trace_started_at_micros);
  return {
    traceId: row.trace_id,
    traceStartedAtMicroseconds,
    traceStartedAt: rfc3339(traceStartedAtMicroseconds),
    planHash: row.plan_hash.toLowerCase(),
    entries: canonicalEntries(row.entries.map(entryOf)),
  };
}

function sameProductionPlan(
  left: ProductionGradingPlan,
  right: ProductionGradingPlan,
): boolean {
  return (
    left.traceStartedAtMicroseconds === right.traceStartedAtMicroseconds &&
    left.planHash === right.planHash &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries)
  );
}

/**
 * Read the permanent selection fact for one production trace.
 *
 * Exact physical replay rows collapse here. Two different hashes, or two rows
 * that claim the same hash but disagree on another immutable fact, are an
 * integrity error. This table never silently chooses one plan.
 */
export async function readProductionGradingPlan(
  auth: AuthContext,
  traceId: string,
): Promise<ProductionGradingPlan | undefined> {
  authorize(auth, "read", here(auth));
  const answered = await traceStore().query({
    query: `select
              trace_id,
              toString(toUnixTimestamp64Micro(trace_started_at)) as trace_started_at_micros,
              lower(hex(plan_hash)) as plan_hash,
              entries
            from ${PRODUCTION_PLANS_TABLE}
            where organization_id = {organization_id:String}
              and project_id = {project_id:String}
              and trace_id = {trace_id:String}`,
    query_params: {
      organization_id: auth.organizationId,
      project_id: projectOf(auth),
      trace_id: traceId,
    },
    format: "JSONEachRow",
  });
  const plans = (await answered.json<ProductionPlanRow>()).map(productionPlanOf);
  const first = plans[0];
  if (first === undefined) return undefined;
  if (plans.some((plan) => !sameProductionPlan(plan, first))) {
    throw new ProductionGradingPlanConflictError(
      `production trace ${traceId} has conflicting frozen grader plans`,
    );
  }
  return first;
}

/**
 * Record the first frozen selection for one production trace.
 *
 * `requestGrading` holds the per-trace Postgres advisory lock around this
 * operation. This door still checks before writing, so an ordinary replay does
 * not add a physical duplicate. Correctness reads remain duplicate-safe for an
 * uncertain insert response or a crash after ClickHouse accepted the row.
 */
export async function recordProductionGradingPlan(
  auth: AuthContext,
  input: NewProductionGradingPlan,
): Promise<ProductionGradingPlan> {
  const entries = canonicalEntries(input.entries);
  const intended: ProductionGradingPlan = {
    traceId: input.traceId,
    traceStartedAtMicroseconds: input.traceStartedAtMicroseconds,
    traceStartedAt: rfc3339(input.traceStartedAtMicroseconds),
    planHash: planHash(entries),
    entries,
  };

  const existing = await readProductionGradingPlan(auth, input.traceId);
  if (existing !== undefined) {
    if (!sameProductionPlan(existing, intended)) {
      throw new ProductionGradingPlanConflictError(
        `production trace ${input.traceId} already has another frozen grader plan`,
      );
    }
    return existing;
  }

  await traceStore().command({
    query: `insert into ${PRODUCTION_PLANS_TABLE}
            values (
              {organization_id:String},
              {project_id:String},
              {trace_id:String},
              {trace_started_at:DateTime64(6, 'UTC')},
              unhex({plan_hash:String}),
              {entries:Array(Tuple(String, String, UInt32, Float64, String))}
            )`,
    query_params: {
      organization_id: auth.organizationId,
      project_id: projectOf(auth),
      trace_id: input.traceId,
      trace_started_at: asDateTime64(input.traceStartedAtMicroseconds),
      plan_hash: intended.planHash,
      entries: entries.map((entry) => new TupleParam([
        entry.projectGraderId,
        entry.graderDefinitionId,
        entry.graderDefinitionVersion,
        entry.graderPassThreshold,
        JSON.stringify(entry.parameterValues),
      ])),
    },
  });
  return intended;
}
