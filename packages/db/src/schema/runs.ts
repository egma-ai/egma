import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { agent, connection, CONNECTION_TYPES, MODALITIES } from "./agents.ts";
import type { PersonaParameterValues } from "../persona-library/parameters.ts";
import type { FrozenRunGradingPlan } from "../grading/plan.ts";
import { personaVersion } from "./personas.ts";
import { test, testSuite, testVersion } from "./tests.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * A run records the requested simulations. Each simulation starts queued and
 * pins its test and persona versions. Terminal run counts record execution
 * status; grades are stored separately.
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
 * Simulation status transitions are enforced by a database trigger.
 * The usual path is queued → claimed → running → a terminal status.
 * A deferred preflight releases claimed → queued and clears the lease facts
 * in the same write. Cancellation can occur before dispatch. Terminal rows
 * cannot transition again.
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
 * grade of it. An agent that hung up mid-sentence completed its
 * simulation; whether that was acceptable is the graders' question, later.
 */
export const COMPLETED_ENDING_REASONS = [
  "persona_concluded",
  "agent_ended",
  "limit_reached",
] as const;

/**
 * Execution failures, separate from grades of agent behavior.
 * The platform records orphaned when a simulator stops reporting, and
 * dispatch_failed when it cannot prepare a claimed simulation for dispatch.
 */
export const FAILED_ENDING_REASONS = [
  "agent_never_joined",
  "not_answered",
  "capacity",
  "simulator_error",
  "orphaned",
  "dispatch_failed",
  "provider_key_unavailable",
] as const;

export const SIMULATION_ENDING_REASONS = [
  ...COMPLETED_ENDING_REASONS,
  ...FAILED_ENDING_REASONS,
] as const;
export type SimulationEndingReason =
  (typeof SIMULATION_ENDING_REASONS)[number];

/** What one event is about: one simulation moving, or the run itself. */
export const RUN_EVENT_KINDS = ["run", "simulation"] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** A quoted value list, as a check's SQL wants one: `('a', 'b', 'c')`. */
const quoted = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(", ")})`);

export const run = pgTable(
  "run",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    suiteId: idText("suite_id").notNull(),
    agentId: idText("agent_id").notNull(),
    connectionId: idText("connection_id").notNull(),
    /** Something to recognise the run by in a list; never an identity. */
    name: text("name"),
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
     * The connection's non-secret shape as the run executed over it — type,
     * modality, topology, environment, config. Connections are deliberately
     * unversioned, so anything needed to interpret this run later has to be
     * stamped here at start. Never credentials.
     */
    connectionSnapshot: jsonb("connection_snapshot").notNull(),

    /**
     * Retell serving version resolved at run start. Text and web-call runs use
     * this pin; mocked web calls use the temporary version derived from it.
     * Null for phone runs and platforms without a version pin.
     */
    agentVersion: integer("agent_version"),
    /**
     * The temporary copy this run branched, where it branched one.
     *
     * Null means no copy was made, which is what an unmocked run and every
     * text-mode run are: text mode carries its answers on each request, so it
     * writes nothing to the customer's account at all.
     */
    tempMockAgentVersion: integer("temp_mock_agent_version"),
    /**
     * Null without a mock-draft lifecycle; false while cleanup is owed; true
     * after verified cleanup. The indexed column lets claims find unfinished
     * cleanup before creating another draft for this agent.
     */
    tempMockAgentVersionCleanup: boolean("temp_mock_agent_version_cleanup"),
    /**
     * Persisted mock-draft cleanup data: serving-engine fingerprint, engine
     * identities, and deletion progress. See MockMetadata in mock-tools/record.ts.
     * Phone-number bindings are not changed by this lifecycle.
     */
    mockMetadata: jsonb("mock_metadata"),
    /** Immutable grader selection captured before the initial run insert. */
    gradingPlan: jsonb("grading_plan").$type<FrozenRunGradingPlan>().notNull(),
    /** Set at start; the denominator a progress page divides by. */
    expectedSimulationCount: integer("expected_simulation_count").notNull(),
    /**
     * Written once, together, when the last simulation lands terminal — and
     * frozen from then on by the same trigger that freezes the status. They
     * count conversations, not grades: grades are stored separately by trace.
     */
    completedCount: integer("completed_count"),
    failedCount: integer("failed_count"),
    canceledCount: integer("canceled_count"),
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
        or (${table.completedCount} >= 0 and ${table.failedCount} >= 0
          and ${table.canceledCount} >= 0)`,
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
    foreignKey({
      name: "run_suite_project_fk",
      columns: [table.suiteId, table.projectId],
      foreignColumns: [testSuite.id, testSuite.projectId],
    }),
    // One level down: the agent is that same project's.
    foreignKey({
      name: "run_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }).onDelete("cascade"),
    // Keep the run's connection on its selected agent.
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
    // What the agent's own hard delete checks, and the per-agent history read
    // when it arrives; the id-ordered pair above already serves every list.
    index("run_agent_id_idx").on(table.agentId),
    index("run_suite_id_idx").on(table.suiteId),
    // A version is a whole number of versions, on both of the version columns.
    check(
      "run_agent_version_is_a_version",
      sql`${table.agentVersion} is null or ${table.agentVersion} >= 0`,
    ),
    check(
      "run_temp_mock_agent_version_is_a_version",
      sql`${table.tempMockAgentVersion} is null
        or ${table.tempMockAgentVersion} >= 0`,
    ),
    // A copy that was branched always carries a cleanup flag — owed or
    // settled. The other direction is deliberately open: the flag is written
    // the moment the run claims the account, which is before there is anything
    // to clean up.
    check(
      "run_temp_mock_agent_version_owes_cleanup",
      sql`${table.tempMockAgentVersion} is null
        or ${table.tempMockAgentVersionCleanup} is not null`,
    ),
    // The claim's own query, and the only read the cleanup flag is for: which
    // runs of this agent still owe the account a cleanup. Partial, because the
    // answer is almost always none.
    index("run_mock_tools_cleanup_owed_idx")
      .on(table.organizationId, table.agentId)
      .where(sql`${table.tempMockAgentVersionCleanup} = false`),
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
     * because it is what the composite key below pairs on: the version is
     * this persona's. A migration trigger separately proves that the persona
     * is provided by Egma or owned by this project.
     */
    personaId: idText("persona_id").notNull(),
    personaVersionId: idText("persona_version_id").notNull(),
    personaParameterValues: jsonb("persona_parameter_values").$type<PersonaParameterValues>().notNull(),
    /**
     * Frozen test version executed by this simulation. The identity is also
     * stored so composite foreign keys enforce test and project ownership.
     */
    testId: idText("test_id").notNull(),
    testVersionId: idText("test_version_id").notNull(),
    /** Where in the run's requested order this conversation sits, from one. */
    position: integer("position").notNull(),
    /**
     * Execution modality is stored here because the audio-facts CHECK cannot
     * join the connection table. It rejects recordings on non-voice simulations.
     */
    modality: text("modality").notNull(),
    /**
     * The connection's type as it was at execution, copied here for the
     * modality's own reason one step further on: **what a conversation cost in
     * platform terms has to be answerable from this row alone.**
     *
     * The three allowances a plan is measured in — chat simulations, web-call
     * minutes, phone minutes — are exactly this column and the one above it,
     * and nothing else. Reaching the connection for it instead would make a
     * month's usage a join against a row the customer can edit or archive
     * after the conversation happened, so a connection moved from a phone
     * number to a web call would silently move last month's minutes with it.
     * The fact rides here, frozen at execution, like the modality beside it.
     *
     * It is a shared column and not a `cloud_` one on purpose: which lane a
     * conversation ran over is a product fact every deployment records, and a
     * self-hoster reads their own minutes from it.
     */
    connectionType: text("connection_type").notNull(),
    status: text("status").notNull(),
    /**
     * How it ended: a completed-class reason for a conversation, a
     * failed-class reason for a simulation that never ran or died. Null while
     * anything is still moving, and null on canceled — the cancel intent is
     * its own record.
     */
    endingReason: text("ending_reason"),
    /**
     * What made execution fail, in the credential-redacted words the
     * simulator reported. The ending reason above classifies the failure;
     * this is the sentence a person can act on. Null for every non-failure,
     * and for failures written before this fact was retained.
     */
    executionFailure: text("execution_failure"),
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
    /** Measured worker end; absent when only the platform knows work stopped. */
    executionEndedAt: moment("execution_ended_at"),
    /** The dual-channel recording's reference in the blob store, voice only. */
    recordingReference: text("recording_reference"),
    /**
     * How many transcript turns the conversation reached, both speakers
     * counted — a terminal fact off the report, kept on the row because it is
     * read alone to answer for one simulation. Null until a landing carries
     * one, and null forever on a row whose report never did.
     */
    turnCount: integer("turn_count"),
    /**
     * The platform's own identifier for this exchange on the connection's
     * side — a Retell chat id, a telephony provider's id for the dialed leg.
     * The one join between egma's record and the agent's own telemetry, since
     * no trace context crosses an audio channel. Registered before dispatch for LiveKit rooms, otherwise carried by the
     * terminal report; null when the plug had none to offer.
     */
    providerReference: text("provider_reference"),

    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("simulation_id_prefix", table.id, "sim"),
    oneOf("simulation_status_allowed", table.status, [...SIMULATION_STATUSES]),
    oneOf("simulation_modality_allowed", table.modality, [...MODALITIES]),
    oneOf("simulation_connection_type_allowed", table.connectionType, [
      ...CONNECTION_TYPES,
    ]),
    check(
      "simulation_position_counts_from_one",
      sql`${table.position} >= 1`,
    ),
    check(
      "simulation_ending_reason_allowed",
      sql`${table.endingReason} is null or ${table.endingReason} in ${quoted(
        SIMULATION_ENDING_REASONS,
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
        when 'completed' then ${table.endingReason} in ${quoted(
          COMPLETED_ENDING_REASONS,
        )}
        when 'failed' then ${table.endingReason} in ${quoted(
          FAILED_ENDING_REASONS,
        )}
        else ${table.endingReason} is null
      end`,
    ),
    check(
      "simulation_execution_failure_agrees",
      sql`${table.executionFailure} is null or ${table.status} = 'failed'`,
    ),
    check(
      "simulation_execution_failure_not_blank",
      sql`${table.executionFailure} is null or btrim(${table.executionFailure}) <> ''`,
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
    check(
      "simulation_execution_end_is_measured",
      sql`${table.executionEndedAt} is null or (
        ${table.startedAt} is not null and ${table.endedAt} is not null
        and ${table.executionEndedAt} >= ${table.startedAt})`,
    ),
    // A canceled row always records the intent it honored, whether it was
    // still queued or already claimed when the intent arrived.
    check(
      "simulation_canceled_shape",
      sql`${table.status} <> 'canceled'
        or (${table.endedAt} is not null and ${table.cancelRequestedAt} is not null)`,
    ),
    // The recording is a terminal fact; nothing running holds one yet. The
    // check keeps its name because a constraint's name is what a violation
    // prints, and renaming one would break the sentence a reader searches for.
    check(
      "simulation_report_only_when_ended",
      sql`${table.endedAt} is not null
        or ${table.recordingReference} is null`,
    ),
    // Counts are terminal facts. A LiveKit room reference is registered
    // before dispatch so the agent can export while the simulation runs.
    check(
      "simulation_summary_facts_only_when_ended",
      sql`${table.endedAt} is not null
        or ${table.turnCount} is null`,
    ),
    check(
      "simulation_provider_reference_after_claim",
      sql`${table.status} <> 'queued' or ${table.providerReference} is null`,
    ),
    check(
      "simulation_turn_count_is_a_count",
      sql`${table.turnCount} is null or ${table.turnCount} >= 0`,
    ),
    // A chat has no audio, so its row refuses a recording.
    check(
      "simulation_audio_facts_are_voice_facts",
      sql`${table.modality} = 'voice'
        or ${table.recordingReference} is null`,
    ),
    // The tenancy triangle, edge by edge, exactly as the run's: project of
    // the organization, agent of the project, connection of the agent — and
    // the run of the same project, so a simulation cannot sit in a run that
    // cannot see it. The persona/version key proves that the frozen version is
    // the named persona's; the availability trigger proves that identity is
    // provided by Egma or owned by this project. The test pin closes its own
    // two edges, so a cross-project pin is unrepresentable rather than merely
    // unwritten by the application.
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
    // A normal composite key cannot express "this project or Egma". The
    // database trigger enforces that availability rule.
    // And the test pin closes the same way the persona pin does: the version
    // is the named test's, and the test is this project's, so a raw write
    // cannot pin another customer's test. Both pins are required.
    foreignKey({
      name: "simulation_test_version_test_fk",
      columns: [table.testVersionId, table.testId],
      foreignColumns: [testVersion.id, testVersion.testId],
    }),
    foreignKey({
      name: "simulation_test_project_fk",
      columns: [table.testId, table.projectId],
      foreignColumns: [test.id, test.projectId],
    }),
    // A run's conversations are an ordered list, and no place in it is
    // claimed twice.
    unique("simulation_run_id_position_unique").on(table.runId, table.position),
    // Both of these look redundant next to the primary key, and neither is:
    // they are the composite-foreign-key targets two different readers pair
    // on. A grading job proves the conversation it was written for is its own
    // project's; an event proves the conversation it describes is of the run
    // it names.
    unique("simulation_id_project_id_unique").on(table.id, table.projectId),
    unique("simulation_id_run_id_unique").on(table.id, table.runId),
    index("simulation_run_id_idx").on(table.runId),
    // The claim's hot path: the oldest queued simulations of one customer.
    index("simulation_queued_idx")
      .on(table.organizationId, table.id)
      .where(sql`${table.status} = 'queued'`),
    // The orphan sweep's: one customer's claimed and running rows, oldest
    // heartbeat first — the same shape the sweep's own where clause has.
    index("simulation_heartbeat_idx")
      .on(table.organizationId, table.heartbeatAt)
      .where(sql`${table.status} in ('claimed', 'running')`),
    // "Which simulations were conducted with version so-and-so" — the read
    // the orphan sweep of persona versions will one day ask — and the same
    // question by identity, which is what a persona's own erasure checks.
    index("simulation_persona_version_id_idx").on(table.personaVersionId),
    index("simulation_persona_id_idx").on(table.personaId),
    // The same two questions of the test pin — "which conversations were
    // conducted against version so-and-so", which is what a grader's reads
    // start from, and the same question by identity, which is how one test's
    // whole history is read across every version its runs pinned.
    index("simulation_test_version_id_idx").on(table.testVersionId),
    index("simulation_test_id_idx").on(table.testId),
    // What one organization executed in one period, which is the shape the
    // usage read asks in: this customer's conversations that began inside the
    // period's two instants. It is on `started_at` rather than `created_at`
    // because a period counts what ran in it, and a conversation queued in one
    // month can begin in the next. Rows that never began are skipped by the
    // range predicate itself, so the index needs no `where` of its own.
    index("simulation_organization_id_started_at_idx").on(
      table.organizationId,
      table.startedAt,
    ),
  ],
);

/**
 * Append-only run lifecycle events, numbered from one within each run.
 * Each event commits with the state change it describes. Sequence numbers
 * let clients replay missed transitions and deduplicate repeated pages.
 * Grader results live in the grade store and do not rewrite this log.
 */
export const runEvent = pgTable(
  "run_event",
  {
    runId: idText("run_id").notNull(),
    /**
     * Dense from one, within this run. Allocated under the run header's own
     * lock, which is what makes "dense" true rather than hoped for: two
     * writers landing at once take that lock in turn and number in turn.
     */
    seq: integer("seq").notNull(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    kind: text("kind").notNull(),
    /** The simulation that moved, and null when the run itself did. */
    simulationId: idText("simulation_id"),
    /**
     * What the thing that moved is now: a run status on a run event, a
     * simulation status on a simulation event. Never both vocabularies at
     * once — the checks below hold the kind to its own words.
     */
    status: text("status").notNull(),
    /** How it ended, in the ending-reason vocabulary; null while it has not. */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (table) => [
    // Its identity is its run and its number: an event is never addressed on
    // its own, and the pair is exactly what a follower asks by.
    primaryKey({ name: "run_event_pk", columns: [table.runId, table.seq] }),
    prefixCheck("run_event_run_id_prefix", table.runId, "run"),
    oneOf("run_event_kind_allowed", table.kind, [...RUN_EVENT_KINDS]),
    check("run_event_seq_counts_from_one", sql`${table.seq} >= 1`),
    // Each kind speaks its own vocabulary and carries its own facts. A run
    // event is about the header, so it names no simulation ending reason.
    check(
      "run_event_run_shape",
      sql`${table.kind} <> 'run'
        or (${table.simulationId} is null
          and ${table.reason} is null
          and ${table.status} in ${quoted(RUN_STATUSES)})`,
    ),
    check(
      "run_event_simulation_shape",
      sql`${table.kind} <> 'simulation'
        or (${table.simulationId} is not null
          and ${table.status} in ${quoted(SIMULATION_STATUSES)})`,
    ),
    // And the ending reason keeps to its own class, exactly as it does on the
    // simulation row it came from.
    check(
      "run_event_reason_agrees",
      sql`${table.reason} is null
        or (${table.status} = 'completed' and ${table.reason} in ${quoted(
          COMPLETED_ENDING_REASONS,
        )})
        or (${table.status} = 'failed' and ${table.reason} in ${quoted(
          FAILED_ENDING_REASONS,
        )})`,
    ),
    // The tenancy triangle, edge for edge as the simulation's: the project is
    // the organization's, the run is that project's, and the simulation named
    // is that run's — so an event cannot describe a conversation of a run it
    // does not belong to.
    foreignKey({
      name: "run_event_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "run_event_run_project_fk",
      columns: [table.runId, table.projectId],
      foreignColumns: [run.id, run.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "run_event_simulation_run_fk",
      columns: [table.simulationId, table.runId],
      foreignColumns: [simulation.id, simulation.runId],
    }).onDelete("cascade"),
  ],
);
