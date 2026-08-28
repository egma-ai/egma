import { sql } from "drizzle-orm";
import {
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

import { agent, connection, MODALITIES } from "./agents.ts";
import { personaVersion } from "./personas.ts";
import { test, testSuite, testVersion } from "./tests.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * A run is the trigger's record — who asked for simulations, when, how, and
 * what was requested. A simulation is one conversation inside it, born
 * `queued` before anything else happens, so nothing a team triggers can
 * silently vanish. A terminal run's numbers are frozen and never reopened.
 *
 * **A run executes frozen test versions.** Each simulation carries the exact
 * test version it conducts beside the persona who calls about it — so one test with three
 * personas is three conversations, and improving that test tomorrow rewrites
 * none of them. Every simulation always has both exact pins.
 *
 * Grader scores are the grader system's side of the line. The counts on this
 * header are simulation outcomes — did each conversation happen — never a
 * score or a grade of what happened in one.
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
 *              ↘ queued
 *
 * `claimed → queued` releases a lease when a bounded provider preflight could
 * not answer before dispatch. It clears every claim fact in the same write;
 * the queued-shape constraint refuses a partial release. `queued → canceled`
 * is the cancel-before-claim path, and a canceled row can never be claimed. A
 * terminal row is frozen entirely.
 *
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
 * Why a simulation never produced a conversation to grade. These must never
 * collapse into "the agent behaved badly": an agent that never joined, a line
 * that was never answered, a platform out of capacity, egma's own error, and
 * a simulator that died mid-conversation are all "the test never ran", and
 * grading any of them as a failure is the false red a test product cannot
 * afford.
 *
 * The last two are the platform's own words, never a simulator's report:
 * `orphaned` is the sweep's finding that a simulator stopped answering,
 * and `dispatch_failed` is the claim path's confession that it could not turn
 * a claimed row into a spec worth handing over — a broken row is the
 * platform's fault, never pinned on a simulator that was handed nothing.
 */
export const FAILED_ENDING_REASONS = [
  "agent_never_joined",
  "not_answered",
  "capacity",
  "simulator_error",
  "orphaned",
  "dispatch_failed",
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
     * The mocked world this run executes in, resolved once and frozen here.
     *
     * Mock tools are the one authored thing that is not versioned, so nothing
     * else could hold a run still: editing one tomorrow would silently change
     * what a simulation of this run was answered, and a run half-conducted
     * under two worlds is a run whose numbers mean nothing. Resolving at
     * creation is what makes "every simulation in one run sees one world" a
     * fact about the row rather than a hope about timing.
     *
     * It holds the project's mock tools that apply to this run's agent, with
     * scoping already applied. Test overrides remain on the immutable
     * test-version rows that each Simulation pins. A Simulation evidence read
     * joins only its own version to these defaults, so no run-header read grows
     * with the number of tests in the Suite.
     *
     * A run whose project answers for no tool holds the explicit final shape:
     * `{ defaults: [], overrides: {} }`.
     */
    mockToolSnapshot: jsonb("mock_tool_snapshot").notNull(),
    /**
     * The temporary world this run built on the agent's platform, or null when
     * it built none — which is what most runs are.
     *
     * **Written for the teardown and for the sweep, not for the reader.** It
     * holds the version the run branched from, the temporary version it minted,
     * the engine that version runs on, and **every touched number's inbound
     * bindings exactly as they were read** — so teardown puts a binding back
     * rather than rebuilding one out of the two fields egma happened to look
     * at, and a later sweep can finish what a crashed run left: delete the
     * stray version, then restore the pin it recorded here.
     *
     * It also carries the three-class coverage stamp of the configuration the
     * temporary version was built from, which is what lets a simulation say how
     * isolated it really was without asking the platform again mid-run.
     *
     * Nullable, and null means one thing only: this run built no mocked world.
     * An unmocked run and a mocked run whose world is still being built are
     * told apart by the run's own status, not by a second empty shape here.
     */
    mockedWorld: jsonb("mocked_world"),
    /**
     * The world this run **read** at its start and conducts against: the
     * serving agent version it resolved once, the engine that version runs on,
     * and the three-class coverage stamp of that version's tools.
     *
     * **The opposite record to `mocked_world` beside it.** That one exists so a
     * teardown can put back what egma changed on somebody's platform. This one
     * exists because egma changed nothing: on a lane where the mocked answers
     * ride each request, there is no draft to sweep and no binding to restore,
     * and the only thing worth remembering is what was read.
     *
     * It is therefore inside the header's freeze rather than carved out of it.
     * The version is settled before the first simulation is claimed, and every
     * request from then on names it — because the platform's own default is
     * "the newest version", and the newest version is exactly the one a
     * concurrent edit has just made.
     *
     * Nullable, and null means one thing: this run pinned no platform version.
     */
    conductedWorld: jsonb("conducted_world"),
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
    // What the agent's own hard delete checks, and the per-agent history read
    // when it arrives; the id-ordered pair above already serves every list.
    index("run_agent_id_idx").on(table.agentId),
    index("run_suite_id_idx").on(table.suiteId),
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
    /**
     * What was being checked, and the pin — the persona pin's shape exactly,
     * for the same reason. The version is frozen content, so this row says
     * exactly what was executed for as long as it is kept, and editing the
     * test tomorrow rewrites nothing — which is where a grader's reads start.
     * The identity rides beside the version because it is what the composite
     * keys below pair on: the version is this test's, and the test is this
     * project's.
     *
     * Required on every row. `startRun` names both pins for every conversation.
     */
    testId: idText("test_id").notNull(),
    testVersionId: idText("test_version_id").notNull(),
    /** Where in the run's requested order this conversation sits, from one. */
    position: integer("position").notNull(),
    /**
     * The connection's modality as it was at execution — the one thing about
     * the connection this row keeps its own copy of, and it keeps it because
     * its own check names it. `simulation_audio_facts_are_voice_facts` below
     * refuses a recording on a conversation that was not voice, and a Postgres
     * CHECK cannot join: the column it compares has to
     * sit on the row it guards. Reaching the connection for it instead would
     * make that guarantee a trigger — a second mechanism on the report-write
     * path, and one an operator can switch off — so the fact rides here
     * rather than being looked up.
     */
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
     * no trace context crosses an audio channel. Verbatim from the report,
     * never parsed; null when the plug had none to offer.
     */
    providerReference: text("provider_reference"),
    /**
     * Which of the agent's tools mock tools answered for, and which reached
     * their real implementations — `{discovered, covered, uncovered}`, the
     * three name lists the report's stamp carries.
     *
     * On the row rather than worked out from the conversation's spans,
     * because it is the answer to "did mock tools change the world this
     * simulation met", and that question has to be answerable from the
     * simulation alone with nothing else to consult.
     *
     * Three states, and the third is why this is nullable rather than
     * defaulted: null means the agent was never asked what tools it has, so
     * nothing was learned and nothing is claimed — every row written before
     * this column, and every connection egma stands outside the tool path of.
     * Three empty lists is the other absence: the asking happened and no tool
     * came back.
     */
    mockToolCoverage: jsonb("mock_tool_coverage"),
    /**
     * Which version of the agent this one conversation was conducted against,
     * as the platform numbers its versions.
     *
     * **Evidence pins at the evidence grain.** The run's header already holds
     * the version it resolved, and that is not enough: a result is read at the
     * simulation, a grader's reads start there, and a reader asking "what did
     * this conversation actually test" must not have to fetch a second row to
     * find out. Copied from the run's own resolved value in the same
     * transaction that writes the row, so the two cannot disagree.
     *
     * Written at creation rather than at landing, unlike the terminal facts
     * above it: the version is decided before anything is conducted, and a
     * conversation that failed still says which version it failed against.
     *
     * Null means the lane pinned no version — every connection whose platform
     * has no versions to name, and every row written before this column.
     */
    conductedAgentVersion: integer("conducted_agent_version"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("simulation_id_prefix", table.id, "sim"),
    oneOf("simulation_status_allowed", table.status, [...SIMULATION_STATUSES]),
    oneOf("simulation_modality_allowed", table.modality, [...MODALITIES]),
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
    // The recording is a terminal fact; nothing running holds one yet. The
    // check keeps its name because a constraint's name is what a violation
    // prints, and renaming one would break the sentence a reader searches for.
    check(
      "simulation_report_only_when_ended",
      sql`${table.endedAt} is not null
        or ${table.recordingReference} is null`,
    ),
    // The two summary facts are terminal facts too; a check of their own
    // beside the report's rather than a rewrite of it, because they arrived
    // by a later migration and an additive column takes an additive guard.
    check(
      "simulation_summary_facts_only_when_ended",
      sql`${table.endedAt} is not null
        or (${table.turnCount} is null and ${table.providerReference} is null)`,
    ),
    check(
      "simulation_turn_count_is_a_count",
      sql`${table.turnCount} is null or ${table.turnCount} >= 0`,
    ),
    // The coverage stamp is a terminal fact too, and gets its own additive
    // guard for the same reason the two above did.
    check(
      "simulation_mock_tool_coverage_only_when_ended",
      sql`${table.endedAt} is not null or ${table.mockToolCoverage} is null`,
    ),
    // A version is a whole number of versions. No "only when ended" guard
    // beside it, deliberately: unlike every terminal fact above, this one is
    // known before the conversation starts and is written with the row.
    check(
      "simulation_conducted_agent_version_is_a_version",
      sql`${table.conductedAgentVersion} is null
        or ${table.conductedAgentVersion} >= 0`,
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
  ],
);

/**
 * Everything that has changed about a run, in the order it changed, numbered
 * densely from one within the run.
 *
 * **A row lands here in the same transaction as the change it describes.** A
 * simulation moving or the run's own header settling writes its event beside
 * itself, or neither is written. That is what makes the feed a record rather
 * than a guess. Grader results live in the grade store and do not rewrite this
 * lifecycle log.
 *
 * **Deriving the feed from the run and simulation rows was rejected.** Those
 * rows are overwritten by every transition, so a follower that was away while a
 * simulation went `claimed → running → completed` could never learn it had
 * happened — it would see only where things ended. A log can be replayed from
 * any point; a mutable row cannot be replayed at all.
 *
 * **The number, not the clock, is the cursor.** A follower asks for everything
 * after the last number it applied, so a crash and a restart miss nothing, and
 * a page served twice is harmless because applying the same number twice is the
 * client's own no-op. The server is stateless about who has read what.
 *
 * The row is written once and never rewritten — a trigger in the migration says
 * so, the way the two lifecycle guards do.
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
