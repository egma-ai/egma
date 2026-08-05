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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { agent, connection, CONNECTION_TYPES, MODALITIES } from "./agents.ts";
import { persona, personaVersion } from "./personas.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * A run is the trigger's record — who asked for simulations, when, how, and
 * what was requested. A simulation is one conversation inside it, born
 * `queued` before anything else happens, so nothing a team triggers can
 * silently vanish. Retry is a new run pointing back at the old one; a
 * terminal run's numbers are frozen and never reopened.
 *
 * The test linkage is deliberately absent-but-shaped-for: when the two
 * workstreams meet, a simulation gains its test-version pin by one additive
 * migration, and nothing here moves. Verdict counts and the gate result are
 * likewise the graders' side of the line and arrive with them; the counts on
 * this header are simulation outcomes — did each conversation happen — never
 * judgements of what happened in one.
 */

/**
 * Did the machinery finish — never whether anything passed. A run whose every
 * simulation failed still `completed`; the counts describe the contents.
 * `canceled` is the one terminal state a run can enter before its stragglers
 * land, so its counts may arrive after its status does.
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** How a run came to exist. Manual now; a schedule is one more word later. */
export const RUN_TRIGGERS = ["manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * The whole lifecycle, and every move between its states is guarded: the
 * migration installs a trigger refusing any transition not in the legal set,
 * so an illegal one cannot be written even by a migration script or a manual
 * fix — the same paths the composite foreign keys defend.
 *
 *   queued → claimed → running → completed | failed | canceled
 *
 * `queued → canceled` is the cancel-before-claim path, and a canceled row can
 * never be claimed. A terminal row is frozen entirely.
 */
export const SIMULATION_STATUSES = [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "canceled",
] as const;
export type SimulationStatus = (typeof SIMULATION_STATUSES)[number];

/**
 * How a completed conversation ended — a fact about the conversation, not a
 * judgement of it. An agent that hung up mid-sentence completed its
 * simulation; whether that was acceptable is the graders' question, later.
 */
export const COMPLETED_ENDING_REASONS = [
  "persona_concluded",
  "agent_ended",
  "limit_reached",
] as const;

/**
 * Why a simulation never produced a conversation to grade. These must never
 * collapse into "the agent behaved badly": an agent that never joined, a line
 * that was never answered, a platform out of capacity, egma's own error, and
 * a simulator that died mid-conversation are all "the test never ran", and
 * grading any of them as a failure is the false red a test product cannot
 * afford.
 */
export const FAILED_ENDING_REASONS = [
  "agent_never_joined",
  "not_answered",
  "capacity",
  "simulator_error",
  "orphaned",
] as const;

export const SIMULATION_ENDING_REASONS = [
  ...COMPLETED_ENDING_REASONS,
  ...FAILED_ENDING_REASONS,
] as const;
export type SimulationEndingReason =
  (typeof SIMULATION_ENDING_REASONS)[number];

export const run = pgTable(
  "run",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    agentId: idText("agent_id").notNull(),
    connectionId: idText("connection_id").notNull(),
    /** Something to recognise the run by in a list; never an identity. */
    label: text("label"),
    status: text("status").notNull(),
    /**
     * Who asked and how. The user comes from the credential; a run of a
     * deactivated or erased person keeps existing with the reference nulled,
     * because the run is the team's record and not theirs.
     */
    triggeredVia: text("triggered_via").notNull(),
    triggeredBy: idText("triggered_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /**
     * The persona selection as it was requested, kept as provenance. What was
     * actually conducted is each simulation's own pinned version; this answers
     * "what did they ask for" after the personas themselves move on.
     */
    requestedPersonas: jsonb("requested_personas").notNull(),
    /**
     * The connection's non-secret shape as the run executed over it — type,
     * modality, topology, environment, config. Connections are deliberately
     * unversioned, so anything needed to interpret this run later has to be
     * stamped here at start. Never credentials.
     */
    connectionSnapshot: jsonb("connection_snapshot").notNull(),
    /** Set at start; the denominator a progress page divides by. */
    expectedSimulationCount: integer("expected_simulation_count").notNull(),
    /**
     * Written once, together, when the last simulation lands terminal — and
     * frozen from then on by the same trigger that freezes the status. They
     * count conversations, not verdicts: verdict counts arrive with graders.
     */
    completedCount: integer("completed_count"),
    failedCount: integer("failed_count"),
    canceledCount: integer("canceled_count"),
    /** A new run, retrying an old one — never the old run reopened. */
    retryOfRunId: idText("retry_of_run_id").references(
      (): AnyPgColumn => run.id,
      { onDelete: "set null" },
    ),
    startedAt: moment("started_at"),
    finishedAt: moment("finished_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("run_id_prefix", table.id, "run"),
    oneOf("run_status_allowed", table.status, [...RUN_STATUSES]),
    oneOf("run_triggered_via_allowed", table.triggeredVia, [...RUN_TRIGGERS]),
    check(
      "run_expects_at_least_one_simulation",
      sql`${table.expectedSimulationCount} > 0`,
    ),
    // The three counts and finished_at arrive as one write or not at all, so
    // no reader ever meets a half-stamped header.
    check(
      "run_counts_written_together",
      sql`((${table.completedCount} is null) = (${table.failedCount} is null))
        and ((${table.failedCount} is null) = (${table.canceledCount} is null))
        and ((${table.canceledCount} is null) = (${table.finishedAt} is null))`,
    ),
    check(
      "run_counts_are_counts",
      sql`(${table.completedCount} is null)
        or (${table.completedCount} >= 0 and ${table.failedCount} >= 0 and ${table.canceledCount} >= 0)`,
    ),
    // Finished means terminal, and completed means finished; only a canceled
    // run may hold its terminal status while stragglers land.
    check(
      "run_finished_is_terminal",
      sql`${table.finishedAt} is null or ${table.status} in ('completed', 'canceled')`,
    ),
    check(
      "run_completed_is_finished",
      sql`${table.status} <> 'completed' or ${table.finishedAt} is not null`,
    ),
    // A run starts when its first simulation is claimed; pending is before
    // that moment, and only a cancel can end a run that never started.
    check(
      "run_started_when_left_pending",
      sql`case
        when ${table.status} = 'pending' then ${table.startedAt} is null
        when ${table.status} in ('running', 'completed') then ${table.startedAt} is not null
        else true
      end`,
    ),
    // The pairing, not each column on its own: a run cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "run_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // One level down: the agent is that same project's.
    foreignKey({
      name: "run_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // And the connection is that same agent's — the dormant unique built for
    // exactly this row, now doing its work.
    foreignKey({
      name: "run_connection_agent_fk",
      columns: [table.connectionId, table.agentId],
      foreignColumns: [connection.id, connection.agentId],
    }).onDelete("cascade"),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that makes a simulation of one run in another run's project
    // unrepresentable.
    unique("run_id_project_id_unique").on(table.id, table.projectId),
    // Two list indexes rather than one, deliberately: the ids order the list,
    // and Postgres will not skip the leading columns of a composite index —
    // the unfiltered customer-wide list is the common case and gets its own.
    index("run_organization_id_id_idx").on(table.organizationId, table.id),
    index("run_organization_id_project_id_id_idx").on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    index("run_agent_id_idx").on(table.agentId),
  ],
);

export const simulation = pgTable(
  "simulation",
  {
    id: idText("id").primaryKey(),
    runId: idText("run_id").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    agentId: idText("agent_id").notNull(),
    connectionId: idText("connection_id").notNull(),
    /**
     * Who called, and the pin. The version can never change, so this row says
     * exactly who called for as long as the simulation is kept — and the
     * version is refused deletion while it does. The identity rides beside it
     * because it is what the composite keys below pair on: the version is
     * this persona's, and the persona is this project's.
     */
    personaId: idText("persona_id").notNull(),
    personaVersionId: idText("persona_version_id").notNull(),
    /** Where in the run's requested order this conversation sits, from one. */
    position: integer("position").notNull(),
    /**
     * The connection's type and modality as they were at execution, stamped
     * here because the connection row is mutable and unversioned: editing it
     * next month must not rewrite what this simulation's numbers meant.
     */
    connectionType: text("connection_type").notNull(),
    modality: text("modality").notNull(),
    status: text("status").notNull(),
    /**
     * How it ended: a completed-class reason for a conversation, a
     * failed-class reason for a simulation that never ran or died. Null while
     * anything is still moving, and null on canceled — the cancel intent is
     * its own record.
     */
    endingReason: text("ending_reason"),
    /**
     * Claim bookkeeping. The claimant is the simulator instance's own name
     * for itself — an operational label, never an identity in egma's tables
     * — and the heartbeat is what the orphan sweep reads.
     */
    claimedBy: text("claimed_by"),
    claimedAt: moment("claimed_at"),
    heartbeatAt: moment("heartbeat_at"),
    /**
     * The cancel intent, honored at the next heartbeat. Set on a queued row
     * only together with the terminal flip, so a canceled-before-claim row
     * was never claimable in between.
     */
    cancelRequestedAt: moment("cancel_requested_at"),
    startedAt: moment("started_at"),
    endedAt: moment("ended_at"),
    /**
     * Measured at execution, never declared: 8 kHz telephony and 48 kHz
     * WebRTC are different units, and a simulation that did not record its
     * band is permanently uncomparable. Null for chat, and null until the
     * simulator measures it.
     */
    measuredAudioBandHertz: integer("measured_audio_band_hertz"),
    /** What the simulator reported, written once at terminal state. */
    transcript: jsonb("transcript"),
    events: jsonb("events"),
    metrics: jsonb("metrics"),
    /** The dual-channel recording's reference in the blob store, voice only. */
    recordingReference: text("recording_reference"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("simulation_id_prefix", table.id, "sim"),
    oneOf("simulation_status_allowed", table.status, [...SIMULATION_STATUSES]),
    oneOf("simulation_connection_type_allowed", table.connectionType, [
      ...CONNECTION_TYPES,
    ]),
    oneOf("simulation_modality_allowed", table.modality, [...MODALITIES]),
    check(
      "simulation_position_counts_from_one",
      sql`${table.position} >= 1`,
    ),
    check(
      "simulation_ending_reason_allowed",
      sql`${table.endingReason} is null or ${table.endingReason} in ${sql.raw(
        `(${SIMULATION_ENDING_REASONS.map((reason) => `'${reason}'`).join(", ")})`,
      )}`,
    ),
    // The reason's class follows the status: a conversation ended one of the
    // completed ways, a simulation that never ran failed one of the failed
    // ways, and nothing else carries a reason at all. This is the line
    // between "the agent behaved badly" and "the test never ran", held by
    // the database rather than by convention.
    check(
      "simulation_ending_reason_agrees",
      sql`case ${table.status}
        when 'completed' then ${table.endingReason} in ${sql.raw(
          `(${COMPLETED_ENDING_REASONS.map((reason) => `'${reason}'`).join(", ")})`,
        )}
        when 'failed' then ${table.endingReason} in ${sql.raw(
          `(${FAILED_ENDING_REASONS.map((reason) => `'${reason}'`).join(", ")})`,
        )}
        else ${table.endingReason} is null
      end`,
    ),
    // The three claim columns are one fact and arrive together.
    check(
      "simulation_claim_columns_agree",
      sql`((${table.claimedAt} is null) = (${table.claimedBy} is null))
        and ((${table.claimedAt} is null) = (${table.heartbeatAt} is null))`,
    ),
    // What each state looks like, one check per state so a violation names
    // the state it broke.
    check(
      "simulation_queued_shape",
      sql`${table.status} <> 'queued'
        or (${table.claimedAt} is null and ${table.startedAt} is null
          and ${table.endedAt} is null and ${table.cancelRequestedAt} is null)`,
    ),
    check(
      "simulation_claimed_shape",
      sql`${table.status} <> 'claimed'
        or (${table.claimedAt} is not null and ${table.startedAt} is null
          and ${table.endedAt} is null)`,
    ),
    check(
      "simulation_running_shape",
      sql`${table.status} <> 'running'
        or (${table.claimedAt} is not null and ${table.startedAt} is not null
          and ${table.endedAt} is null)`,
    ),
    check(
      "simulation_completed_shape",
      sql`${table.status} <> 'completed'
        or (${table.startedAt} is not null and ${table.endedAt} is not null)`,
    ),
    check(
      "simulation_failed_shape",
      sql`${table.status} <> 'failed' or ${table.endedAt} is not null`,
    ),
    // A canceled row always records the intent it honored, whether it was
    // still queued or already claimed when the intent arrived.
    check(
      "simulation_canceled_shape",
      sql`${table.status} <> 'canceled'
        or (${table.endedAt} is not null and ${table.cancelRequestedAt} is not null)`,
    ),
    // The report is terminal facts; nothing running holds one yet.
    check(
      "simulation_report_only_when_ended",
      sql`${table.endedAt} is not null
        or (${table.transcript} is null and ${table.events} is null
          and ${table.metrics} is null and ${table.recordingReference} is null
          and ${table.measuredAudioBandHertz} is null)`,
    ),
    // A chat has no audio: a measured band or a recording on one would be a
    // number nothing produced, so the row refuses to hold it.
    check(
      "simulation_audio_facts_are_voice_facts",
      sql`${table.modality} = 'voice'
        or (${table.measuredAudioBandHertz} is null
          and ${table.recordingReference} is null)`,
    ),
    check(
      "simulation_audio_band_is_a_rate",
      sql`${table.measuredAudioBandHertz} is null or ${table.measuredAudioBandHertz} > 0`,
    ),
    // The tenancy triangle, edge by edge, exactly as the run's: project of
    // the organization, agent of the project, connection of the agent — and
    // the run of the same project, so a simulation cannot sit in a run that
    // cannot see it. The persona pin closes the same way: the version is the
    // named persona's, and the persona is this project's, so a raw write
    // cannot pin another customer's persona.
    foreignKey({
      name: "simulation_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "simulation_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "simulation_connection_agent_fk",
      columns: [table.connectionId, table.agentId],
      foreignColumns: [connection.id, connection.agentId],
    }).onDelete("cascade"),
    foreignKey({
      name: "simulation_run_project_fk",
      columns: [table.runId, table.projectId],
      foreignColumns: [run.id, run.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "simulation_persona_version_persona_fk",
      columns: [table.personaVersionId, table.personaId],
      foreignColumns: [personaVersion.id, personaVersion.personaId],
    }),
    foreignKey({
      name: "simulation_persona_project_fk",
      columns: [table.personaId, table.projectId],
      foreignColumns: [persona.id, persona.projectId],
    }),
    // A run's conversations are an ordered list, and no place in it is
    // claimed twice.
    unique("simulation_run_id_position_unique").on(table.runId, table.position),
    index("simulation_run_id_idx").on(table.runId),
    // The claim's hot path: the oldest queued simulations of one customer.
    index("simulation_queued_idx")
      .on(table.organizationId, table.id)
      .where(sql`${table.status} = 'queued'`),
    // The orphan sweep's: everything claimed or running, by last heartbeat.
    index("simulation_heartbeat_idx")
      .on(table.heartbeatAt)
      .where(sql`${table.status} in ('claimed', 'running')`),
    // "Which simulations were conducted with version so-and-so" — the read
    // the orphan sweep of persona versions will one day ask — and the same
    // question by identity, which is what a persona's own erasure checks.
    index("simulation_persona_version_id_idx").on(table.personaVersionId),
    index("simulation_persona_id_idx").on(table.personaId),
  ],
);
