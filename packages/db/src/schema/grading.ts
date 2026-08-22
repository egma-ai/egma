import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";
import { simulation } from "./runs.ts";
import { organization, project } from "./tenancy.ts";
import type { GraderDefinitionSnapshot } from "../grader-library/snapshot.ts";

/**
 * One frozen grader instruction inside a trace-level job.
 *
 * Policy and executable meaning travel together. A worker must never follow a
 * live project scope, threshold, or current-definition pointer after the trace
 * has been selected.
 */
export type FrozenGradingEntry = {
  readonly projectGraderId: string;
  readonly graderDefinitionId: string;
  readonly graderDefinitionVersion: number;
  readonly graderPassThreshold: number;
  readonly definition: GraderDefinitionSnapshot;
};

/**
 * Queue state says only whether Egma still has operational work.
 *
 * A successful row is deleted after its durable grades exist. `abandoned` is
 * retained because it explains why a frozen plan has missing grade rows.
 */
export const GRADING_JOB_STATUSES = [
  "pending",
  "claimed",
  "abandoned",
] as const;
export type GradingJobStatus = (typeof GRADING_JOB_STATUSES)[number];

export const GRADING_SOURCES = ["simulation", "production"] as const;
export type GradingSource = (typeof GRADING_SOURCES)[number];

/**
 * Temporary work for one completed trace.
 *
 * One row contains every frozen grader entry for the trace. Workers never read
 * live scope, sampling, versions, or thresholds. The row is an ordinary
 * Postgres `SKIP LOCKED` lease: notification wakes workers quickly and the
 * claim query remains the durable source of work.
 *
 * Completion is decided before this row is inserted. There are no root-span or
 * silence columns here because neither fact is allowed to complete production
 * grading. The exact OpenTelemetry trace id and start time name the evidence
 * for both simulation and production.
 */
export const gradingJob = pgTable(
  "grading_job",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    source: text("source").notNull(),
    /** Present only for a simulation, where test variables live. */
    simulationId: idText("simulation_id"),
    /** Exact OpenTelemetry trace id for both sources. */
    traceId: text("trace_id").notNull(),
    traceStartedAt: moment("trace_started_at").notNull(),
    /** Present only for a simulation. Empty production work has no run. */
    runId: idText("run_id"),
    entries: jsonb("entries").$type<readonly FrozenGradingEntry[]>().notNull(),
    status: text("status").notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: moment("claimed_at"),
    heartbeatAt: moment("heartbeat_at"),
    /** The greatest order reserved before this job's attempt counter starts. */
    sequenceBase: integer("sequence_base").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Set only when retry exhaustion leaves an explainable terminal failure. */
    finishedAt: moment("finished_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("grading_job_id_prefix", table.id, "gjb"),
    oneOf("grading_job_status_allowed", table.status, [
      ...GRADING_JOB_STATUSES,
    ]),
    oneOf("grading_job_source_allowed", table.source, [...GRADING_SOURCES]),
    unique("grading_job_simulation_id_unique").on(table.simulationId),
    unique("grading_job_project_id_trace_id_unique").on(
      table.projectId,
      table.traceId,
    ),
    check(
      "grading_job_source_names_its_control_record",
      sql`case ${table.source}
        when 'simulation' then ${table.simulationId} is not null and ${table.runId} is not null
        when 'production' then ${table.simulationId} is null and ${table.runId} is null
        else false
      end`,
    ),
    check(
      "grading_job_entries_are_a_nonempty_list",
      sql`jsonb_typeof(${table.entries}) = 'array'
        and jsonb_array_length(${table.entries}) > 0`,
    ),
    check(
      "grading_job_claim_columns_agree",
      sql`((${table.claimedAt} is null) = (${table.claimedBy} is null))
        and ((${table.claimedAt} is null) = (${table.heartbeatAt} is null))`,
    ),
    check(
      "grading_job_pending_shape",
      sql`${table.status} <> 'pending'
        or (${table.claimedAt} is null and ${table.finishedAt} is null)`,
    ),
    check(
      "grading_job_claimed_shape",
      sql`${table.status} <> 'claimed'
        or (${table.claimedAt} is not null and ${table.finishedAt} is null)`,
    ),
    check(
      "grading_job_abandoned_shape",
      sql`(${table.status} = 'abandoned') = (${table.finishedAt} is not null)`,
    ),
    check("grading_job_sequence_base_is_counted", sql`${table.sequenceBase} >= 0`),
    check("grading_job_attempts_are_counted", sql`${table.attempts} >= 0`),
    foreignKey({
      name: "grading_job_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "grading_job_simulation_project_fk",
      columns: [table.simulationId, table.projectId],
      foreignColumns: [simulation.id, simulation.projectId],
    }).onDelete("cascade"),
    index("grading_job_outstanding_idx")
      .on(table.id)
      .where(sql`${table.status} in ('pending', 'claimed')`),
    index("grading_job_organization_id_project_id_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);
