import { newId } from "@egma/ids";
import {
  simulationIdOfTrace,
  traceIdOfSimulation,
} from "@egma/simulation-contract";
import {
  and,
  asc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { traceStore } from "../clickhouse/client.ts";
import { db, listen, type Listening, type Queryable } from "../client.ts";
import { combinedGradeScore } from "../grading/results.ts";
import type { PlanGroup } from "../grading/plan.ts";
import { graderDefinition, projectGrader } from "../schema/graders.ts";
import type { Modality } from "../schema/agents.ts";
import {
  gradingJob,
  type FrozenGradingEntry,
  type GradingJobStatus,
  type GradingSource,
} from "../schema/grading.ts";
import { gradingPlan } from "../schema/plans.ts";
import { run, simulation } from "../schema/runs.ts";
import { validClaimant } from "./claimants.ts";
import type { AuthContext } from "./context.ts";
import {
  readCurrentSimulationGradeFacts,
  readProductionGradingPlan,
  readTraceGrades,
  recordProductionGradingPlan,
  type CurrentGrade,
  type CurrentSimulationGradeFact,
  type ProductionGradingPlanEntry,
  type RecordedGrade,
} from "./grades.ts";
import { getExecutableGraderDefinition } from "./graders.ts";
import { authorize, here } from "./permissions.ts";
import {
  pinnedSimulationGradersOn,
  resolveProductionGraders,
} from "./run-plans.ts";
import {
  EARLIEST_READABLE_MICROSECONDS,
} from "./span-identity.ts";
import type { NewSpan } from "./spans.ts";
import {
  MAXIMUM_WINDOW_MILLISECONDS,
  type TimeWindow,
} from "./traces.ts";
import { within } from "./within.ts";

/** A notification is a wake-up hint. The Postgres row remains the queue. */
export const GRADING_WORK_CHANNEL = "egma_grading_work";

const LARGEST_CLAIM_CAPACITY = 50;
const DEFAULT_LEASE_SECONDS = 120;
/** The last failed attempt is retained as an abandoned job, never a grade. */
export const MOST_GRADING_ATTEMPTS = 3;
const THE_ENGINE = "engine";

export type GradingRequest = {
  readonly source: GradingSource;
  readonly traceId: string;
  readonly traceStartedAt: Date;
  readonly runId?: string | undefined;
  /** An explicit supported-platform end fact for production. */
  readonly endsTrace: boolean;
  /** The trace is query-visible in ClickHouse, not merely accepted for drain. */
  readonly evidenceReady: boolean;
  readonly modality: "chat" | "voice";
};

export type GradingRequestResult =
  | { readonly kind: "waiting"; readonly for: "completion" | "evidence" }
  | { readonly kind: "not_requested" }
  | {
      readonly kind: "queued";
      readonly jobId: string;
      readonly created: boolean;
    }
  | { readonly kind: "terminal"; readonly outcome: "complete" | "error" };

export type RegradeTraceResult =
  | { readonly kind: "not_requested" }
  | {
      readonly kind: "queued";
      readonly jobId: string;
      /** This request created or reopened whole-trace work. */
      readonly reopened: boolean;
      /** Whole-trace work was already pending or claimed. */
      readonly alreadyWaiting: boolean;
    };

export type GradingJob = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly source: GradingSource;
  readonly simulationId: string | null;
  readonly traceId: string;
  readonly traceStartedAt: Date;
  readonly runId: string | null;
  readonly entries: readonly FrozenGradingEntry[];
  readonly status: GradingJobStatus;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly sequenceBase: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

export type GradingClaim = GradingJob & {
  readonly status: "claimed";
  readonly claimedBy: string;
  readonly claimedAt: Date;
  readonly heartbeatAt: Date;
  readonly auth: AuthContext;
};

export type GradingClaimRequest = {
  readonly claimant: string;
  readonly capacity: number;
  readonly leaseSeconds?: number | undefined;
};

const JOB_COLUMNS = {
  id: gradingJob.id,
  organizationId: gradingJob.organizationId,
  projectId: gradingJob.projectId,
  source: gradingJob.source,
  simulationId: gradingJob.simulationId,
  traceId: gradingJob.traceId,
  traceStartedAt: gradingJob.traceStartedAt,
  runId: gradingJob.runId,
  entries: gradingJob.entries,
  status: gradingJob.status,
  claimedBy: gradingJob.claimedBy,
  claimedAt: gradingJob.claimedAt,
  heartbeatAt: gradingJob.heartbeatAt,
  sequenceBase: gradingJob.sequenceBase,
  attempts: gradingJob.attempts,
  lastError: gradingJob.lastError,
  finishedAt: gradingJob.finishedAt,
  createdAt: gradingJob.createdAt,
} as const;

function jobFromRow(row: {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly source: string;
  readonly simulationId: string | null;
  readonly traceId: string;
  readonly traceStartedAt: Date;
  readonly runId: string | null;
  readonly entries: readonly FrozenGradingEntry[];
  readonly status: string;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly sequenceBase: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}): GradingJob {
  return {
    ...row,
    source: row.source as GradingSource,
    status: row.status as GradingJobStatus,
  };
}

function projectOf(auth: AuthContext): string {
  if (auth.projectId === undefined || auth.projectId === "") {
    throw new TypeError("grading requires a project-scoped context");
  }
  return auth.projectId;
}

function gradingContext(organizationId: string, projectId: string): AuthContext {
  return {
    userId: THE_ENGINE,
    organizationId,
    projectId,
    role: "viewer",
    via: "engine",
  };
}

type ResolvedEntry = Awaited<
  ReturnType<typeof resolveProductionGraders>
>[number];

function frozen(entry: ResolvedEntry): FrozenGradingEntry {
  return {
    projectGraderId: entry.projectGraderId,
    graderDefinitionId: entry.definition.definitionId,
    graderDefinitionVersion: entry.definition.definitionVersion,
    graderPassThreshold: entry.passThreshold,
    parameterValues: entry.parameterValues,
    definition: entry.definition,
  };
}

function receiptEntry(entry: FrozenGradingEntry): ProductionGradingPlanEntry {
  return {
    projectGraderId: entry.projectGraderId,
    graderDefinitionId: entry.graderDefinitionId,
    graderDefinitionVersion: entry.graderDefinitionVersion,
    graderPassThreshold: entry.graderPassThreshold,
    parameterValues: entry.parameterValues,
  };
}

async function entriesFromReceipt(
  on: Queryable,
  auth: AuthContext,
  receipt: readonly ProductionGradingPlanEntry[],
): Promise<readonly FrozenGradingEntry[]> {
  return Promise.all(receipt.map(async (entry) => {
    const definition = await getExecutableGraderDefinition(
      auth,
      on,
      entry.graderDefinitionId,
      entry.graderDefinitionVersion,
    );
    if (definition === undefined) {
      throw new Error(
        `production grading plan names unreadable definition ${entry.graderDefinitionId} version ${entry.graderDefinitionVersion}`,
      );
    }
    return { ...entry, definition };
  }));
}

function micros(date: Date): bigint {
  if (Number.isNaN(date.getTime())) throw new TypeError("traceStartedAt is invalid");
  return BigInt(date.getTime()) * 1_000n;
}

/** Serialize the first durable decision for one tenant, project, and trace. */
async function lockTrace(on: Queryable, auth: AuthContext, traceId: string): Promise<void> {
  // JSON array framing is unambiguous and contains no NUL byte, which Postgres
  // text refuses before `hashtextextended` can see it.
  const key = JSON.stringify([auth.organizationId, projectOf(auth), traceId]);
  await on.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function jobForTrace(
  on: Queryable,
  auth: AuthContext,
  traceId: string,
): Promise<GradingJob | undefined> {
  const [row] = await on
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(within(auth, gradingJob, and(
      eq(gradingJob.projectId, projectOf(auth)),
      eq(gradingJob.traceId, traceId),
    )))
    .limit(1);
  return row === undefined ? undefined : jobFromRow(row);
}

function allEntriesHaveResults(
  entries: readonly FrozenGradingEntry[],
  current: readonly CurrentGrade[],
): { readonly complete: boolean; readonly errored: boolean } {
  const byProjectGrader = new Map(
    current.map((grade) => [grade.projectGraderId, grade] as const),
  );
  let errored = false;
  for (const entry of entries) {
    const grade = byProjectGrader.get(entry.projectGraderId);
    if (grade === undefined) return { complete: false, errored: false };
    errored ||= grade.score === null;
  }
  return { complete: true, errored };
}

function maximumGradingSequence(grades: readonly RecordedGrade[]): number {
  return grades.reduce(
    (highest, grade) => Math.max(highest, grade.gradingSequence),
    0,
  );
}

async function notify(on: Queryable, jobId: string): Promise<void> {
  await on.execute(sql`select pg_notify(${GRADING_WORK_CHANNEL}, ${jobId})`);
}

async function enqueue(
  on: Queryable,
  auth: AuthContext,
  input: {
    readonly source: GradingSource;
    readonly simulationId: string | null;
    readonly traceId: string;
    readonly traceStartedAt: Date;
    readonly runId: string | null;
    readonly entries: readonly FrozenGradingEntry[];
    readonly sequenceBase: number;
  },
): Promise<{ readonly job: GradingJob; readonly created: boolean }> {
  const held = await jobForTrace(on, auth, input.traceId);
  if (held !== undefined) return { job: held, created: false };

  const [row] = await on
    .insert(gradingJob)
    .values({
      id: newId("gjb"),
      organizationId: auth.organizationId,
      projectId: projectOf(auth),
      source: input.source,
      simulationId: input.simulationId,
      traceId: input.traceId,
      traceStartedAt: input.traceStartedAt,
      runId: input.runId,
      entries: input.entries,
      sequenceBase: input.sequenceBase,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning(JOB_COLUMNS);

  const job = row === undefined
    ? await jobForTrace(on, auth, input.traceId)
    : jobFromRow(row);
  if (job === undefined) {
    throw new Error(`grading job for trace ${input.traceId} lost its insert race`);
  }
  if (row !== undefined) await notify(on, job.id);
  return { job, created: row !== undefined };
}

async function settleOrdinaryRequest(
  on: Queryable,
  auth: AuthContext,
  input: {
    readonly source: GradingSource;
    readonly simulationId: string | null;
    readonly traceId: string;
    readonly traceStartedAt: Date;
    readonly runId: string | null;
    readonly entries: readonly FrozenGradingEntry[];
  },
): Promise<GradingRequestResult> {
  if (input.entries.length === 0) return { kind: "not_requested" };

  const held = await jobForTrace(on, auth, input.traceId);
  if (held?.status === "pending" || held?.status === "claimed") {
    return { kind: "queued", jobId: held.id, created: false };
  }

  const grades = await readTraceGrades(auth, {
    source: input.source,
    traceId: input.traceId,
    ...(input.runId === null ? {} : { runId: input.runId }),
  });
  const terminal = allEntriesHaveResults(input.entries, grades.current);
  if (terminal.complete) {
    return {
      kind: "terminal",
      outcome: terminal.errored ? "error" : "complete",
    };
  }
  if (held?.status === "abandoned") {
    return { kind: "terminal", outcome: "error" };
  }

  const queued = await enqueue(on, auth, {
    ...input,
    sequenceBase: maximumGradingSequence(grades.history),
  });
  return { kind: "queued", jobId: queued.job.id, created: queued.created };
}

/**
 * Receive the two facts that make one trace gradeable.
 *
 * The simulation row is completion authority for simulations. `endsTrace` is
 * used only for production, where it must come from a supported platform's
 * normalized explicit end event. Evidence readiness is never inferred here.
 */
export async function requestGradingIn(
  on: Queryable,
  auth: AuthContext,
  input: GradingRequest,
): Promise<GradingRequestResult> {
  authorize(auth, "read", here(auth));
  await lockTrace(on, auth, input.traceId);

  if (!input.evidenceReady) return { kind: "waiting", for: "evidence" };

  if (input.source === "simulation") {
    const simulationId = simulationIdOfTrace(input.traceId);
    if (simulationId === undefined) {
      throw new TypeError(`${input.traceId} is not a simulation trace id`);
    }
    const [row] = await on
      .select({
        id: simulation.id,
        projectId: simulation.projectId,
        runId: simulation.runId,
        status: simulation.status,
        modality: simulation.modality,
      })
      .from(simulation)
      .where(within(auth, simulation, and(
        eq(simulation.id, simulationId),
        eq(simulation.projectId, projectOf(auth)),
      )))
      .limit(1)
      .for("share");
    if (row === undefined || row.status !== "completed") {
      return { kind: "waiting", for: "completion" };
    }
    if (input.runId === undefined || input.runId !== row.runId) {
      throw new Error(`simulation ${simulationId} grading handoff names the wrong run`);
    }
    if (input.modality !== row.modality) {
      throw new Error(`simulation ${simulationId} grading handoff names the wrong modality`);
    }
    const resolved = await pinnedSimulationGradersOn(auth, on, simulationId);
    if (resolved === undefined) {
      throw new Error(`completed simulation ${simulationId} has no grading plan`);
    }
    return settleOrdinaryRequest(on, auth, {
      source: "simulation",
      simulationId,
      traceId: input.traceId,
      traceStartedAt: input.traceStartedAt,
      runId: row.runId,
      entries: resolved.map(frozen),
    });
  }

  if (input.runId !== undefined) {
    throw new TypeError("production grading cannot name a run");
  }
  if (!input.endsTrace) return { kind: "waiting", for: "completion" };

  const receipt = await readProductionGradingPlan(auth, input.traceId);
  let entries: readonly FrozenGradingEntry[];
  let traceStartedAt = input.traceStartedAt;
  if (receipt === undefined) {
    const resolved = await resolveProductionGraders(auth, on, {
      projectId: projectOf(auth),
      modality: input.modality,
      traceId: input.traceId,
    });
    entries = resolved.map(frozen);
    await recordProductionGradingPlan(auth, {
      traceId: input.traceId,
      traceStartedAtMicroseconds: micros(input.traceStartedAt),
      entries: entries.map(receiptEntry),
    });
  } else {
    traceStartedAt = new Date(Number(receipt.traceStartedAtMicroseconds / 1_000n));
    entries = await entriesFromReceipt(on, auth, receipt.entries);
  }

  return settleOrdinaryRequest(on, auth, {
    source: "production",
    simulationId: null,
    traceId: input.traceId,
    traceStartedAt,
    runId: null,
    entries,
  });
}

export function requestGrading(
  auth: AuthContext,
  input: GradingRequest,
): Promise<GradingRequestResult> {
  return db().transaction((tx) => requestGradingIn(tx, auth, input));
}

/** The first span time in a small, bounded probe used by simulation completion. */
export async function traceEvidenceStartedAt(
  auth: AuthContext,
  input: {
    readonly source: GradingSource;
    readonly traceId: string;
    readonly runId?: string | undefined;
    readonly window: TimeWindow;
  },
): Promise<Date | undefined> {
  authorize(auth, "read", here(auth));
  const projectId = projectOf(auth);
  if (input.window.to <= input.window.from) {
    throw new RangeError("trace evidence window must end after it starts");
  }
  const MILLION = 1_000_000n;
  const literal = (value: bigint): string => {
    let seconds = value / MILLION;
    let remainder = value % MILLION;
    if (remainder < 0n) {
      seconds -= 1n;
      remainder += MILLION;
    }
    const whole = new Date(Number(seconds) * 1_000).toISOString().slice(0, 19);
    return `${whole.replace("T", " ")}.${remainder.toString().padStart(6, "0")}`;
  };
  const answered = await traceStore().query({
    query: `select toString(toUnixTimestamp64Micro(started_at)) as started_at_micros
              from spans
             where organization_id = {organization_id:String}
               and project_id = {project_id:String}
               and source = {source:String}
               and trace_id = {trace_id:String}
               and started_at >= {from:DateTime64(6, 'UTC')}
               and started_at < {to:DateTime64(6, 'UTC')}
               and (${input.runId === undefined ? "1" : "run_id = {run_id:String}"})
             order by started_at
             limit 1`,
    query_params: {
      organization_id: auth.organizationId,
      project_id: projectId,
      source: input.source,
      trace_id: input.traceId,
      from: literal(input.window.from),
      to: literal(input.window.to),
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
    },
    format: "JSONEachRow",
  });
  const [first] = await answered.json<{ readonly started_at_micros: string }>();
  return first === undefined
    ? undefined
    : new Date(Number(BigInt(first.started_at_micros) / 1_000n));
}

type CompletedProductionTrace = {
  readonly traceId: string;
  readonly endAtMicroseconds: bigint;
  readonly modality: "chat" | "voice";
};

type DrainedSimulationTrace = {
  readonly traceId: string;
  readonly latestAtMicroseconds: bigint;
};

/** The simulation traces in one drained segment, keyed by their control row. */
function simulationTracesIn(
  spans: readonly NewSpan[],
): ReadonlyMap<string, DrainedSimulationTrace> {
  const traces = new Map<string, DrainedSimulationTrace>();
  for (const span of spans) {
    if (span.source !== "simulation") continue;
    const simulationId = simulationIdOfTrace(span.traceId);
    if (simulationId === undefined) continue;
    const held = traces.get(simulationId);
    if (
      held === undefined ||
      span.startedAtMicroseconds > held.latestAtMicroseconds
    ) {
      traces.set(simulationId, {
        traceId: span.traceId,
        latestAtMicroseconds: span.startedAtMicroseconds,
      });
    }
  }
  return traces;
}

/**
 * Wake grading when durable simulation evidence becomes query-visible.
 *
 * A span never completes a simulation here. The existing simulation row is the
 * only completion authority. This handoff covers the opposite ordering from
 * `completeSimulation`: the row committed first, then its accepted evidence
 * drained. Replays reach the frozen run plan and the same trace-level job.
 */
export async function recordSimulationTraces(
  auth: AuthContext,
  spans: readonly NewSpan[],
): Promise<void> {
  if (auth.projectId === undefined) return;
  const traces = simulationTracesIn(spans);
  if (traces.size === 0) return;

  const rows = await db()
    .select({
      id: simulation.id,
      runId: simulation.runId,
      modality: simulation.modality,
    })
    .from(simulation)
    .where(within(auth, simulation, and(
      inArray(simulation.id, [...traces.keys()]),
      eq(simulation.status, "completed"),
    )))
    .orderBy(asc(simulation.id));

  for (const row of rows) {
    const trace = traces.get(row.id);
    if (trace === undefined) continue;
    const traceStartedAt = await traceEvidenceStartedAt(auth, {
      source: "simulation",
      traceId: trace.traceId,
      runId: row.runId,
      // Evidence can use a provider clock far from the control-row clock. The
      // drained span supplies the bounded evidence window; the row supplies
      // completion authority and nothing else.
      window: traceWindowEndingAt(trace.latestAtMicroseconds),
    });
    if (traceStartedAt === undefined) {
      throw new Error(
        `completed simulation trace ${trace.traceId} is not query-visible`,
      );
    }
    await requestGrading(auth, {
      source: "simulation",
      traceId: trace.traceId,
      traceStartedAt,
      runId: row.runId,
      // Ignored for simulations: the completed row above is the authority.
      endsTrace: false,
      evidenceReady: true,
      modality: row.modality as Modality,
    });
  }
}

/**
 * The modality carried by an explicit end from a production platform this
 * release supports. An end from any other producer is not completion authority.
 */
function supportedProductionEndModality(
  span: NewSpan,
): "chat" | "voice" | undefined {
  if (span.source !== "production" || !span.endsTrace) return undefined;
  if (span.agentPlatform === "retell") {
    if (span.connectionType === "retell_chat_api") return "chat";
    if (span.connectionType === "" || span.connectionType === "phone_number") {
      return "voice";
    }
    return undefined;
  }
  if (
    span.agentPlatform === "livekit" &&
    (span.connectionType === "" || span.connectionType === "livekit_room")
  ) {
    return "voice";
  }
  return undefined;
}

function completedProductionTracesIn(
  spans: readonly NewSpan[],
): readonly CompletedProductionTrace[] {
  const completed = new Map<string, CompletedProductionTrace>();
  for (const span of spans) {
    const modality = supportedProductionEndModality(span);
    if (modality === undefined) continue;
    const held = completed.get(span.traceId);
    if (held !== undefined && held.modality !== modality) {
      throw new Error(
        `trace ${span.traceId} has conflicting production modalities`,
      );
    }
    if (
      held === undefined ||
      span.startedAtMicroseconds > held.endAtMicroseconds
    ) {
      completed.set(span.traceId, {
        traceId: span.traceId,
        endAtMicroseconds: span.startedAtMicroseconds,
        modality,
      });
    }
  }
  return [...completed.values()];
}

function traceWindowEndingAt(endAtMicroseconds: bigint): TimeWindow {
  const to = endAtMicroseconds + 1n;
  const width = BigInt(MAXIMUM_WINDOW_MILLISECONDS) * 1_000n;
  const candidate = to - width;
  return {
    from: candidate < EARLIEST_READABLE_MICROSECONDS
      ? EARLIEST_READABLE_MICROSECONDS
      : candidate,
    to,
  };
}

/**
 * Hand query-visible production evidence to grading.
 *
 * The durable drainer calls this only after the spans were appended. A
 * normalized, supported-platform end is the only completion fact. The true
 * trace start is read from ClickHouse, so a final segment cannot shorten the
 * frozen receipt to only the spans it happened to carry. Replays reach the same
 * immutable receipt and, while work is live, the same temporary Postgres job.
 */
export async function recordProductionTraces(
  auth: AuthContext,
  spans: readonly NewSpan[],
): Promise<void> {
  if (auth.projectId === undefined) return;
  for (const completed of completedProductionTracesIn(spans)) {
    const traceStartedAt = await traceEvidenceStartedAt(auth, {
      source: "production",
      traceId: completed.traceId,
      window: traceWindowEndingAt(completed.endAtMicroseconds),
    });
    if (traceStartedAt === undefined) {
      throw new Error(
        `completed production trace ${completed.traceId} is not query-visible`,
      );
    }
    await requestGrading(auth, {
      source: "production",
      traceId: completed.traceId,
      traceStartedAt,
      endsTrace: true,
      evidenceReady: true,
      modality: completed.modality,
    });
  }
}

export async function claimGradingJobs(
  request: GradingClaimRequest,
): Promise<readonly GradingClaim[]> {
  const claimant = validClaimant(request.claimant);
  if (
    !Number.isInteger(request.capacity) ||
    request.capacity < 1 ||
    request.capacity > LARGEST_CLAIM_CAPACITY
  ) {
    throw new RangeError(
      `a claim takes between 1 and ${LARGEST_CLAIM_CAPACITY} grading jobs`,
    );
  }
  const leaseSeconds = request.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new RangeError("a lease is a positive whole number of seconds");
  }

  const now = new Date();
  const silentSince = new Date(now.getTime() - leaseSeconds * 1_000);
  const rows = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: gradingJob.id, attempts: gradingJob.attempts })
      .from(gradingJob)
      .where(or(
        eq(gradingJob.status, "pending"),
        and(eq(gradingJob.status, "claimed"), lt(gradingJob.heartbeatAt, silentSince)),
      ))
      .orderBy(asc(gradingJob.id))
      .limit(request.capacity)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];

    const exhausted = candidates
      .filter((candidate) => candidate.attempts >= MOST_GRADING_ATTEMPTS)
      .map((candidate) => candidate.id);
    if (exhausted.length > 0) {
      await tx
        .update(gradingJob)
        .set({
          status: "abandoned",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt: now,
          lastError: sql`coalesce(${gradingJob.lastError}, 'grading worker lease expired after the final attempt')`,
        })
        .where(inArray(gradingJob.id, exhausted));
    }

    const takeable = candidates
      .filter((candidate) => candidate.attempts < MOST_GRADING_ATTEMPTS)
      .map((candidate) => candidate.id);
    if (takeable.length === 0) return [];

    return tx
      .update(gradingJob)
      .set({
        status: "claimed",
        claimedBy: claimant,
        claimedAt: now,
        heartbeatAt: now,
        attempts: sql`${gradingJob.attempts} + 1`,
      })
      .where(inArray(gradingJob.id, takeable))
      .returning(JOB_COLUMNS);
  });

  return rows.map((row) => {
    const job = jobFromRow(row);
    if (
      job.status !== "claimed" ||
      job.claimedBy === null ||
      job.claimedAt === null ||
      job.heartbeatAt === null
    ) {
      throw new Error(`claimed grading job ${job.id} has no lease`);
    }
    return {
      ...job,
      status: "claimed" as const,
      claimedBy: job.claimedBy,
      claimedAt: job.claimedAt,
      heartbeatAt: job.heartbeatAt,
      auth: gradingContext(job.organizationId, job.projectId),
    };
  });
}

export function watchGradingWork(onWork: () => void): Promise<Listening> {
  return listen(GRADING_WORK_CHANNEL, onWork);
}

function theJob(auth: AuthContext, id: string): SQL {
  return within(auth, gradingJob, and(
    eq(gradingJob.id, id),
    auth.projectId === undefined
      ? undefined
      : eq(gradingJob.projectId, auth.projectId),
  ));
}

export async function recordGradingHeartbeat(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<{ readonly held: true } | undefined> {
  const [row] = await db()
    .update(gradingJob)
    .set({ heartbeatAt: new Date() })
    .where(and(
      theJob(auth, id),
      eq(gradingJob.status, "claimed"),
      eq(gradingJob.claimedBy, validClaimant(claimant)),
    ))
    .returning({ id: gradingJob.id });
  return row === undefined ? undefined : { held: true };
}

/** Delete temporary work only after all durable grades were appended. */
export async function finishGradingJob(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<{ readonly id: string } | undefined> {
  const [row] = await db()
    .delete(gradingJob)
    .where(and(
      theJob(auth, id),
      eq(gradingJob.status, "claimed"),
      eq(gradingJob.claimedBy, validClaimant(claimant)),
    ))
    .returning({ id: gradingJob.id });
  return row;
}

export async function releaseGradingJob(
  auth: AuthContext,
  id: string,
  claimant: string,
  why: string,
): Promise<GradingJob | undefined> {
  const reason = why.trim();
  if (reason === "") throw new TypeError("releasing a grading job says why");
  return db().transaction(async (tx) => {
    const [held] = await tx
      .select({ attempts: gradingJob.attempts })
      .from(gradingJob)
      .where(and(
        theJob(auth, id),
        eq(gradingJob.status, "claimed"),
        eq(gradingJob.claimedBy, validClaimant(claimant)),
      ))
      .limit(1)
      .for("update");
    if (held === undefined) return undefined;

    const abandoned = held.attempts >= MOST_GRADING_ATTEMPTS;
    const [row] = await tx
      .update(gradingJob)
      .set({
        status: abandoned ? "abandoned" : "pending",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        lastError: reason,
        finishedAt: abandoned ? new Date() : null,
      })
      .where(eq(gradingJob.id, id))
      .returning(JOB_COLUMNS);
    if (row === undefined) return undefined;
    if (!abandoned) await notify(tx, row.id);
    return jobFromRow(row);
  });
}

export async function getGradingJob(
  auth: AuthContext,
  id: string,
): Promise<GradingJob | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(theJob(auth, id))
    .limit(1);
  return row === undefined ? undefined : jobFromRow(row);
}

export async function getGradingJobForTrace(
  auth: AuthContext,
  traceId: string,
): Promise<GradingJob | undefined> {
  authorize(auth, "read", here(auth));
  return jobForTrace(db(), auth, traceId);
}

export async function listGradingJobsForSimulation(
  auth: AuthContext,
  simulationId: string,
): Promise<readonly GradingJob[]> {
  authorize(auth, "read", here(auth));
  const rows = await db()
    .select(JOB_COLUMNS)
    .from(gradingJob)
    .where(within(auth, gradingJob, eq(gradingJob.simulationId, simulationId)))
    .orderBy(asc(gradingJob.id));
  return rows.map(jobFromRow);
}

export type TraceGradingState =
  | "not_requested"
  | "pending"
  | "running"
  | "complete"
  | "error";

export type NamedRecordedGrade = RecordedGrade & { readonly graderName: string };
export type NamedCurrentGrade = CurrentGrade & { readonly graderName: string };

export type TraceGrading = {
  readonly state: TraceGradingState;
  readonly history: readonly NamedRecordedGrade[];
  readonly current: readonly NamedCurrentGrade[];
  readonly combinedScore: number | null;
};

export type TraceGradingRef = {
  readonly source: GradingSource;
  readonly traceId: string;
  readonly runId?: string | undefined;
};

async function selectedEntries(
  on: Queryable,
  auth: AuthContext,
  ref: TraceGradingRef,
): Promise<readonly FrozenGradingEntry[] | undefined> {
  if (ref.source === "production") {
    const receipt = await readProductionGradingPlan(auth, ref.traceId);
    return receipt === undefined
      ? undefined
      : entriesFromReceipt(on, auth, receipt.entries);
  }
  const simulationId = simulationIdOfTrace(ref.traceId);
  if (simulationId === undefined || ref.runId === undefined) return undefined;
  const [row] = await on
    .select({ status: simulation.status, runId: simulation.runId })
    .from(simulation)
    .where(within(auth, simulation, eq(simulation.id, simulationId)))
    .limit(1);
  if (row === undefined || row.status !== "completed" || row.runId !== ref.runId) {
    return undefined;
  }
  const resolved = await pinnedSimulationGradersOn(auth, on, simulationId);
  return resolved?.map(frozen);
}

async function namesFor(
  on: Queryable,
  auth: AuthContext,
  projectGraderIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (projectGraderIds.length === 0) return new Map();
  const rows = await on
    .select({ id: projectGrader.id, name: graderDefinition.name })
    .from(projectGrader)
    .innerJoin(graderDefinition, eq(graderDefinition.id, projectGrader.graderDefinitionId))
    .where(within(auth, projectGrader, inArray(projectGrader.id, [...new Set(projectGraderIds)])));
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

export async function readTraceGrading(
  auth: AuthContext,
  ref: TraceGradingRef,
): Promise<TraceGrading | undefined> {
  authorize(auth, "read", here(auth));
  const entries = await selectedEntries(db(), auth, ref);
  const grades = await readTraceGrades(auth, ref);
  const job = await jobForTrace(db(), auth, ref.traceId);

  // A production trace can be visible before its explicit end/evidence-ready
  // handshake freezes selection. That is pending, not an empty decision.
  if (entries === undefined) {
    if (ref.source === "simulation") return undefined;
    return { state: "pending", history: [], current: [], combinedScore: null };
  }

  const names = await namesFor(
    db(),
    auth,
    [...entries.map((entry) => entry.projectGraderId),
      ...grades.history.map((grade) => grade.projectGraderId)],
  );
  const named = <T extends RecordedGrade>(grade: T): T & { graderName: string } => {
    const graderName = names.get(grade.projectGraderId);
    if (graderName === undefined) {
      throw new Error(`grade names unreadable project grader ${grade.projectGraderId}`);
    }
    return { ...grade, graderName };
  };
  const history = grades.history.map(named);
  const current = grades.current.map(named);

  if (entries.length === 0) {
    return { state: "not_requested", history, current, combinedScore: null };
  }
  if (job?.status === "claimed") {
    return { state: "running", history, current, combinedScore: null };
  }
  if (job?.status === "pending") {
    return { state: "pending", history, current, combinedScore: null };
  }
  const terminal = allEntriesHaveResults(entries, grades.current);
  if (!terminal.complete) {
    return {
      state: job?.status === "abandoned" ? "error" : "pending",
      history,
      current,
      combinedScore: null,
    };
  }
  if (terminal.errored) {
    return { state: "error", history, current, combinedScore: null };
  }
  return {
    state: "complete",
    history,
    current,
    combinedScore: combinedGradeScore(
      entries.map((entry) => entry.projectGraderId),
      grades.current,
    ),
  };
}

const MOST_RUNS_PER_PROGRESS_READ = 100;
const MOST_SIMULATIONS_PER_STATE_READ = 200;

type SimulationPlanRow = {
  readonly simulationId: string;
  readonly runId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly status: string;
  readonly groups: unknown;
  readonly jobStatus: string | null;
};

type ResolvedSimulationState = {
  readonly gradable: boolean;
  readonly state: TraceGradingState | null;
};

export type SimulationGradingState = {
  readonly simulationId: string;
  readonly state: TraceGradingState | null;
};

export type SimulationGradingRef = {
  readonly simulationId: string;
  readonly runId: string;
};

export type RunGradingProgress = {
  readonly runId: string;
  readonly gradable: number;
  readonly graded: number;
};

async function simulationPlanRows(
  on: Queryable,
  auth: AuthContext,
  condition: SQL,
): Promise<readonly SimulationPlanRow[]> {
  const rows = await on
    .select({
      simulationId: simulation.id,
      runId: simulation.runId,
      testId: simulation.testId,
      testVersionId: simulation.testVersionId,
      status: simulation.status,
      jobStatus: gradingJob.status,
    })
    .from(simulation)
    .leftJoin(gradingJob, eq(gradingJob.simulationId, simulation.id))
    .where(within(auth, simulation, condition));
  if (rows.length === 0) return [];

  // Read each run's plan once. Joining the JSON plan onto every simulation
  // would repeat the same potentially large value for every row on the page.
  const plans = await on
    .select({ runId: gradingPlan.runId, groups: gradingPlan.groups })
    .from(gradingPlan)
    .where(within(
      auth,
      gradingPlan,
      inArray(gradingPlan.runId, [...new Set(rows.map((row) => row.runId))]),
    ));
  const byRun = new Map(plans.map((plan) => [plan.runId, plan.groups] as const));
  return rows.map((row) => {
    const groups = byRun.get(row.runId);
    if (groups === undefined) throw new Error(`run ${row.runId} has no grading plan`);
    return { ...row, groups };
  });
}

function factsByTrace(
  facts: readonly CurrentSimulationGradeFact[],
): ReadonlyMap<string, ReadonlyMap<string, CurrentSimulationGradeFact>> {
  const traces = new Map<string, Map<string, CurrentSimulationGradeFact>>();
  for (const fact of facts) {
    const grades = traces.get(fact.traceId) ?? new Map();
    grades.set(fact.projectGraderId, fact);
    traces.set(fact.traceId, grades);
  }
  return traces;
}

function selectedGroup(row: SimulationPlanRow): PlanGroup {
  const group = (row.groups as readonly PlanGroup[]).find(
    (one) =>
      one.tag === "test" &&
      one.testId === row.testId &&
      one.testVersionId === row.testVersionId,
  );
  if (group === undefined) {
    throw new Error(`simulation ${row.simulationId} has no matching test grading plan`);
  }
  return group;
}

/** Whether Postgres alone cannot settle this simulation's grading state. */
function needsCurrentGradeFacts(row: SimulationPlanRow): boolean {
  if (row.status !== "completed") return false;
  if (selectedGroup(row).items.length === 0) return false;
  return row.jobStatus === null || row.jobStatus === "abandoned";
}

function resolvedSimulationState(
  row: SimulationPlanRow,
  facts: ReadonlyMap<string, ReadonlyMap<string, CurrentSimulationGradeFact>>,
): ResolvedSimulationState {
  if (row.status !== "completed") return { gradable: false, state: null };

  const group = selectedGroup(row);
  if (group.items.length === 0) {
    return { gradable: false, state: "not_requested" };
  }

  if (row.jobStatus === "claimed") return { gradable: true, state: "running" };
  if (row.jobStatus === "pending") return { gradable: true, state: "pending" };

  const traceId = traceIdOfSimulation(row.simulationId);
  if (traceId === undefined) {
    throw new Error(`simulation ${row.simulationId} has no trace identity`);
  }
  const current = facts.get(traceId);
  let errored = false;
  for (const item of group.items) {
    const grade = current?.get(item.projectGraderId);
    if (grade === undefined) {
      return {
        gradable: true,
        state: row.jobStatus === "abandoned" ? "error" : "pending",
      };
    }
    errored ||= grade.errored;
  }
  return { gradable: true, state: errored ? "error" : "complete" };
}

/** One batch state read for the simulations on an API page. */
export async function readSimulationGradingStates(
  auth: AuthContext,
  refs: readonly SimulationGradingRef[],
): Promise<readonly SimulationGradingState[]> {
  authorize(auth, "read", here(auth));
  if (refs.length > MOST_SIMULATIONS_PER_STATE_READ) {
    throw new RangeError(
      `one grading-state read accepts at most ${MOST_SIMULATIONS_PER_STATE_READ} simulations`,
    );
  }
  if (refs.length === 0) return [];

  const bySimulation = new Map<string, SimulationGradingRef>();
  for (const ref of refs) {
    if (ref.simulationId === "" || ref.runId === "") {
      throw new TypeError("a simulation grading-state read names its simulation and run");
    }
    if (bySimulation.has(ref.simulationId)) {
      throw new TypeError("a simulation grading-state read cannot repeat a simulation");
    }
    bySimulation.set(ref.simulationId, ref);
  }

  const rows = await simulationPlanRows(
    db(),
    auth,
    inArray(simulation.id, [...bySimulation.keys()]),
  );
  const eligible = rows.filter(
    (row) => bySimulation.get(row.simulationId)?.runId === row.runId,
  );
  const traceIds = eligible.filter(needsCurrentGradeFacts).flatMap((row) => {
    const traceId = traceIdOfSimulation(row.simulationId);
    return traceId === undefined ? [] : [traceId];
  });
  const facts = factsByTrace(await readCurrentSimulationGradeFacts(auth, { traceIds }));
  const byId = new Map(eligible.map((row) => [row.simulationId, row] as const));
  return refs.flatMap((ref) => {
    const row = byId.get(ref.simulationId);
    return row === undefined
      ? []
      : [{
          simulationId: row.simulationId,
          state: resolvedSimulationState(row, facts).state,
        }];
  });
}

/** One batch projection for the run cards on a bounded list page. */
export async function readRunGradingProgress(
  auth: AuthContext,
  runIds: readonly string[],
): Promise<readonly RunGradingProgress[]> {
  authorize(auth, "read", here(auth));
  if (runIds.length > MOST_RUNS_PER_PROGRESS_READ) {
    throw new RangeError(
      `one grading-progress read accepts at most ${MOST_RUNS_PER_PROGRESS_READ} runs`,
    );
  }
  const unique = [...new Set(runIds)];
  if (unique.length === 0) return [];
  if (unique.some((runId) => runId === "")) {
    throw new TypeError("a grading-progress read cannot name an empty run");
  }

  const visible = await db()
    .select({ id: run.id })
    .from(run)
    .where(within(auth, run, inArray(run.id, unique)));
  const visibleIds = new Set(visible.map((one) => one.id));
  const ordered = unique.filter((runId) => visibleIds.has(runId));
  if (ordered.length === 0) return [];

  const rows = await simulationPlanRows(
    db(),
    auth,
    inArray(simulation.runId, ordered),
  );
  const traceIds = rows.filter(needsCurrentGradeFacts).flatMap((row) => {
    const traceId = traceIdOfSimulation(row.simulationId);
    return traceId === undefined ? [] : [traceId];
  });
  const facts = factsByTrace(
    await readCurrentSimulationGradeFacts(auth, { traceIds }),
  );
  const totals = new Map<string, { runId: string; gradable: number; graded: number }>(
    ordered.map((runId) => [runId, { runId, gradable: 0, graded: 0 }]),
  );
  for (const row of rows) {
    const state = resolvedSimulationState(row, facts);
    const total = totals.get(row.runId);
    if (total === undefined || !state.gradable) continue;
    total.gradable += 1;
    if (state.state === "complete" || state.state === "error") total.graded += 1;
  }
  return ordered.map((runId) => totals.get(runId)!);
}

export async function regradeTrace(
  auth: AuthContext,
  ref: TraceGradingRef,
): Promise<RegradeTraceResult> {
  authorize(auth, "regrade", here(auth));
  return db().transaction(async (tx) => {
    await lockTrace(tx, auth, ref.traceId);
    const entries = await selectedEntries(tx, auth, ref);
    if (entries === undefined) {
      throw new Error(`trace ${ref.traceId} has no frozen grading plan`);
    }
    if (entries.length === 0) return { kind: "not_requested" };

    const existing = await jobForTrace(tx, auth, ref.traceId);
    if (existing !== undefined) {
      if (existing.status === "pending" || existing.status === "claimed") {
        return {
          kind: "queued",
          jobId: existing.id,
          reopened: false,
          alreadyWaiting: true,
        };
      }
      const prior = await readTraceGrades(auth, ref);
      const [row] = await tx
        .update(gradingJob)
        .set({
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          sequenceBase: Math.max(
            maximumGradingSequence(prior.history),
            existing.sequenceBase + existing.attempts,
          ),
          attempts: 0,
          lastError: null,
          finishedAt: null,
        })
        .where(eq(gradingJob.id, existing.id))
        .returning({ id: gradingJob.id });
      if (row === undefined) throw new Error(`grading job ${existing.id} disappeared`);
      await notify(tx, row.id);
      return {
        kind: "queued",
        jobId: row.id,
        reopened: true,
        alreadyWaiting: false,
      };
    }

    const prior = await readTraceGrades(auth, ref);
    const traceStartedAtMicroseconds = prior.history[0]?.traceStartedAtMicroseconds;
    let traceStartedAt: Date;
    let simulationId: string | null = null;
    if (ref.source === "production") {
      const receipt = await readProductionGradingPlan(auth, ref.traceId);
      if (receipt === undefined) throw new Error(`trace ${ref.traceId} has no production plan`);
      traceStartedAt = new Date(Number(receipt.traceStartedAtMicroseconds / 1_000n));
    } else {
      simulationId = simulationIdOfTrace(ref.traceId) ?? null;
      if (simulationId === null || ref.runId === undefined) {
        throw new Error(`trace ${ref.traceId} is not a simulation trace`);
      }
      const [row] = await tx
        .select({ startedAt: simulation.startedAt })
        .from(simulation)
        .where(within(auth, simulation, eq(simulation.id, simulationId)))
        .limit(1);
      if (row?.startedAt === null || row?.startedAt === undefined) {
        throw new Error(`simulation ${simulationId} has no trace start`);
      }
      traceStartedAt = row.startedAt;
    }
    if (traceStartedAtMicroseconds !== undefined) {
      traceStartedAt = new Date(Number(traceStartedAtMicroseconds / 1_000n));
    }

    const queued = await enqueue(tx, auth, {
      source: ref.source,
      simulationId,
      traceId: ref.traceId,
      traceStartedAt,
      runId: ref.runId ?? null,
      entries,
      sequenceBase: maximumGradingSequence(prior.history),
    });
    return {
      kind: "queued",
      jobId: queued.job.id,
      reopened: true,
      alreadyWaiting: false,
    };
  });
}

export type { FrozenGradingEntry, GradingJobStatus, GradingSource, Listening };
