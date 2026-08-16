import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  max,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import {
  agent,
  connection,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { persona } from "../schema/personas.ts";
import { openCredentials } from "../sealing.ts";
import { test, testVersion, testPersona } from "../schema/tests.ts";
import {
  COMPLETED_ENDING_REASONS,
  FAILED_ENDING_REASONS,
  run,
  runEvent,
  simulation,
  type RunEventKind,
  type RunStatus,
  type RunTrigger,
  type SimulationEndingReason,
  type SimulationStatus,
  type Verdict,
} from "../schema/runs.ts";
import {
  NO_MOCK_TOOLS,
  type MockToolSnapshot,
  type SnapshotDefault,
  type SnapshotEntry,
} from "../mock-tools/resolve.ts";
import { stringRecordFromRow } from "./agents.ts";
import { validClaimant } from "./claimants.ts";
import { descriptorOf, noSimulatorAdapterMessage } from "./connection-registry.ts";
import type { AuthContext } from "./context.ts";
import { RunWriteRefusedError, type RunWriteRefusal } from "./errors.ts";
import { enqueueGradingJob } from "./grading.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { mockToolsApplyingTo } from "./mock-tools.ts";
import {
  getTestVersion,
  mockOverridesOfVersions,
  type TestVersion,
} from "./tests.ts";
import { within } from "./within.ts";

/**
 * Reading and writing runs and their simulations — what they are is the schema
 * file's story (`schema/runs.ts`); this file is how they are reached.
 *
 * Two kinds of caller share it. A person starts a run, cancels one, and reads
 * what happened; the simulator claims queued simulations, heartbeats
 * while conducting them, and reports how each one ended. Both come through the
 * same seam on the same terms: every function takes the context, and the run
 * machinery is gated by `start_and_cancel_runs` throughout, because claiming
 * and reporting a simulation *is* conducting the run somebody started.
 *
 * Four exceptions, drawn on the grading queue's precedent and as narrowly:
 * `claimSimulations`, `recordSimulationHeartbeat`, `sweepOrphanedSimulations`
 * and `resolveSimulationStanding` take no context and cannot be given one,
 * because each stands where the simulator does — behind every organization on
 * the deployment at once, with no honest credential to give it. The claim
 * hands work out; the heartbeat keeps one dispatch alive and steers it; the
 * sweep accounts for dispatches whose simulator died; the standing resolver
 * answers where one dispatched row now stands, for the calls that come back
 * about it — its lifecycle claims and its arriving telemetry alike. All four
 * reach only rows egma's own machinery wrote — the queue,
 * and the claims made from it — and carry out identifiers and no content.
 * The claim hands back with every row the context the conducting is then
 * done under, built from the row's own tenancy and from nothing the service
 * said; the standing resolver derives that same context again from the row,
 * and the other two derive their narrowness the same way, from the row
 * rather than from any caller.
 * `resolveSimulationConnection` and `failSimulationDispatch` are the two
 * doors only such a claim-minted context may open — the secret the dispatch
 * needs, and the honest landing when the dispatch cannot happen — and each
 * refuses every other kind. The whole argument is written out on the
 * functions themselves.
 *
 * Writers keep to one lock order — simulation rows first, the run header last
 * — so the claim path, the cancel path and the report path do not deadlock
 * each other. (Two bulk simulation writes racing over one set can still, in
 * principle, collide over row order inside a statement; Postgres aborts one
 * and both callers here are retried by their nature — a sweep re-runs, a
 * cancel is re-asked.) The header is finalized under its own row lock by
 * whichever terminal transition lands last, which is what lets the counts be
 * written once, together, and never by two writers at once.
 *
 * **Every lifecycle change writes its numbered event beside itself, in the
 * same transaction.** A follower reads that record rather than the rows, which
 * is what lets it be away and come back: the rows say only where things ended,
 * and the record says everything that happened. The numbering is dense per run
 * and is allocated under the header's own lock, so the one lock order above
 * covers the events too.
 */

export type NewRun = {
  /**
   * The agent the connection has to be on, when the caller wants that
   * checked. Left out, the connection names its own agent — a connection is
   * only ever reached through one.
   */
  readonly agentId?: string | undefined;
  readonly connectionId: string;
  /**
   * The frozen test versions to execute, in the order they should be
   * conducted. Explicit, never "whatever is current when this runs": what
   * executed is the whole of what a result means, and it is what every
   * simulation this run writes pins for the graders to judge against.
   *
   * The personas are not named here. Each version already names the people who
   * call about it, so naming them again would be a second selection free to
   * disagree with the test's own.
   */
  readonly testVersionIds: readonly string[];
  /** Something to recognise the run by in a list. */
  readonly label?: string | undefined;
  /** The run this one retries, when it retries one. */
  readonly retryOfRunId?: string | undefined;
};

/** The connection's non-secret shape as the run executed over it. */
export type ConnectionSnapshot = {
  readonly type: ConnectionType;
  readonly modality: Modality;
  readonly topology: Topology;
  readonly environment: string | null;
  readonly config: unknown;
};

export type Run = {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly label: string | null;
  readonly status: RunStatus;
  readonly triggeredVia: RunTrigger;
  readonly triggeredBy: string | null;
  /** The versions this run was asked to execute, in the order they were named. */
  readonly pinnedTestVersionIds: readonly string[];
  /** The personas those versions named — provenance, never the pin. */
  readonly requestedPersonaIds: readonly string[];
  readonly connectionSnapshot: ConnectionSnapshot;
  /**
   * The mocked world this run executes in, frozen at creation: the project's
   * mock tools that apply to its agent, and what each pinned version overrode.
   * `resolveMockTools` turns it into what one simulation is served.
   */
  readonly mockToolSnapshot: MockToolSnapshot;
  readonly expectedSimulationCount: number;
  /** Null until the last simulation lands terminal; then written once. */
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly retryOfRunId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

export type StartedRun = Run & {
  /** Born `queued`, one per test per persona, in the order they were named. */
  readonly simulations: readonly ConductedSimulation[];
};

export type Simulation = {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** Who called, by identity… */
  readonly personaId: string;
  /** …and the pin: exactly as they were, for as long as this row is kept. */
  readonly personaVersionId: string;
  /**
   * What is being checked, by identity, and the pin: the frozen version this
   * conversation executed, which is where a grader's reads start. Both absent
   * together on a row written before a simulation could carry either — an
   * upgraded instance's history, saying it executed no stored test rather than
   * naming one it did not.
   */
  readonly testId: string | null;
  readonly testVersionId: string | null;
  readonly position: number;
  readonly modality: Modality;
  readonly status: SimulationStatus;
  readonly endingReason: SimulationEndingReason | null;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly measuredAudioBandHertz: number | null;
  readonly recordingReference: string | null;
  /** How many transcript turns the conversation reached, both speakers counted. */
  readonly turnCount: number | null;
  /** The platform's own identifier for the exchange — the one join to the agent's telemetry. */
  readonly providerReference: string | null;
  /**
   * Which of the agent's tools mock tools answered for. Null where the agent
   * was never asked what tools it has, so nothing was learned and nothing is
   * claimed — which is what every row written before the stamp existed says.
   */
  readonly mockToolCoverage: MockToolCoverage | null;
  readonly createdAt: Date;
};

/**
 * The coverage stamp as the row holds it: three lists of the agent's own tool
 * names.
 *
 * `covered` may name a tool absent from `discovered` — coverage is registered
 * by name against the whole simulation, while discovery is only what the agent
 * has said about itself — and `uncovered` is written out rather than left to be
 * worked out, because a reader asking "was this simulation isolated" should not
 * have to do set arithmetic to find out.
 */
export type MockToolCoverage = {
  readonly discovered: readonly string[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
};

/**
 * One simulation as a reader of a run meets it: the row, plus the two names
 * that make it readable by a person.
 *
 * The names are joined at read time rather than copied onto the row, so a test
 * or a persona renamed today reads under its current name everywhere at once —
 * a stored copy would leave a run's page and its feed disagreeing about what
 * the same conversation is called. What must never move is the *content*, and
 * that is pinned by the version columns rather than by the name.
 */
export type ConductedSimulation = Simulation & {
  /** Absent exactly where the pin is: a conversation with no test to name. */
  readonly testName: string | null;
  readonly personaName: string;
};

export type CompletedEndingReason = (typeof COMPLETED_ENDING_REASONS)[number];
export type FailedEndingReason = (typeof FAILED_ENDING_REASONS)[number];

/**
 * The summary facts any terminal landing may carry, whatever its status: what
 * the conversation reached, how the platform names it, what the audio
 * measured, and the two moments the conduction itself stamped. Each is
 * optional because a report may honestly hold none — a chat has no band, a
 * plug may offer no reference — and everything given lands on the row as the
 * terminal record.
 *
 * The moments are the simulator's own, not the arrival's: a report retried
 * through a partition must not stretch the record by however long delivery
 * took, so a landing given them writes them over its own stamps. Given is
 * the caller's word to keep honest: the report door hands a pair over
 * exactly when it can be true — an `ended_at` before its `started_at` is
 * declined there, and the landing's own stamps stand for both.
 */
export type SimulationSummaryFacts = {
  /** How many transcript turns were reached, both speakers counted. */
  readonly turnCount?: number | undefined;
  /** The platform's own identifier for the exchange, verbatim. */
  readonly providerReference?: string | undefined;
  /** Measured, never declared; a chat simulation reports none. */
  readonly measuredAudioBandHertz?: number | undefined;
  readonly recordingReference?: string | undefined;
  /**
   * Which tools were answered by mock tools and which ran for real. Absent
   * where the report carried no stamp, which is the honest reading of a
   * conversation whose agent was never asked what tools it has.
   */
  readonly mockToolCoverage?: MockToolCoverage | undefined;
  readonly startedAt?: Date | undefined;
  readonly endedAt?: Date | undefined;
};

/**
 * What the simulator reports about a conversation that happened: how it
 * ended, and the summary facts.
 *
 * What was *said* is not here and is not on the row. A conversation is its
 * spans, streamed to the trace store's own ingest while it happens, so a
 * landing records that the conversation is over rather than recording the
 * conversation — and the evidence is already stored by the time it does,
 * because the simulator puts both through one ordered sender.
 */
export type SimulationReport = SimulationSummaryFacts & {
  readonly endingReason: CompletedEndingReason;
};

/**
 * What the simulator reports about a simulation that never produced a
 * conversation to grade — or died producing one, in which case whatever it
 * streamed before it died is the honest "started, never finished" record.
 *
 * Two reasons are deliberately not a simulator's to give, because each is
 * the platform's account of its own failure: `orphaned` is the sweep's word
 * for a simulator that stopped answering, and one still answering cannot
 * claim it; `dispatch_failed` is the claim path's word for a spec it never
 * handed over, which a simulator with something to report evidently
 * received.
 */
export type SimulationFailure = SimulationSummaryFacts & {
  readonly reason: Exclude<FailedEndingReason, "orphaned" | "dispatch_failed">;
};

/** An answer's columns, and no more — the tenant-free view. */
const RUN_COLUMNS = {
  id: run.id,
  projectId: run.projectId,
  agentId: run.agentId,
  connectionId: run.connectionId,
  label: run.label,
  status: run.status,
  triggeredVia: run.triggeredVia,
  triggeredBy: run.triggeredBy,
  pinnedTestVersions: run.pinnedTestVersions,
  requestedPersonas: run.requestedPersonas,
  connectionSnapshot: run.connectionSnapshot,
  mockToolSnapshot: run.mockToolSnapshot,
  expectedSimulationCount: run.expectedSimulationCount,
  completedCount: run.completedCount,
  failedCount: run.failedCount,
  canceledCount: run.canceledCount,
  retryOfRunId: run.retryOfRunId,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdAt: run.createdAt,
} as const;

const SIMULATION_COLUMNS = {
  id: simulation.id,
  runId: simulation.runId,
  projectId: simulation.projectId,
  agentId: simulation.agentId,
  connectionId: simulation.connectionId,
  personaId: simulation.personaId,
  personaVersionId: simulation.personaVersionId,
  testId: simulation.testId,
  testVersionId: simulation.testVersionId,
  position: simulation.position,
  modality: simulation.modality,
  status: simulation.status,
  endingReason: simulation.endingReason,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
  heartbeatAt: simulation.heartbeatAt,
  cancelRequestedAt: simulation.cancelRequestedAt,
  startedAt: simulation.startedAt,
  endedAt: simulation.endedAt,
  measuredAudioBandHertz: simulation.measuredAudioBandHertz,
  recordingReference: simulation.recordingReference,
  turnCount: simulation.turnCount,
  providerReference: simulation.providerReference,
  mockToolCoverage: simulation.mockToolCoverage,
  createdAt: simulation.createdAt,
} as const;

/** What a `RUN_COLUMNS` select answers with, before the jsonb is read. */
type RunRow = {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly label: string | null;
  readonly status: string;
  readonly triggeredVia: string;
  readonly triggeredBy: string | null;
  readonly pinnedTestVersions: unknown;
  readonly requestedPersonas: unknown;
  readonly connectionSnapshot: unknown;
  readonly mockToolSnapshot: unknown;
  readonly expectedSimulationCount: number;
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly retryOfRunId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

/**
 * More conversations than this in one run is a selection nobody typed by hand,
 * and `expected_simulation_count` is the denominator a progress page divides by
 * — it should be a number a person can watch count up.
 */
const MOST_SIMULATIONS_PER_RUN = 200;

/** How many queued simulations one claim may take, however large the fleet. */
const LARGEST_CLAIM_CAPACITY = 50;

/**
 * How long a claimed or running simulation may go silent before the sweep
 * calls it orphaned.
 *
 * The window is set against the report, not the heartbeat. The simulator's
 * report sender retries a terminal document for up to two minutes before it
 * abandons delivery, so a partition can swallow every heartbeat and still end
 * in time for the report to land — and a window shorter than that deadline
 * would let the sweep write `orphaned` over a conversation that genuinely
 * finished, minutes before its own record arrived to say so. 150 seconds
 * outlasts the retrying with room to spare, and against a beat every few
 * seconds it is dozens of missed beats — never a simulator that is merely
 * slow. The cost, accepted: a truly crashed simulator's rows stay `running`
 * for up to about three minutes before the honest `failed`.
 */
const DEFAULT_STALE_AFTER_SECONDS = 150;

/**
 * The failure reasons a simulator may give — everything but the platform's
 * own two words: `orphaned` is the sweep's, `dispatch_failed` the claim
 * path's. The types already say so; this is the backstop for the caller the
 * types could not see.
 */
const REPORTABLE_FAILURE_REASONS: readonly FailedEndingReason[] =
  FAILED_ENDING_REASONS.filter(
    (reason) => reason !== "orphaned" && reason !== "dispatch_failed",
  );

/**
 * The summary facts as one landing will write them: checked, trimmed, and
 * holding only the keys that were actually given — an absent fact must not
 * become a written null over a column another path may already have filled.
 * One helper, because all three landings owe the same facts on the same
 * terms, and three copies of the checks would drift.
 */
function summaryFactsWrite(
  facts: SimulationSummaryFacts,
): Record<string, unknown> {
  const write: Record<string, unknown> = {};

  const { turnCount, providerReference, measuredAudioBandHertz } = facts;
  if (turnCount !== undefined) {
    if (!Number.isInteger(turnCount) || turnCount < 0) {
      throw new Error(
        "a turn count is a whole number of turns, zero or more",
      );
    }
    write.turnCount = turnCount;
  }
  if (providerReference !== undefined) {
    write.providerReference = providerReference.trim() || null;
  }
  if (measuredAudioBandHertz !== undefined) {
    if (!Number.isInteger(measuredAudioBandHertz) || measuredAudioBandHertz <= 0) {
      throw new Error(
        "a measured audio band is a positive whole number of hertz",
      );
    }
    write.measuredAudioBandHertz = measuredAudioBandHertz;
  }
  if (facts.recordingReference !== undefined) {
    write.recordingReference = facts.recordingReference.trim() || null;
  }
  if (facts.mockToolCoverage !== undefined) {
    // Stored in the shape it is read in, which is the shape the report
    // carried — three lists of the agent's own names. Copied rather than
    // referenced so a caller holding the object cannot edit what was landed.
    const { discovered, covered, uncovered } = facts.mockToolCoverage;
    write.mockToolCoverage = {
      discovered: [...discovered],
      covered: [...covered],
      uncovered: [...uncovered],
    };
  }
  if (facts.startedAt !== undefined) write.startedAt = facts.startedAt;
  if (facts.endedAt !== undefined) write.endedAt = facts.endedAt;

  return write;
}

/**
 * The shape guards on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller wearing a type it does not have.
 */
function idListFromRow(
  value: unknown,
  key: string,
  options: { readonly malformed: () => Error; readonly mayBeEmpty: boolean },
): readonly string[] {
  const { malformed } = options;
  if (typeof value !== "object" || value === null) throw malformed();
  const held = (value as Record<string, unknown>)[key];
  if (!Array.isArray(held)) throw malformed();
  if (held.length === 0 && !options.mayBeEmpty) throw malformed();
  for (const id of held) {
    if (typeof id !== "string") throw malformed();
  }
  return held as string[];
}

function requestedPersonaIdsFromRow(
  value: unknown,
  runId: string,
): readonly string[] {
  return idListFromRow(value, "personaIds", {
    mayBeEmpty: false,
    malformed: () =>
      new Error(
        `run ${runId} holds a requested-persona selection in a shape Egma never writes; the row needs repairing before anybody can read it`,
      ),
  });
}

function pinnedTestVersionIdsFromRow(
  value: unknown,
  runId: string,
): readonly string[] {
  // Empty is readable, and means what the migration that added the column
  // wrote down: a run from before a run could pin a version at all.
  return idListFromRow(value, "testVersionIds", {
    mayBeEmpty: true,
    malformed: () =>
      new Error(
        `run ${runId} holds a pinned-version selection in a shape Egma never writes; the row needs repairing before anybody can read it`,
      ),
  });
}

function connectionSnapshotFromRow(
  value: unknown,
  runId: string,
): ConnectionSnapshot {
  const malformed = () =>
    new Error(
      `run ${runId} holds a connection snapshot in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { type, modality, topology, environment, config } = value as Record<
    string,
    unknown
  >;
  if (typeof type !== "string" || typeof modality !== "string") throw malformed();
  if (typeof topology !== "string") throw malformed();
  if (environment !== null && typeof environment !== "string") throw malformed();

  return {
    type: type as ConnectionType,
    modality: modality as Modality,
    topology: topology as Topology,
    environment,
    config,
  };
}

/**
 * The frozen mocked world, read back.
 *
 * An older row holds `{}` — the migration wrote it for every run that existed
 * before a run could freeze a world at all — and it reads as a run that mocked
 * nothing, which is exactly what those runs did. Everything else is checked to
 * the shape this file writes, so a hand-edited row fails loudly here rather
 * than reaching a simulator as a world nobody authored.
 */
function mockToolSnapshotFromRow(
  value: unknown,
  runId: string,
): MockToolSnapshot {
  const malformed = () =>
    new Error(
      `run ${runId} holds a mock tool snapshot in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const { defaults, overrides } = value as Record<string, unknown>;
  if (defaults === undefined && overrides === undefined) return NO_MOCK_TOOLS;
  if (!Array.isArray(defaults)) throw malformed();
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    throw malformed();
  }

  const entryFromRow = (entry: unknown): SnapshotEntry => {
    if (typeof entry !== "object" || entry === null) throw malformed();
    const { toolName, answer, delayMilliseconds } = entry as Record<
      string,
      unknown
    >;
    if (typeof toolName !== "string" || toolName === "") throw malformed();
    if (typeof delayMilliseconds !== "number") throw malformed();
    if (typeof answer !== "object" || answer === null) throw malformed();
    const held = answer as Record<string, unknown>;
    if ("error" in held) {
      if (typeof held.error !== "string" || held.error === "") throw malformed();
      return { toolName, delayMilliseconds, answer: { error: held.error } };
    }
    if (!("answer" in held)) throw malformed();
    return { toolName, delayMilliseconds, answer: { answer: held.answer } };
  };

  return {
    defaults: defaults.map((entry): SnapshotDefault => {
      const { mockToolId } = (entry ?? {}) as Record<string, unknown>;
      if (typeof mockToolId !== "string" || mockToolId === "") throw malformed();
      return { ...entryFromRow(entry), mockToolId };
    }),
    overrides: Object.fromEntries(
      Object.entries(overrides as Record<string, unknown>).map(
        ([versionId, entries]) => {
          if (!Array.isArray(entries)) throw malformed();
          return [versionId, entries.map(entryFromRow)] as const;
        },
      ),
    ),
  };
}

function runFromRow(row: RunRow): Run {
  const {
    pinnedTestVersions,
    requestedPersonas,
    connectionSnapshot,
    mockToolSnapshot,
    status,
    triggeredVia,
    ...rest
  } = row;
  return {
    ...rest,
    status: status as RunStatus,
    triggeredVia: triggeredVia as RunTrigger,
    pinnedTestVersionIds: pinnedTestVersionIdsFromRow(
      pinnedTestVersions,
      row.id,
    ),
    requestedPersonaIds: requestedPersonaIdsFromRow(requestedPersonas, row.id),
    connectionSnapshot: connectionSnapshotFromRow(connectionSnapshot, row.id),
    mockToolSnapshot: mockToolSnapshotFromRow(mockToolSnapshot, row.id),
  };
}

/** What a `SIMULATION_COLUMNS` select answers with: the enumerated columns
 * still wearing `string`. The checks and the trigger keep the stored values
 * inside the vocabulary, so reading one back is a narrowing, not a guess. */
type SimulationRow = Omit<
  Simulation,
  "status" | "endingReason" | "modality" | "mockToolCoverage"
> & {
  readonly status: string;
  readonly endingReason: string | null;
  readonly modality: string;
  readonly mockToolCoverage: unknown;
};

function simulationFromRow(row: SimulationRow): Simulation {
  return {
    ...row,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    modality: row.modality as Modality,
    mockToolCoverage: mockToolCoverageFromRow(row.mockToolCoverage, row.id),
  };
}

/**
 * The shape guard the coverage stamp gets on every read, for the reason the
 * jsonb columns beside it get one: stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller wearing a type it does not have.
 *
 * Null is not a malformed stamp — it is the honest "nobody ever asked", which
 * every row written before the column existed carries. `undefined` is not that
 * and is not tolerated: it means the column was never selected, and answering
 * a read that did not ask with the sentence for a simulation nobody asked is
 * how a query bug becomes a claim about somebody's agent.
 */
function mockToolCoverageFromRow(
  value: unknown,
  simulationId: string,
): MockToolCoverage | null {
  if (value === null) return null;

  const malformed = (): Error =>
    new Error(
      `simulation ${simulationId} holds a mock tool coverage stamp in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const held = value as Record<string, unknown>;

  const names = (key: keyof MockToolCoverage): readonly string[] => {
    const list = held[key];
    if (!Array.isArray(list)) throw malformed();
    for (const name of list) {
      if (typeof name !== "string") throw malformed();
    }
    return list as string[];
  };

  return {
    discovered: names("discovered"),
    covered: names("covered"),
    uncovered: names("uncovered"),
  };
}

/**
 * One change, as it is about to be written: what moved, and what it now says.
 *
 * A run event is about the header and carries no judgement of a conversation;
 * a simulation event is about one conversation and carries the verdict from
 * the day there is one to carry. The union is what stops an event being
 * written half in one vocabulary and half in the other, and the migration's
 * checks say the same thing again in the database.
 */
type NewRunEvent =
  | { readonly kind: "run"; readonly status: RunStatus }
  | {
      readonly kind: "simulation";
      readonly simulationId: string;
      readonly status: SimulationStatus;
      readonly verdict?: Verdict | undefined;
      readonly reason?: SimulationEndingReason | null | undefined;
    };

/**
 * The events for one run, appended in the same transaction as the change they
 * describe.
 *
 * **The header's own row lock is what makes the numbers dense.** Two writers
 * landing at the same instant — a report and a cancel, two reports of one run —
 * take that lock in turn and therefore number in turn, so the sequence has no
 * holes and no repeats and a follower asking "everything after 7" can never be
 * handed a 7 later. Taking it here also keeps the module's one lock order:
 * simulation rows first, the run header last, and an append is the last thing
 * every writer does.
 *
 * It is called with every event of one transaction at once rather than once
 * per event, so the lock is taken once and the order inside the transaction is
 * decided by the caller who knows what happened first.
 */
async function appendRunEvents(
  tx: Transaction,
  runId: string,
  at: Date,
  events: readonly NewRunEvent[],
): Promise<void> {
  if (events.length === 0) return;

  // Bare `eq`: the run id came off a tenancy-checked row in this same
  // transaction, so this cannot reach further than that check already did.
  const [header] = await tx
    .select({
      organizationId: run.organizationId,
      projectId: run.projectId,
    })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
    .for("update");

  if (header === undefined) {
    throw new Error(
      `run ${runId} changed and is not there to record the change against`,
    );
  }

  const [highest] = await tx
    .select({ seq: max(runEvent.seq) })
    .from(runEvent)
    .where(eq(runEvent.runId, runId));

  let seq = highest?.seq ?? 0;
  await tx.insert(runEvent).values(
    events.map((event) => {
      seq += 1;
      return {
        runId,
        seq,
        organizationId: header.organizationId,
        projectId: header.projectId,
        kind: event.kind,
        simulationId: event.kind === "simulation" ? event.simulationId : null,
        status: event.status,
        verdict: event.kind === "simulation" ? (event.verdict ?? null) : null,
        reason: event.kind === "simulation" ? (event.reason ?? null) : null,
        createdAt: at,
      };
    }),
  );
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(
  auth: AuthContext,
  table: typeof run | typeof simulation | typeof runEvent,
): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(table.projectId, auth.projectId);
}

/** The named run, within the caller's tenancy and scope. */
function theRun(auth: AuthContext, id: string): SQL {
  return within(auth, run, and(eq(run.id, id), inActingProject(auth, run)));
}

/**
 * Whether landing in this state makes the conversation something to judge.
 *
 * A conversation happened, or a simulation failed trying to have one: both are
 * graded, and the difference between them is what the verdicts say rather than
 * whether there are any — a simulation that never ran gets `errored` verdicts,
 * because a broken test is never a broken agent. A `canceled` simulation is
 * neither: nobody was told to stop conducting it and then judged for stopping.
 */
function isGradable(status: SimulationStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * The terminal transition also makes the work.
 *
 * Called inside the transaction that landed it, so the row that says a
 * conversation is over and the row that says it needs judging are one commit —
 * a conversation cannot land and leave no work behind, and there is no window
 * for a sweep of forgotten simulations to exist in. The notification the
 * enqueue raises travels on the same transaction and so reaches a listening
 * grader the moment the transition is visible to it.
 *
 * The tenancy the work is filed under comes in with the row rather than from
 * any context, because not every caller has one: a landing reached its row
 * through `within` and passes the context's organization, which is the row's
 * by construction; the sweep holds no context at all and passes what the row
 * itself says — either way, the job lands inside the customer the simulation
 * belongs to.
 */
async function makeGradable(
  tx: Transaction,
  row: {
    readonly id: string;
    readonly status: string;
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<void> {
  if (!isGradable(row.status as SimulationStatus)) return;
  await enqueueGradingJob(tx, {
    organizationId: row.organizationId,
    projectId: row.projectId,
    source: "simulation",
    simulationId: row.id,
  });
}

/**
 * Every refusal this file makes, in the one shape a layer above branches on.
 *
 * The reason is the whole `RunWriteRefusal` rather than a hand-copied subset:
 * a copy would go stale the first time the vocabulary grew, and it would go
 * stale silently. The sentence is whole here too — a layer above relays it
 * word for word, so a half-sentence finished somewhere else would be a
 * contract that exists nowhere as one string.
 */
function refuseRun(reason: RunWriteRefusal, message: string): never {
  throw new RunWriteRefusedError(reason, message);
}

/** What a caller does instead, when a run named the wrong agent. */
const NAME_THE_RIGHT_AGENT =
  "Name the agent that connection is on, or leave the agent out and Egma " +
  "takes the connection's own.";

/**
 * A completed run has nothing left to cancel, and what to do about it.
 *
 * One builder, because the same sentence is owed at two moments — before the
 * lock and after losing the race for it — and two copies of a contract
 * sentence are two things to keep in step by hand.
 */
function nothingLeftToCancel(runId: string): string {
  return (
    `run ${runId} is completed, and a completed run has nothing left to ` +
    `cancel. Its counts are final; start a fresh run to conduct those tests ` +
    `again.`
  );
}

/**
 * Everything about the named versions that is answerable without the database:
 * there is at least one, and each is named once.
 *
 * Naming one twice is refused rather than folded, because the two readings —
 * "you meant it once" and "run it twice" — are both plausible and only the
 * caller knows which; a repeat count is a decision nobody has made yet. The
 * whole creation goes, so nothing half-written is left behind to explain.
 */
function validPinnedVersions(ids: readonly string[]): void {
  if (ids.length === 0) {
    refuseRun(
      "not_admitted",
      "a run needs at least one test version, because a run with no " +
        "simulations checks nothing. Pin the version_id of each test this " +
        "run should execute.",
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      refuseRun(
        "not_admitted",
        `test version ${id} is pinned twice on one run. Pin each version ` +
          `once; a run already conducts one simulation per test per persona.`,
      );
    }
    seen.add(id);
  }
}

/** What one pinned version turns into: its test, and who calls about it. */
type PinnedVersion = {
  readonly versionId: string;
  readonly testId: string;
  readonly testName: string;
  readonly personaIds: readonly string[];
};

/**
 * Every named version resolved to the test it belongs to and the personas it
 * names, in the order they were authored — before anything at all is written.
 *
 * A version this egma never issued, or one belonging to another customer or
 * another project, is refused in the same words as one that never existed:
 * confirming that somebody else's row is there is itself a leak. And **one bad
 * id refuses the whole creation**, because a run that quietly executed eleven
 * of the twelve versions somebody named would be a green result about a suite
 * that did not run.
 *
 * A version of a *deleted* test still resolves. The version is frozen content
 * and a run that pins one is saying "execute exactly this"; deleting the test
 * decides it should stop appearing in a folder, which is a different question.
 */
async function resolvePinnedVersions(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<readonly PinnedVersion[]> {
  const rows = await on
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      testName: test.name,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(inArray(testVersion.id, [...ids]), eq(test.projectId, projectId)),
      ),
    );

  const found = new Map(rows.map((row) => [row.id, row] as const));

  const named = new Map<string, string[]>();
  for (const entry of await on
    .select({
      testVersionId: testPersona.testVersionId,
      personaId: testPersona.personaId,
      position: testPersona.position,
    })
    .from(testPersona)
    .where(inArray(testPersona.testVersionId, [...found.keys()]))
    .orderBy(asc(testPersona.position))) {
    const held = named.get(entry.testVersionId);
    if (held === undefined) named.set(entry.testVersionId, [entry.personaId]);
    else held.push(entry.personaId);
  }

  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      refuseRun(
        "not_admitted",
        `there is no test version ${id} on this Egma instance. Push the test first, ` +
          `or read the test and pin the version_id it names now.`,
      );
    }
    const personaIds = named.get(id) ?? [];
    if (personaIds.length === 0) {
      // Unreachable through the test factory, which gives a version with no
      // named persona the project's default one. A version that got here
      // holding nobody would conduct nothing, so it is an instance fault.
      throw new Error(
        `test version ${id} names nobody who calls, so it can produce no simulation`,
      );
    }
    return { versionId: id, ...row, personaIds };
  });
}

/**
 * Each requested persona resolved to the version this run will pin: alive,
 * this project's, in the order they were named. A persona of another customer
 * or another project is refused in the same words as one that never existed,
 * because confirming that somebody else's row exists is itself a leak.
 *
 * The read takes a shared lock on every row it finds, held to commit — the
 * same terms a test's write names personas on — so a concurrent delete either
 * lands first and is seen here, or waits and sees the pin this run wrote.
 */
async function resolvePersonaVersions(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<readonly { personaId: string; personaVersionId: string }[]> {
  const found = new Map(
    (
      await on
        .select({
          id: persona.id,
          deletedAt: persona.deletedAt,
          currentVersionId: persona.currentVersionId,
        })
        .from(persona)
        .where(
          within(
            auth,
            persona,
            and(
              inArray(persona.id, [...ids]),
              eq(persona.projectId, projectId),
            ),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row] as const),
  );

  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      refuseRun(
        "not_admitted",
        `there is no persona ${id} in this project. A test that names ` +
          `somebody who is not here can produce no simulation; edit the test ` +
          `to name somebody who is.`,
      );
    }
    if (row.deletedAt !== null) {
      refuseRun(
        "not_admitted",
        `persona ${id} is deleted, and a run cannot conduct a simulation ` +
          `with a deleted persona. Edit the tests that name them, then pin ` +
          `the versions those edits mint.`,
      );
    }
    return { personaId: id, personaVersionId: row.currentVersionId };
  });
}

/**
 * The mocked world this run will execute in, worked out once and frozen.
 *
 * **Resolution happens here and nowhere later.** Mock tools are the one
 * authored thing with no version chain, so an edit landing halfway through a
 * run would answer the first simulations one way and the rest another — and
 * nothing on the record would say the world had moved. Freezing at creation is
 * what makes "every simulation in one run sees one world" a property of the
 * row rather than of how fast somebody types.
 *
 * Two halves, kept apart in the stored shape for the reason the schema file
 * gives: the project's mock tools that apply to this run's agent — scoping
 * already applied, so nothing downstream needs to know which agent this was —
 * and what each pinned version overrides, by version. `resolveMockTools` merges
 * them for one simulation, and is the only thing that does.
 */
async function freezeMockTools(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  agentId: string,
  versionIds: readonly string[],
): Promise<MockToolSnapshot> {
  const applying = await mockToolsApplyingTo(on, auth, projectId, agentId);
  const overriding = await mockOverridesOfVersions(on, versionIds);

  const overrides: Record<string, readonly SnapshotEntry[]> = {};
  for (const [versionId, entries] of overriding) {
    // A version that overrides nothing is left out rather than written as an
    // empty list: the two mean the same thing, and one of them costs nothing.
    if (entries.length === 0) continue;
    overrides[versionId] = entries.map((entry) => ({
      toolName: entry.toolName,
      answer: entry.answer,
      delayMilliseconds: entry.delayMilliseconds,
    }));
  }

  return {
    defaults: applying.map((one) => ({
      toolName: one.toolName,
      answer: one.answer,
      delayMilliseconds: one.delayMilliseconds,
      mockToolId: one.id,
    })),
    overrides,
  };
}

/**
 * The run, its simulations born `queued`, and the facts stamped at start — the
 * versions it pinned, the personas they named as provenance, the connection's
 * non-secret shape as snapshot, the mocked world it will run in, and every
 * simulation's own two pins — in one transaction, so nothing a team triggers
 * can half-exist.
 *
 * **One simulation per test per persona, counted before anything is written.**
 * Two tests naming three people between them is not two conversations; it is
 * however many the pins add up to, and `expected_simulation_count` is that
 * number, stamped once and frozen by the migration's trigger.
 *
 * **Everything is resolved before anything is written.** One unknown id, one
 * doubled id, one deleted persona, and the whole creation goes — because a run
 * that quietly executed most of what somebody named would report green about a
 * suite that did not run, and that is the exact trust this product sells.
 *
 * **A connection nothing can conduct is refused here, at the door.** A type
 * whose simulator adapter has not shipped can never be executed, so leaving the
 * run queued would be a promise egma cannot keep; the refusal says so in the
 * registry's own words.
 *
 * The connection is read alive, in the acting project, and on the named agent
 * when one is named; the composite foreign keys re-check the same pairings
 * underneath, for every path that does not come through here.
 *
 * Every simulation carries the frozen version it was written for, so a grader
 * reads what was expected off the conversation itself — and a test edited
 * between the first simulation and the last cannot split a run's meaning in
 * two.
 */
export async function startRun(
  auth: AuthContext,
  input: NewRun,
): Promise<StartedRun> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a run happens inside a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the reads below.
  const onAgentId = input.agentId;
  if (onAgentId !== undefined && !isId("agt", onAgentId)) {
    refuseRun(
      "connection_not_on_agent",
      `"${onAgentId}" is not an agent id, so no connection is on it. ` +
        NAME_THE_RIGHT_AGENT,
    );
  }
  // Named nothing at all is its own answer: "no connection of yours has that
  // id" would be a sentence about an id the request never sent, and a coding
  // agent reading it would go looking for a connection that was never named.
  if (input.connectionId.trim() === "") {
    refuseRun(
      "not_admitted",
      "a run is conducted over a connection, and this request named none. " +
        "Send connection with the con_ id of the way Egma should reach the " +
        "agent — registering the agent answered with one.",
    );
  }
  if (!isId("con", input.connectionId)) {
    refuseRun(
      "no_such_connection",
      `"${input.connectionId}" is not a connection id. Send the con_ id ` +
        `registering the agent answered with.`,
    );
  }
  validPinnedVersions(input.testVersionIds);
  const label = input.label?.trim() || null;
  const retryOfRunId = input.retryOfRunId ?? null;
  if (retryOfRunId !== null && !isId("run", retryOfRunId)) {
    throw new Error(`"${retryOfRunId}" is not a run id`);
  }

  const runId = newId("run");
  const now = new Date();

  const written = await db().transaction(async (tx) => {
    const [reached] = await tx
      .select({
        agentId: connection.agentId,
        type: connection.type,
        modality: connection.modality,
        topology: connection.topology,
        environment: connection.environment,
        config: connection.config,
      })
      .from(connection)
      .innerJoin(agent, eq(connection.agentId, agent.id))
      .where(
        within(
          auth,
          connection,
          and(
            eq(connection.id, input.connectionId),
            eq(connection.projectId, projectId),
            isNull(connection.deletedAt),
            isNull(agent.deletedAt),
          ),
        ),
      )
      .limit(1);

    if (reached === undefined) {
      refuseRun(
        "no_such_connection",
        `there is no connection ${input.connectionId} in this project. ` +
          `Check the id, or read your agents to see how each one is reached.`,
      );
    }
    // Named, and it has to be the one the connection is actually on. The
    // caller asked for that check; answering it quietly the other way would be
    // egma deciding which of the two ids they meant.
    if (onAgentId !== undefined && reached.agentId !== onAgentId) {
      refuseRun(
        "connection_not_on_agent",
        `connection ${input.connectionId} is not on agent ${onAgentId}. ` +
          NAME_THE_RIGHT_AGENT,
      );
    }
    if (!descriptorOf(reached.type).simulatorAdapter) {
      refuseRun("no_adapter", noSimulatorAdapterMessage(reached.type));
    }

    if (retryOfRunId !== null) {
      const [retried] = await tx
        .select({ id: run.id })
        .from(run)
        .where(theRun(auth, retryOfRunId))
        .limit(1);
      if (retried === undefined) {
        refuseRun(
          "not_admitted",
          `there is no run ${retryOfRunId} in this project, so this run ` +
            `retries nothing. Leave the retry out, or name a run this ` +
            `credential can read.`,
        );
      }
    }

    const versions = await resolvePinnedVersions(
      tx,
      auth,
      projectId,
      input.testVersionIds,
    );

    // The conversations this selection adds up to, in the order they will sit:
    // each version in turn, and inside it each persona in the order the test
    // named them.
    const wanted = versions.flatMap((version) =>
      version.personaIds.map((personaId) => ({ version, personaId })),
    );
    if (wanted.length > MOST_SIMULATIONS_PER_RUN) {
      refuseRun(
        "not_admitted",
        `a run conducts at most ${MOST_SIMULATIONS_PER_RUN} simulations, and ` +
          `these ${versions.length} versions ask for ${wanted.length}. Split ` +
          `the selection across runs.`,
      );
    }

    // Each distinct persona resolved once, in the order they were first met.
    const distinctPersonaIds = [
      ...new Set(wanted.map((one) => one.personaId)),
    ];
    const pinnedPersonas = new Map(
      (
        await resolvePersonaVersions(tx, auth, projectId, distinctPersonaIds)
      ).map((one) => [one.personaId, one.personaVersionId] as const),
    );
    /**
     * The version pinned for one of the personas just resolved.
     *
     * `resolvePersonaVersions` answers one entry per id or refuses, so a miss
     * here is this file having lost track of its own input rather than
     * anything a caller did — and it says so instead of writing a row with a
     * pin nobody chose.
     */
    const versionOf = (personaId: string): string => {
      const pinned = pinnedPersonas.get(personaId);
      if (pinned === undefined) {
        throw new Error(
          `persona ${personaId} was resolved for this run and then lost before the simulation was written`,
        );
      }
      return pinned;
    };

    // Frozen inside the same transaction that writes the header, so an edit
    // landing between the read and the write cannot reach the row: it either
    // committed before this read and is in the snapshot, or waits behind it and
    // changes only the runs started afterwards.
    const mockToolSnapshot = await freezeMockTools(
      tx,
      auth,
      projectId,
      reached.agentId,
      versions.map((one) => one.versionId),
    );

    const [header] = await tx
      .insert(run)
      .values({
        id: runId,
        organizationId: auth.organizationId,
        projectId,
        agentId: reached.agentId,
        connectionId: input.connectionId,
        label,
        status: "pending",
        triggeredVia: "manual",
        triggeredBy: auth.userId,
        pinnedTestVersions: { testVersionIds: input.testVersionIds },
        requestedPersonas: { personaIds: distinctPersonaIds },
        connectionSnapshot: {
          type: reached.type,
          modality: reached.modality,
          topology: reached.topology,
          environment: reached.environment,
          config: reached.config,
        },
        mockToolSnapshot,
        expectedSimulationCount: wanted.length,
        retryOfRunId,
        createdAt: now,
      })
      .returning(RUN_COLUMNS);

    if (header === undefined) throw new Error("the run was not written");

    const simulations = await tx
      .insert(simulation)
      .values(
        wanted.map(({ version, personaId }, index) => ({
          id: newId("sim"),
          runId,
          organizationId: auth.organizationId,
          projectId,
          agentId: reached.agentId,
          connectionId: input.connectionId,
          personaId,
          personaVersionId: versionOf(personaId),
          testId: version.testId,
          testVersionId: version.versionId,
          position: index + 1,
          modality: reached.modality,
          status: "queued",
          createdAt: now,
        })),
      )
      .returning(SIMULATION_COLUMNS);

    // The names come from what was just read rather than from a second query:
    // this transaction already knows what every one of these is called.
    const testNames = new Map(
      versions.map((one) => [one.versionId, one.testName] as const),
    );
    const personaNames = new Map(
      (
        await tx
          .select({ id: persona.id, name: persona.name })
          .from(persona)
          .where(inArray(persona.id, distinctPersonaIds))
      ).map((row) => [row.id, row.name] as const),
    );

    return { header, simulations, testNames, personaNames };
  });

  return {
    ...runFromRow(written.header),
    simulations: written.simulations
      .map((row) => ({
        ...simulationFromRow(row),
        // Every row this verb writes carries its pin, so every one of them has
        // a name to answer with; the fallback is the type being honest about a
        // column that other rows may leave empty.
        testName:
          row.testVersionId === null
            ? null
            : (written.testNames.get(row.testVersionId) ?? null),
        personaName: written.personaNames.get(row.personaId) ?? "",
      }))
      .sort((a, b) => a.position - b.position),
  };
}

/** One run as it stands — the header; its conversations are `listSimulations`. */
export async function getRun(
  auth: AuthContext,
  id: string,
): Promise<Run | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(RUN_COLUMNS)
    .from(run)
    .where(theRun(auth, id))
    .limit(1);

  return row === undefined ? undefined : runFromRow(row);
}

/**
 * One page of the runs the caller can reach — the acting project's, or the
 * whole customer's for a credential acting in none — newest first, the id as
 * the whole cursor, exactly as every other list here pages.
 */
export type RunPage = {
  readonly items: readonly Run[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export async function listRuns(
  auth: AuthContext,
  page?: PageRequest,
): Promise<RunPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "run",
    plural: "runs",
    prefix: "run",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(run.id, cursor);

  const rows = await db()
    .select(RUN_COLUMNS)
    .from(run)
    .where(within(auth, run, and(inActingProject(auth, run), olderThanCursor)))
    .orderBy(desc(run.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return { items: items.map(runFromRow), nextCursor };
}

/**
 * One run's simulations, in the order they were pinned, each carrying the name
 * of the test it executes and of the person who calls about it. The whole
 * list, unpaged, because a run holds at most `MOST_SIMULATIONS_PER_RUN` of
 * them — the cap `startRun` enforces is what makes this read bounded.
 */
export async function listSimulations(
  auth: AuthContext,
  runId: string,
): Promise<readonly ConductedSimulation[] | undefined> {
  authorize(auth, "read", here(auth));

  if ((await getRun(auth, runId)) === undefined) return undefined;

  const rows = await db()
    .select({
      ...SIMULATION_COLUMNS,
      testName: test.name,
      personaName: persona.name,
    })
    .from(simulation)
    // Left, not inner: a conversation from before a simulation could carry a
    // test pin still belongs to its run and still has to appear in it. An
    // inner join would quietly drop it and leave a run whose page held fewer
    // rows than its own expected count.
    .leftJoin(test, eq(simulation.testId, test.id))
    .innerJoin(persona, eq(simulation.personaId, persona.id))
    .where(within(auth, simulation, eq(simulation.runId, runId)))
    .orderBy(asc(simulation.position));

  return rows.map(({ testName, personaName, ...row }) => ({
    ...simulationFromRow(row),
    testName,
    personaName,
  }));
}

/** One simulation with everything reported about it. */
export async function getSimulation(
  auth: AuthContext,
  id: string,
): Promise<Simulation | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(SIMULATION_COLUMNS)
    .from(simulation)
    .where(
      within(
        auth,
        simulation,
        and(eq(simulation.id, id), inActingProject(auth, simulation)),
      ),
    )
    .limit(1);

  return row === undefined ? undefined : simulationFromRow(row);
}

/**
 * What one simulation was executed against: the frozen test version it pinned
 * at start, with the scenario, the expected behaviors in the order they were
 * authored, and the personas the version named.
 *
 * This is the resolution the pin exists for. Whoever judges a finished
 * conversation asks here what it was supposed to do, and gets the version as
 * it was on the day rather than the test as it is now — which is what keeps a
 * judgement re-readable after the test moves on. The version's own id comes
 * back with it, so anything else the version carries stays reachable from one
 * answer.
 *
 * Three different absences answer alike, with `undefined`: a simulation the
 * caller cannot see, one that pinned no test, and a pin whose version the
 * caller cannot reach. None of them has a version to resolve, and telling them
 * apart at this seam would be telling one customer about another's rows. A
 * caller who needs the distinction has it already — the pin is on the
 * simulation row.
 */
export async function getSimulationTestVersion(
  auth: AuthContext,
  simulationId: string,
): Promise<TestVersion | undefined> {
  authorize(auth, "read", here(auth));

  const pinned = await getSimulation(auth, simulationId);
  if (pinned === undefined || pinned.testVersionId === null) return undefined;

  return getTestVersion(auth, pinned.testVersionId);
}

/**
 * Whether every conversation of the run has landed, and if so the one write
 * that freezes the header: the three counts, `finished_at`, and the terminal
 * status, together.
 *
 * **Answers a status only when the header actually moved to it.** A run
 * already canceled finishes here without changing status, and the caller must
 * not write a second `canceled` event for it: a follower drawing transitions
 * would draw that one twice, and the second would be a change that never
 * happened. Whether the run has *finished* is the header's own business and is
 * what `done` reads.
 *
 * Called inside the transaction of whichever terminal transition might have
 * been the last, under a lock on the run's own row — so of two reporters
 * landing at once, one waits, recounts, and sees the other's row. The counts
 * are therefore written exactly once, by whoever lands last, and the
 * migration's trigger refuses everything after that.
 *
 * The `where`s start from bare `eq`s rather than `within`: the run id came
 * off a tenancy-checked simulation row in this same transaction, so neither
 * predicate can reach further than that check already did.
 */
async function finalizeRunIfDone(
  tx: Transaction,
  runId: string,
  now: Date,
): Promise<RunStatus | undefined> {
  const [header] = await tx
    .select({ id: run.id, status: run.status, finishedAt: run.finishedAt })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
    .for("update");

  if (header === undefined || header.finishedAt !== null) return undefined;

  const tallies = await tx
    .select({ status: simulation.status, howMany: count() })
    .from(simulation)
    .where(eq(simulation.runId, runId))
    .groupBy(simulation.status);

  const byStatus = new Map(tallies.map((row) => [row.status, row.howMany]));
  const stillMoving = ["queued", "claimed", "running"].some(
    (status) => (byStatus.get(status) ?? 0) > 0,
  );
  if (stillMoving) return undefined;

  // A canceled run keeps its status; anything else that got every simulation
  // to a terminal state completed, whatever the contents.
  const settled: RunStatus =
    header.status === "canceled" ? "canceled" : "completed";

  await tx
    .update(run)
    .set({
      status: settled,
      completedCount: byStatus.get("completed") ?? 0,
      failedCount: byStatus.get("failed") ?? 0,
      canceledCount: byStatus.get("canceled") ?? 0,
      finishedAt: now,
    })
    .where(eq(run.id, runId));

  return settled === header.status ? undefined : settled;
}

/**
 * The cancel intent, honored where each simulation stands. Queued ones end
 * here and now — canceled before claim, never dispatched, never claimable.
 * Claimed and running ones get the intent stamped, and the simulator honors it
 * at its next heartbeat; the run's own status flips at once, and its counts
 * land when the last straggler does.
 *
 * Canceling a canceled run is nothing to do and answers with the run as it
 * stands; canceling a completed one is refused out loud, because a run that
 * finished has nothing left to cancel and the caller should know they missed.
 *
 * **The three counts settle honestly.** A cancel that catches every
 * conversation before it was claimed finishes the run here and now, with the
 * canceled count equal to what was queued and nothing pretending to have
 * passed. A cancel that catches conversations in flight leaves the counts
 * unwritten until the stragglers land, and the run says `canceled` in the
 * meantime — so stopping early never reads as a suite that went green.
 */
export async function cancelRun(
  auth: AuthContext,
  id: string,
): Promise<Run | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();

  return db().transaction(async (tx) => {
    const [current] = await tx
      .select(RUN_COLUMNS)
      .from(run)
      .where(theRun(auth, id))
      .limit(1);

    if (current === undefined) return undefined;
    if (current.status === "canceled") return runFromRow(current);
    if (current.status === "completed") {
      throw new RunWriteRefusedError(
        "already_finished",
        nothingLeftToCancel(id),
      );
    }

    // Simulation rows first, the header last — the one lock order every
    // writer keeps. These `where`s narrow by the run id just checked above.
    const endedHere = await tx
      .update(simulation)
      .set({
        status: "canceled",
        cancelRequestedAt: now,
        endedAt: now,
      })
      .where(
        within(
          auth,
          simulation,
          and(eq(simulation.runId, id), eq(simulation.status, "queued")),
        ),
      )
      .returning({ id: simulation.id });

    await tx
      .update(simulation)
      .set({ cancelRequestedAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.runId, id),
            inArray(simulation.status, ["claimed", "running"]),
            isNull(simulation.cancelRequestedAt),
          ),
        ),
      );

    const [canceled] = await tx
      .update(run)
      .set({ status: "canceled" })
      .where(
        within(
          auth,
          run,
          and(eq(run.id, id), inArray(run.status, ["pending", "running"])),
        ),
      )
      .returning(RUN_COLUMNS);

    // The guarded update matching nothing means the run moved between the
    // read above and this write: a second cancel got there first, or a
    // reporter finalized it. Read again and answer as the first read would
    // have — the same idempotence, the same refusal, one race later.
    if (canceled === undefined) {
      const [moved] = await tx
        .select(RUN_COLUMNS)
        .from(run)
        .where(theRun(auth, id))
        .limit(1);
      if (moved !== undefined && moved.status === "canceled") {
        return runFromRow(moved);
      }
      throw new RunWriteRefusedError("already_finished", nothingLeftToCancel(id));
    }

    await finalizeRunIfDone(tx, id, now);

    // Every conversation that ended here, then the run itself. One run event,
    // whether or not the counts landed in this same transaction: the header
    // says `canceled` either way, and the stragglers' own landings are what
    // write the finish when there are stragglers.
    await appendRunEvents(tx, id, now, [
      ...endedHere.map(
        (row) =>
          ({
            kind: "simulation",
            simulationId: row.id,
            status: "canceled",
          }) as const,
      ),
      { kind: "run", status: "canceled" },
    ]);

    const [settled] = await tx
      .select(RUN_COLUMNS)
      .from(run)
      .where(theRun(auth, id))
      .limit(1);
    return settled === undefined ? undefined : runFromRow(settled);
  });
}

/**
 * What a claim answers with, and no more — identifiers, tenancy, the two
 * stamps the claim itself wrote, and the pins a spec is assembled from.
 *
 * Deliberately not the `Simulation` shape: a claim crosses every customer on
 * the deployment, so what it carries out is held to what the assembly needs
 * to *ask for* — never the asked-for things themselves. No transcript, no
 * configuration, no credentials, nothing a customer wrote. Each of those is
 * read afterwards through the ordinary scoped surface, under `auth`.
 */
export type SimulationClaim = {
  readonly id: string;
  readonly runId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** Who calls, by identity, and the pin the traits are read from. */
  readonly personaId: string;
  readonly personaVersionId: string;
  /** What is being checked; both absent only on an upgraded instance's history. */
  readonly testId: string | null;
  readonly testVersionId: string | null;
  readonly modality: Modality;
  readonly claimedBy: string;
  readonly claimedAt: Date;
  /**
   * Narrowed to this simulation's own organization and project, built here
   * from the claimed row and from nothing the claimant said. It is what every
   * read the spec assembly makes goes through, so the conducting happens
   * inside one customer even though the claim that found the work was not.
   */
  readonly auth: AuthContext;
};

const SIMULATION_CLAIM_COLUMNS = {
  id: simulation.id,
  runId: simulation.runId,
  organizationId: simulation.organizationId,
  projectId: simulation.projectId,
  agentId: simulation.agentId,
  connectionId: simulation.connectionId,
  personaId: simulation.personaId,
  personaVersionId: simulation.personaVersionId,
  testId: simulation.testId,
  testVersionId: simulation.testVersionId,
  modality: simulation.modality,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
} as const;

/**
 * The name the simulator's context wears where a person's id would be.
 *
 * The same shape as the grading queue's `engine`, for the same reason: the
 * simulator is a process, and the conversations it conducts were asked for by
 * whoever started the run rather than by it. Deliberately not shaped like an
 * identifier, so anything that ever tried to write it as one is refused out
 * loud by the foreign key to `user` rather than quietly attributing a
 * machine's act to a person.
 */
const THE_SIMULATOR = "simulator";

/**
 * The context one claimed simulation is conducted under.
 *
 * `member`, where the grading engine's is `viewer`, and the difference is the
 * work: the engine only reads and writes egma's own records, while conducting
 * moves the simulation row itself through the machinery this file gates with
 * `start_and_cancel_runs` — because claiming and reporting a simulation *is*
 * conducting the run somebody started. What keeps the context narrower than a
 * person holding the same role is not the role at all: every write requires
 * the claimant's own name on the row, and the one secret it can ask for sits
 * behind a door that checks how the context came to exist, not what its role
 * permits.
 */
function conductingContext(
  organizationId: string,
  projectId: string,
): AuthContext {
  return {
    userId: THE_SIMULATOR,
    organizationId,
    projectId,
    role: "member",
    via: "simulator",
  };
}

export type SimulationClaimRequest = {
  /** This simulator's own name for itself. */
  readonly claimant: string;
  /** How many conversations it has room to conduct at once. */
  readonly capacity: number;
};

/**
 * The atomic claim, across every organization on this deployment.
 *
 * Up to `capacity` of the oldest queued simulations move to `claimed` in one
 * transaction, stamped with the claimant and their first heartbeat; whatever
 * another claimant holds locked is skipped rather than waited on, so two
 * simulators drain one queue without ever taking the same conversation.
 * `SKIP LOCKED`, exactly as `claimGradingJobs` does it, because it is exactly
 * the same problem. The capacity is the simulator's own declaration of what
 * it can hold — a big run degrades to a queue, never to overload.
 *
 * Every claimed simulation's run leaves `pending` here, because a run has
 * started when its first conversation is someone's to conduct.
 *
 * **It takes no `AuthContext` and cannot be given one.** See the note at the
 * top of this file, and the grading queue's, whose reasoning this claim
 * inherits whole: it is the one call in this file that reaches across
 * customers; the only rows it moves are egma's own queue of simulations; it
 * takes a claimant's name and a capacity, and there is no argument by which a
 * caller could name whose work they want — a build rule holds it to that; it
 * carries out identifiers and no content; and every claim arrives with the
 * narrowed context the conducting is actually done under. There is no
 * tenancy-scoped claim beside it, deliberately — a claim a customer's
 * credential could make would be a claim that has to answer which customers
 * it serves, and the honest answer is all of them.
 */
export async function claimSimulations(
  request: SimulationClaimRequest,
): Promise<readonly SimulationClaim[]> {
  const claimant = validClaimant(request.claimant);
  const { capacity } = request;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > LARGEST_CLAIM_CAPACITY
  ) {
    throw new Error(
      `a claim takes between 1 and ${LARGEST_CLAIM_CAPACITY} simulations`,
    );
  }

  const now = new Date();

  const claimed = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: simulation.id })
      .from(simulation)
      .where(eq(simulation.status, "queued"))
      .orderBy(asc(simulation.id))
      .limit(capacity)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    // Bare `eq`s and `inArray`s from here down: every id came off the rows
    // locked just above, in this same transaction, so nothing below reaches
    // further than that select already did.
    const rows = await tx
      .update(simulation)
      .set({
        status: "claimed",
        claimedBy: claimant,
        claimedAt: now,
        heartbeatAt: now,
      })
      .where(
        inArray(
          simulation.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning(SIMULATION_CLAIM_COLUMNS);

    // The runs these came from, each flipped at most once, one at a time in
    // one order — so two claimants touching the same runs cannot deadlock.
    // Each run's events go in beside its own flip, in the same order: the
    // conversations that were picked up, and then the run that started
    // because they were.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const startedRunId of runIds) {
      const started = await tx
        .update(run)
        .set({ status: "running", startedAt: now })
        .where(and(eq(run.id, startedRunId), eq(run.status, "pending")))
        .returning({ id: run.id });

      await appendRunEvents(tx, startedRunId, now, [
        ...rows
          .filter((row) => row.runId === startedRunId)
          .map(
            (row) =>
              ({
                kind: "simulation",
                simulationId: row.id,
                status: "claimed",
              }) as const,
          ),
        ...(started.length === 0
          ? []
          : [{ kind: "run", status: "running" } as const]),
      ]);
    }

    return rows;
  });

  return claimed
    .map((row) => ({
      id: row.id,
      runId: row.runId,
      organizationId: row.organizationId,
      projectId: row.projectId,
      agentId: row.agentId,
      connectionId: row.connectionId,
      personaId: row.personaId,
      personaVersionId: row.personaVersionId,
      testId: row.testId,
      testVersionId: row.testVersionId,
      modality: row.modality as Modality,
      claimedBy: row.claimedBy ?? claimant,
      claimedAt: row.claimedAt ?? now,
      auth: conductingContext(row.organizationId, row.projectId),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Where one simulation stands, and the context its conducting continues
 * under — what the report, heartbeat and telemetry doors read before applying
 * anything a simulator says about a row.
 *
 * Lifecycle stamps and identifiers, and no content: enough to tell an
 * unknown simulation from a moved one, a duplicate from a conflict, and the
 * claimant whose word the row takes — and nothing a customer wrote. The pins
 * ride along for the row's arriving evidence: a span filed under the
 * simulation carries the run and the versions its conversation executed, and
 * they come off this same row rather than off anything the wire claimed.
 * What the work itself needs is read afterwards, through the scoped surface,
 * under the context answered here.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's own
 * discipline, one step later in the same lifecycle: the simulator holds no
 * credential, so its calls about a claimed row arrive with the service
 * token — which resolves to nobody — and the row itself is what names whose
 * conducting this is. The context comes back built from the row's own
 * tenancy and from nothing the caller said, exactly as the claim built it,
 * and it is the context every write about the row then goes through. The
 * one argument is the simulation's id — an identifier the claim itself
 * handed out — and there is no argument by which a caller could name a
 * customer.
 *
 * The row is answered in whatever state it stands, terminal and swept
 * included, and each door decides what that standing permits: the lifecycle
 * doors refuse a claim about a row beyond help, while the telemetry door
 * keeps a late-returning orphan's spans — evidence arriving after the
 * verdict on the messenger.
 */
export async function resolveSimulationStanding(
  simulationId: string,
): Promise<SimulationStanding | undefined> {
  const [row] = await db()
    .select({
      id: simulation.id,
      runId: simulation.runId,
      organizationId: simulation.organizationId,
      projectId: simulation.projectId,
      agentId: simulation.agentId,
      testVersionId: simulation.testVersionId,
      personaVersionId: simulation.personaVersionId,
      modality: simulation.modality,
      status: simulation.status,
      endingReason: simulation.endingReason,
      claimedBy: simulation.claimedBy,
      cancelRequestedAt: simulation.cancelRequestedAt,
    })
    .from(simulation)
    .where(eq(simulation.id, simulationId))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    id: row.id,
    runId: row.runId,
    agentId: row.agentId,
    testVersionId: row.testVersionId,
    personaVersionId: row.personaVersionId,
    modality: row.modality as Modality,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    claimedBy: row.claimedBy,
    cancelRequestedAt: row.cancelRequestedAt,
    auth: conductingContext(row.organizationId, row.projectId),
  };
}

/**
 * What `resolveSimulationStanding` answers with: the row's lifecycle stamps,
 * the pins its evidence is filed under, and the narrowed context every write
 * about the row goes through.
 */
export type SimulationStanding = {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  /** Absent only on an upgraded instance's history, exactly as on the claim. */
  readonly testVersionId: string | null;
  readonly personaVersionId: string;
  readonly modality: Modality;
  readonly status: SimulationStatus;
  readonly endingReason: SimulationEndingReason | null;
  /** The row's conductor — the claimant whose word the row takes. */
  readonly claimedBy: string | null;
  readonly cancelRequestedAt: Date | null;
  /**
   * Narrowed to this simulation's own organization and project, built here
   * from the row and from nothing the caller said — the claim's context,
   * derived again for the calls that come back later.
   */
  readonly auth: AuthContext;
};

/**
 * How the simulator reaches the agent of one claimed simulation: the
 * connection's type, its non-secret config, and the credentials unsealed — or
 * null where the customer supplies no secret for the type.
 */
export type SimulationConnection = {
  readonly connectionId: string;
  readonly type: ConnectionType;
  readonly config: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>> | null;
};

/**
 * The one door to a connection's plaintext on the dispatch path, and **egma's
 * own simulator is the only thing that may knock.**
 *
 * The gate is narrower than a role, on the terms `resolveJudgeKey` drew for
 * the other secret egma holds: the only thing egma ever does with a
 * connection's credentials at this seam is conduct a simulation over them,
 * and the only thing that conducts is the simulator. So the check is on how
 * the caller came to exist rather than on what their role permits — a context
 * built from a claim says `simulator` on its face, and every other context in
 * the product, a person's session and an API key and the grading engine
 * alike, is refused out loud.
 *
 * It is asked with a simulation, never with a connection, and that is the
 * second half of the door: the row names the connection it was pinned to when
 * the run started, so there is no argument by which a caller could point the
 * unsealing at a connection the claimed row does not name. And it answers
 * only while the row stands `claimed` — the one moment a spec is assembled.
 * Before the claim there is nobody to hand a secret to, and after the
 * conversation starts nothing asks again.
 *
 * `undefined` answers three absences alike — a simulation out of the
 * context's tenancy, one not standing claimed, and a connection since deleted
 * — because telling them apart at this seam would confirm rows the context
 * cannot see. A caller who needs the difference is holding the claim, which
 * already says what was claimed; a connection gone mid-flight is the one case
 * left, and it is exactly the "could not be handed over" the dispatch path
 * answers for out loud.
 */
export async function resolveSimulationConnection(
  auth: AuthContext,
  simulationId: string,
): Promise<SimulationConnection | undefined> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "a connection's credentials are unsealed for Egma's own simulator and for nothing else, because conducting is the only thing Egma does with them",
    );
  }

  const [row] = await db()
    .select({
      connectionId: connection.id,
      type: connection.type,
      config: connection.config,
      credentials: connection.credentials,
    })
    .from(simulation)
    .innerJoin(connection, eq(simulation.connectionId, connection.id))
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.id, simulationId),
          eq(simulation.status, "claimed"),
          isNull(connection.deletedAt),
          inActingProject(auth, simulation),
        ),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const malformed = (held: string) => () =>
    new Error(
      `connection ${row.connectionId} holds ${held} in a shape Egma never ` +
        `writes; the row needs repairing before anybody can conduct over it`,
    );

  return {
    connectionId: row.connectionId,
    type: row.type as ConnectionType,
    config: stringRecordFromRow(row.config, malformed("config")),
    credentials:
      row.credentials === null
        ? null
        : stringRecordFromRow(
            openCredentials(row.credentials),
            malformed("credentials"),
          ),
  };
}

/** One beat, as the wire carries it: which simulation, and who is conducting. */
export type SimulationHeartbeat = {
  readonly simulationId: string;
  /** This simulator's own name for itself — the name the claim stamped. */
  readonly claimant: string;
};

/**
 * Still alive, still holding this conversation — and the answer carries the
 * one directive that travels back on a heartbeat: whether cancellation has
 * been requested. `undefined` is a heartbeat with nothing under it: an id
 * this egma never issued, another claimant's row, or one no longer moving —
 * the signal to stop, not to retry.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's exact
 * terms (see the note at the top of this file): the beat comes from egma's
 * own simulator, which stands behind every organization at once and holds no
 * credential to build a context from. What keeps it narrow is the guarded
 * update itself — the only row it can touch is one the caller's own name is
 * already stamped on, in a state only egma's claim machinery writes — and the
 * answer is a single boolean egma itself stamped. Nothing a customer authored
 * goes in or comes out.
 */
export async function recordSimulationHeartbeat(
  beat: SimulationHeartbeat,
): Promise<{ readonly cancelRequested: boolean } | undefined> {
  const [row] = await db()
    .update(simulation)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        eq(simulation.id, beat.simulationId),
        eq(simulation.claimedBy, validClaimant(beat.claimant)),
        inArray(simulation.status, ["claimed", "running"]),
      ),
    )
    .returning({ cancelRequestedAt: simulation.cancelRequestedAt });

  if (row === undefined) return undefined;
  return { cancelRequested: row.cancelRequestedAt !== null };
}

/**
 * The conversation is underway: `claimed → running`, stamped with the moment
 * it started, by the claimant conducting it. `undefined` on anything else —
 * the guarded update is the check, so there is no window in which the row
 * moves between being looked at and being moved.
 *
 * In a transaction because the move and its event are one fact: a guarded
 * update that matched nothing writes neither, and one that matched writes both.
 */
export async function startSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({ status: "running", startedAt: now, heartbeatAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, validClaimant(claimant)),
            eq(simulation.status, "claimed"),
            inActingProject(auth, simulation),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;

    await appendRunEvents(tx, row.runId, now, [
      { kind: "simulation", simulationId: row.id, status: "running" },
    ]);
    return simulationFromRow(row);
  });
}

/**
 * How every simulation lands: one guarded update — this claimant's row, in a
 * state the landing may leave, within the caller's reach — writing the
 * terminal facts, and the run finalized in the same transaction when the
 * landing was its last. The three landings below differ only in what they
 * write and what they require, so that is all they say; `undefined` still
 * means there was nothing here to move.
 *
 * The events go in beside them: the conversation landing, and then the run
 * itself when this landing was the one that finished it.
 */
async function landSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  landing: {
    readonly from: readonly SimulationStatus[];
    /**
     * Everything this landing writes beside the heartbeat — including
     * `ended_at`, when the report carried the conduction's own moment; the
     * stamp below is only the fallback for a report that brought none.
     */
    readonly write: Record<string, unknown>;
    /** Any further condition the landing requires of the row. */
    readonly onlyWhere?: SQL | undefined;
  },
): Promise<Simulation | undefined> {
  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({ endedAt: now, ...landing.write, heartbeatAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, validClaimant(claimant)),
            inArray(simulation.status, [...landing.from]),
            landing.onlyWhere,
            inActingProject(auth, simulation),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;

    // The judgement is queued in the same transaction as the landing, so a
    // conversation that ended is never recorded without the work to judge it.
    // The organization comes off the context: the row was reached through
    // `within`, so its organization is this one by construction, and the
    // answer's columns stay the tenant-free view they are everywhere else.
    await makeGradable(tx, { ...row, organizationId: auth.organizationId });
    const settled = await finalizeRunIfDone(tx, row.runId, now);
    await appendRunEvents(tx, row.runId, now, [
      {
        kind: "simulation",
        simulationId: row.id,
        status: row.status as SimulationStatus,
        reason: row.endingReason as SimulationEndingReason | null,
      },
      ...(settled === undefined
        ? []
        : [{ kind: "run", status: settled } as const]),
    ]);
    return simulationFromRow(row);
  });
}

/**
 * A conversation happened and this is its record: `running → completed`, the
 * terminal facts written once — how it ended, the summary facts, the measured
 * audio band that can never be backfilled. What was said is not among them:
 * the conversation is its spans, and they are already stored.
 */
export async function completeSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  report: SimulationReport,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (!COMPLETED_ENDING_REASONS.includes(report.endingReason)) {
    throw new Error(
      `"${report.endingReason}" is not a way a conversation ends`,
    );
  }

  return landSimulation(auth, id, claimant, {
    from: ["running"],
    write: {
      status: "completed",
      endingReason: report.endingReason,
      ...summaryFactsWrite(report),
    },
  });
}

/**
 * The simulation ends without a conversation to grade — or with a partial
 * one, whatever reached the trace store before it stopped, which is the
 * honest "started, never finished" record. From `claimed`
 * (the agent never joined, the line was never answered) or from `running`
 * (something died mid-conversation). Never a judgement: the reasons here are the
 * "test never ran" class, and keeping them apart from a bad conversation is
 * the one normalisation a test product cannot get wrong.
 */
export async function failSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  failure: SimulationFailure,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (!REPORTABLE_FAILURE_REASONS.includes(failure.reason)) {
    throw new Error(`"${failure.reason}" is not a way a simulation fails`);
  }

  return landSimulation(auth, id, claimant, {
    from: ["claimed", "running"],
    write: {
      status: "failed",
      endingReason: failure.reason,
      ...summaryFactsWrite(failure),
    },
  });
}

/**
 * The claim path's own landing, for a claimed simulation the platform could
 * not hand over: `claimed → failed` with the one reason no simulator can
 * report, `dispatch_failed`. Written at claim time, the moment spec assembly
 * fails — never left for the sweep to misname `orphaned` (the simulator did
 * not stop answering; it was never handed anything to answer for), and never
 * re-queued to fail the same way again — and through the same terminal
 * machinery as every landing: the judgement minted and the run finalized in
 * the same transaction, so a run waiting only on a broken row still settles
 * with truthful counts.
 *
 * Only a context minted by a claim may write it, on the terms
 * `resolveSimulationConnection` drew: the check is on how the caller came to
 * exist, not on what its role permits. Dispatch failure is a fact about the
 * moment between claiming and handing over, and the claim path is the only
 * thing that stands there — a person's session or key, and the grading
 * engine, would be recording the platform's confession to an act that was
 * never theirs.
 *
 * From `claimed` alone, by the claimant alone: once the conversation is
 * underway, dispatch already succeeded, and whatever fails afterwards is the
 * simulator's to report.
 */
export async function failSimulationDispatch(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "dispatch_failed is the platform's own confession that it could not hand a claimed simulation over, and only the claim path — conducting as the simulator — stands where that happens",
    );
  }

  return landSimulation(auth, id, claimant, {
    from: ["claimed"],
    write: { status: "failed", endingReason: "dispatch_failed" },
  });
}

/**
 * The simulator honors the cancel it was told about: `claimed` or `running`
 * to `canceled`, by the claimant, and only where the intent was actually
 * recorded — a simulator abandoning a conversation nobody canceled is a
 * failure, not a cancellation, and is refused by the same guarded update
 * that checks everything else.
 *
 * A canceled conversation still landed somewhere, so the landing takes the
 * summary facts the report carried — what had been reached by the time the
 * directive was honored. Never an ending reason: the cancel intent is its
 * own record, and the row's shape holds it to that.
 */
export async function markSimulationCanceled(
  auth: AuthContext,
  id: string,
  claimant: string,
  facts: SimulationSummaryFacts = {},
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  return landSimulation(auth, id, claimant, {
    from: ["claimed", "running"],
    write: { status: "canceled", ...summaryFactsWrite(facts) },
    onlyWhere: isNotNull(simulation.cancelRequestedAt),
  });
}

/**
 * What the sweep answers with: which rows it ended, named and nothing more.
 * The caller's whole use for the answer is to say what happened — anything
 * fuller would carry customers' content out of a call that has no context
 * to hold it to one customer.
 */
export type SweptSimulation = {
  readonly id: string;
  readonly runId: string;
};

/**
 * The orphan sweep: every claimed or running simulation whose simulator has
 * been silent past the staleness window is marked `failed` with reason
 * `orphaned` — an honest "started, never finished" instead of a row stuck
 * running forever — and any run that was waiting only on orphans is
 * finalized. Returns what it swept, so the caller can say what it did.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's exact
 * terms (see the note at the top of this file): silence is noticed by egma
 * standing behind every organization at once, because the simulator whose
 * silence this is stood there too. The only rows it moves are ones egma's own
 * claim machinery stamped, each orphan's grading work is filed under the
 * tenancy the row itself carries, and the answer is identifiers and no
 * content.
 *
 * **Racing sweeps collide harmlessly**, which is what makes it safe to run on
 * an interval in every replica with nothing elected to go first. The guarded
 * update is the whole arbiter: of two sweeps reaching one row, whichever
 * arrives second re-reads it after the first commits, finds it no longer
 * `claimed` or `running`, and leaves it alone — so a row is ended once, its
 * grading work enqueued once, its run finalized once. And the after-work
 * walks rows and runs in id order, so two sweeps over one set cannot
 * deadlock over the order they took things in.
 *
 * The staleness window is measured in whole seconds against the last
 * heartbeat. The default is `DEFAULT_STALE_AFTER_SECONDS`, set where it is so
 * a partition cannot out-wait a report that is still coming; the sweep's one
 * sin would be calling a simulator dead that isn't.
 */
export async function sweepOrphanedSimulations(
  options?: { readonly staleAfterSeconds?: number | undefined },
): Promise<readonly SweptSimulation[]> {
  const staleAfterSeconds =
    options?.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1) {
    throw new Error("a staleness window is a positive whole number of seconds");
  }

  const now = new Date();
  const silentSince = new Date(now.getTime() - staleAfterSeconds * 1000);

  const swept = await db().transaction(async (tx) => {
    const rows = await tx
      .update(simulation)
      .set({ status: "failed", endingReason: "orphaned", endedAt: now })
      .where(
        and(
          inArray(simulation.status, ["claimed", "running"]),
          lt(simulation.heartbeatAt, silentSince),
        ),
      )
      .returning({
        id: simulation.id,
        runId: simulation.runId,
        organizationId: simulation.organizationId,
        projectId: simulation.projectId,
        status: simulation.status,
      });

    // An orphan is a terminal transition like any other, so it becomes work
    // like any other: a simulator that died mid-conversation produces a `failed`
    // simulation, and a `failed` simulation is judged `errored` rather than left
    // unjudged. In id order, so two sweeps racing over one set take the rows in
    // one order and cannot deadlock over them. The tenancy each job is filed
    // under is the row's own — the one thing here `within` would otherwise say.
    for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      await makeGradable(tx, row);
    }

    // Each affected run at most once, in one order, as everywhere else — and
    // each one's events beside its own finish.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const orphanedRunId of runIds) {
      const settled = await finalizeRunIfDone(tx, orphanedRunId, now);
      await appendRunEvents(tx, orphanedRunId, now, [
        ...rows
          .filter((row) => row.runId === orphanedRunId)
          .map(
            (row) =>
              ({
                kind: "simulation",
                simulationId: row.id,
                status: "failed",
                reason: "orphaned",
              }) as const,
          ),
        ...(settled === undefined
          ? []
          : [{ kind: "run", status: settled } as const]),
      ]);
    }

    return rows;
  });

  return swept.map((row) => ({ id: row.id, runId: row.runId }));
}

/**
 * One change to a run, in the order it happened.
 *
 * The two names are joined from the simulation this is about rather than
 * copied onto the row at write time, so a feed and the run's own page can never
 * disagree about what a conversation is called. What was *executed* is pinned
 * on the simulation and never moves; what it is *called* is answered now.
 */
export type RunEvent = {
  readonly runId: string;
  /** Dense from one, within this run. The whole of the cursor. */
  readonly seq: number;
  readonly at: Date;
  readonly kind: RunEventKind;
  /** Absent on a run event, which is about the header itself. */
  readonly simulationId: string | null;
  readonly testName: string | null;
  readonly personaName: string | null;
  /** A run status on a run event; a simulation status on a simulation one. */
  readonly status: RunStatus | SimulationStatus;
  /** What the graders made of it, once there is one to carry. */
  readonly verdict: Verdict | null;
  readonly reason: SimulationEndingReason | null;
};

/** A page of changes, where to ask from next, and whether there will be more. */
export type RunEventPage = {
  readonly events: readonly RunEvent[];
  /** Hand back as `after` to continue; the same number again on an empty page. */
  readonly next: number;
  /** True once the run has finished, and only then. */
  readonly done: boolean;
};

/**
 * Everything that has changed about a run since a point, in the order it
 * happened.
 *
 * **The split that makes crash-resume real.** This side is stateless: it
 * remembers nothing about who has read what, and asking twice for the same
 * `after` answers the same page twice. The client's half is to apply each
 * sequence number at most once. Between them, a follower that dies mid-page
 * and restarts from the last number it applied misses nothing and repeats
 * nothing — and neither end has to trust the other to have been alive.
 *
 * **The header is read before the events, and the order is load-bearing.** If
 * `done` were read second, a run that finished between the two reads would be
 * reported finished by a page that did not yet hold its last events, and a
 * follower that stopped there would never learn how the run ended. Read this
 * way round, the worst case is a `done` that is one poll stale, which costs a
 * poll and loses nothing.
 *
 * The whole tail is answered rather than a page of it: a run holds at most
 * `MOST_SIMULATIONS_PER_RUN` conversations and each of them changes a handful
 * of times, so the tail is bounded by the cap `startRun` already enforces.
 */
export async function listRunEvents(
  auth: AuthContext,
  runId: string,
  options?: { readonly after?: number | undefined },
): Promise<RunEventPage | undefined> {
  authorize(auth, "read", here(auth));

  const after = options?.after ?? 0;
  if (!Number.isInteger(after) || after < 0) {
    throw new Error(
      "a follower asks for everything after a sequence number, which is a whole number from zero",
    );
  }

  const header = await getRun(auth, runId);
  if (header === undefined) return undefined;

  const rows = await db()
    .select({
      runId: runEvent.runId,
      seq: runEvent.seq,
      at: runEvent.createdAt,
      kind: runEvent.kind,
      simulationId: runEvent.simulationId,
      testName: test.name,
      personaName: persona.name,
      status: runEvent.status,
      verdict: runEvent.verdict,
      reason: runEvent.reason,
    })
    .from(runEvent)
    .leftJoin(simulation, eq(runEvent.simulationId, simulation.id))
    .leftJoin(test, eq(simulation.testId, test.id))
    .leftJoin(persona, eq(simulation.personaId, persona.id))
    .where(
      within(
        auth,
        runEvent,
        and(
          eq(runEvent.runId, runId),
          gt(runEvent.seq, after),
          inActingProject(auth, runEvent),
        ),
      ),
    )
    .orderBy(asc(runEvent.seq));

  const events = rows.map((row) => ({
    ...row,
    kind: row.kind as RunEventKind,
    status: row.status as RunStatus | SimulationStatus,
    verdict: row.verdict as Verdict | null,
    reason: row.reason as SimulationEndingReason | null,
  }));

  return {
    events,
    next: events.at(-1)?.seq ?? after,
    done: header.finishedAt !== null,
  };
}
