import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { simulation } from "./runs.ts";
import { organization, project } from "./tenancy.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * A grading job is one conversation waiting to be judged, and the claim on it.
 *
 * The simulation table already carries the conversation; this table carries the
 * *work*, which is a different fact with a different lifetime. A row is written
 * by the terminal transition itself — inside the same transaction that marks a
 * simulation `completed` or `failed`, so a conversation cannot land and leave no
 * work behind — and it is claimed, held and finished by the grader service.
 *
 * **Why a table rather than claim columns on the simulation, which is where the
 * simulator's claim lives.** Two reasons, and either would be enough. A terminal
 * simulation row is frozen by the lifecycle trigger: nothing may write to it
 * after it lands, which is exactly when grading starts, so the columns could not
 * be written even if they existed. And a production conversation has no
 * simulation row at all — grading judges both sources with one engine, so the
 * work has to be nameable without a simulation. Today the only work is a
 * simulation's; the shape does not have to change for the second source to
 * arrive.
 *
 * **Claiming is the simulator's claim, verb for verb** — `SKIP LOCKED` over the
 * oldest outstanding rows, a claimant label, a heartbeat, and a lease. The one
 * difference is that the lease expiring *is* the sweep: a job whose holder
 * stopped answering is claimable again by the same query that claims a new one,
 * so a copy of the service dying mid-judgment costs one lease and no operator
 * attention. There is nothing for a separate sweep to do here, because unlike a
 * simulation a grading job has no half-finished conversation to record — the
 * work either produced verdict rows or did not.
 *
 * **Nobody polls for the row.** The write that inserts it also raises a
 * `pg_notify` on the same transaction, so a listening service wakes when the
 * transition commits and not a moment of interval later. The claim query is
 * still the whole truth — a service that was not listening, or was not running,
 * finds the row waiting when it next asks — which is what keeps the
 * notification an accelerator rather than a delivery guarantee nothing could
 * make.
 */

/**
 * Where a job stands.
 *
 *   pending → claimed → graded
 *                    ↘  pending (a copy failed, and the job is anybody's again)
 *                    ↘  abandoned (it kept failing, and egma stops trying)
 *
 * `abandoned` is deliberately not `failed`: nothing about the agent under test
 * is being said here. It means egma could not judge this conversation and has
 * given up on judging it, and `last_error` is what it says about why.
 */
export const GRADING_JOB_STATUSES = [
  "pending",
  "claimed",
  "graded",
  "abandoned",
] as const;
export type GradingJobStatus = (typeof GRADING_JOB_STATUSES)[number];

/**
 * Where the conversation being judged came from — the same word the verdict row
 * and `spans.source` carry, because a simulation and a production conversation
 * are compared against each other and a word that meant two things would make
 * that impossible. Only `simulation` is written today; production grading brings
 * the other.
 */
export const GRADING_SOURCES = ["simulation", "production"] as const;
export type GradingSource = (typeof GRADING_SOURCES)[number];

export const gradingJob = pgTable(
  "grading_job",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    source: text("source").notNull(),
    /**
     * The conversation to judge. Nullable because the column names a
     * simulation and the second source has none — the check below is what
     * holds the pairing, so a `simulation` job without one is unrepresentable
     * rather than merely never written.
     */
    simulationId: idText("simulation_id"),
    status: text("status").notNull(),
    /**
     * Claim bookkeeping, the simulation's three columns exactly. The claimant
     * is the grader copy's own name for itself — an operational label, never an
     * identity in egma's tables — and the heartbeat is what the lease is
     * measured against.
     */
    claimedBy: text("claimed_by"),
    claimedAt: moment("claimed_at"),
    heartbeatAt: moment("heartbeat_at"),
    /**
     * How many times this job has been claimed. It is what stops a job that
     * fails the same way every time from being retried forever, and it is
     * counted on the claim rather than on the failure so that a copy which dies
     * without saying anything still counts against the total.
     */
    attempts: integer("attempts").notNull().default(0),
    /** Why the last attempt did not finish. Plain prose, never a stack. */
    lastError: text("last_error"),
    finishedAt: moment("finished_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("grading_job_id_prefix", table.id, "gjb"),
    oneOf("grading_job_status_allowed", table.status, [
      ...GRADING_JOB_STATUSES,
    ]),
    oneOf("grading_job_source_allowed", table.source, [...GRADING_SOURCES]),
    // One job per conversation. It makes the enqueue idempotent — the terminal
    // transition can be replayed and the second insert is a no-op — and it is
    // what the explicit re-grade action will reopen rather than duplicate.
    unique("grading_job_simulation_id_unique").on(table.simulationId),
    // The source and what it names are one fact: a simulation's job names a
    // simulation, and anything else names none.
    check(
      "grading_job_source_names_its_conversation",
      sql`case ${table.source}
        when 'simulation' then ${table.simulationId} is not null
        else ${table.simulationId} is null
      end`,
    ),
    // The three claim columns are one fact and arrive together, exactly as the
    // simulation's do.
    check(
      "grading_job_claim_columns_agree",
      sql`((${table.claimedAt} is null) = (${table.claimedBy} is null))
        and ((${table.claimedAt} is null) = (${table.heartbeatAt} is null))`,
    ),
    // What each state looks like, one check per state so a violation names the
    // state it broke. A pending job is unheld — releasing one clears the claim
    // — and only a finished job carries the moment it finished.
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
      "grading_job_finished_is_terminal",
      sql`(${table.finishedAt} is null)
        = (${table.status} not in ('graded', 'abandoned'))`,
    ),
    check("grading_job_attempts_are_counted", sql`${table.attempts} >= 0`),
    // The tenancy triangle, edge by edge, as everywhere else: the project is
    // this organization's, and the simulation is that project's — so a job
    // cannot be written against another customer's conversation.
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
    // The claim's hot path, and it is the whole deployment's queue rather than
    // one customer's: the grader service holds no credential and works every
    // organization, so the organization is deliberately not the leading column
    // here. Oldest first, which the mint order of the id already is.
    index("grading_job_outstanding_idx")
      .on(table.id)
      .where(sql`${table.status} in ('pending', 'claimed')`),
    // Which job belongs to which customer, for the reads that start from one.
    index("grading_job_organization_id_project_id_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);
