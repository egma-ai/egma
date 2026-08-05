import { isId, newId } from "@egma/ids";
import { and, asc, count, desc, eq, inArray, isNull, isNotNull, lt, type SQL } from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import {
  agent,
  connection,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { persona } from "../schema/personas.ts";
import {
  COMPLETED_ENDING_REASONS,
  FAILED_ENDING_REASONS,
  run,
  simulation,
  type RunStatus,
  type RunTrigger,
  type SimulationEndingReason,
  type SimulationStatus,
} from "../schema/runs.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
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
 * Writers keep to one lock order — simulation rows first, the run header last
 * — so the claim path, the cancel path and the report path do not deadlock
 * each other. (Two bulk simulation writes racing over one set can still, in
 * principle, collide over row order inside a statement; Postgres aborts one
 * and both callers here are retried by their nature — a sweep re-runs, a
 * cancel is re-asked.) The header is finalized under its own row lock by
 * whichever terminal transition lands last, which is what lets the counts be
 * written once, together, and never by two writers at once.
 */

export type NewRun = {
  readonly agentId: string;
  readonly connectionId: string;
  /** Who calls, by identity, in the order the simulations should sit. */
  readonly personaIds: readonly string[];
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
  /** The selection as it was requested — provenance, never the pin. */
  readonly requestedPersonaIds: readonly string[];
  readonly connectionSnapshot: ConnectionSnapshot;
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
  /** Born `queued`, in the order the personas were named. */
  readonly simulations: readonly Simulation[];
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
  readonly position: number;
  readonly connectionType: ConnectionType;
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
  readonly transcript: unknown;
  readonly events: unknown;
  readonly metrics: unknown;
  readonly recordingReference: string | null;
  readonly createdAt: Date;
};

export type CompletedEndingReason = (typeof COMPLETED_ENDING_REASONS)[number];
export type FailedEndingReason = (typeof FAILED_ENDING_REASONS)[number];

/** What the simulator reports about a conversation that happened. */
export type SimulationReport = {
  readonly endingReason: CompletedEndingReason;
  readonly transcript: unknown;
  readonly events?: unknown;
  readonly metrics?: unknown;
  /** Measured, never declared; a chat simulation reports none. */
  readonly measuredAudioBandHertz?: number | undefined;
  readonly recordingReference?: string | undefined;
};

/**
 * What the simulator reports about a simulation that never produced a
 * conversation to grade — or died producing one, in which case the partial
 * transcript is the honest "started, never finished" record.
 *
 * `orphaned` is deliberately not a reason a simulator can give: it is the
 * sweep's word for a simulator that stopped answering, and one still
 * answering cannot claim it.
 */
export type SimulationFailure = {
  readonly reason: Exclude<FailedEndingReason, "orphaned">;
  readonly transcript?: unknown;
  readonly events?: unknown;
  readonly metrics?: unknown;
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
  requestedPersonas: run.requestedPersonas,
  connectionSnapshot: run.connectionSnapshot,
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
  position: simulation.position,
  connectionType: simulation.connectionType,
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
  transcript: simulation.transcript,
  events: simulation.events,
  metrics: simulation.metrics,
  recordingReference: simulation.recordingReference,
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
  readonly requestedPersonas: unknown;
  readonly connectionSnapshot: unknown;
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
 * More personas than this on one run is a selection nobody typed by hand, and
 * `expected_simulation_count` is the denominator a progress page divides by —
 * it should be a number a person can watch count up.
 */
const MOST_SIMULATIONS_PER_RUN = 200;

/** How many queued simulations one claim may take, however large the fleet. */
const LARGEST_CLAIM_CAPACITY = 50;

/** How long a claimed simulation may go silent before the sweep calls it. */
const DEFAULT_STALE_AFTER_SECONDS = 60;

/**
 * The failure reasons a simulator may give — everything but `orphaned`, which
 * is the sweep's own word. The types already say so; this is the backstop
 * for the caller the types could not see.
 */
const REPORTABLE_FAILURE_REASONS: readonly FailedEndingReason[] =
  FAILED_ENDING_REASONS.filter((reason) => reason !== "orphaned");

/**
 * The shape guards on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller wearing a type it does not have.
 */
function requestedPersonaIdsFromRow(
  value: unknown,
  runId: string,
): readonly string[] {
  const malformed = () =>
    new Error(
      `run ${runId} holds a requested-persona selection in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { personaIds } = value as Record<string, unknown>;
  if (!Array.isArray(personaIds) || personaIds.length === 0) throw malformed();
  for (const id of personaIds) {
    if (typeof id !== "string") throw malformed();
  }
  return personaIds as string[];
}

function connectionSnapshotFromRow(
  value: unknown,
  runId: string,
): ConnectionSnapshot {
  const malformed = () =>
    new Error(
      `run ${runId} holds a connection snapshot in a shape egma never writes; the row needs repairing before anybody can read it`,
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

function runFromRow(row: RunRow): Run {
  const { requestedPersonas, connectionSnapshot, status, triggeredVia, ...rest } =
    row;
  return {
    ...rest,
    status: status as RunStatus,
    triggeredVia: triggeredVia as RunTrigger,
    requestedPersonaIds: requestedPersonaIdsFromRow(requestedPersonas, row.id),
    connectionSnapshot: connectionSnapshotFromRow(connectionSnapshot, row.id),
  };
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function runInActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(run.projectId, auth.projectId);
}

function simulationInActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(simulation.projectId, auth.projectId);
}

/** The named run, within the caller's tenancy and scope. */
function theRun(auth: AuthContext, id: string): SQL {
  return within(auth, run, and(eq(run.id, id), runInActingProject(auth)));
}

/**
 * The claimant's name for itself, as it will be stored: trimmed, non-empty,
 * short enough to be a label. An operational identifier, never an identity in
 * egma's tables — two replicas telling each other apart is all it is for.
 */
function validClaimant(claimant: string): string {
  const trimmed = claimant.trim();
  if (trimmed === "") throw new Error("a claimant needs a name");
  if (trimmed.length > 200) {
    throw new Error("a claimant's name fits in 200 characters");
  }
  return trimmed;
}

/**
 * Everything about the named ids that is answerable without the database:
 * there is at least one, not more than a run may hold, every one is a persona
 * id, and each is named once — asking for the same persona twice would be a
 * repeat count, which is a decision nobody has made yet.
 */
function validRequestedPersonas(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new Error(
      "a run needs at least one persona, because a run with no simulations checks nothing",
    );
  }
  if (ids.length > MOST_SIMULATIONS_PER_RUN) {
    throw new Error(
      `a run conducts at most ${MOST_SIMULATIONS_PER_RUN} simulations`,
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("prs", id)) {
      throw new Error(`"${id}" is not a persona id`);
    }
    if (seen.has(id)) {
      throw new Error(`persona ${id} is named twice on one run`);
    }
    seen.add(id);
  }
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
      throw new Error(`there is no persona ${id} in this project`);
    }
    if (row.deletedAt !== null) {
      throw new Error(
        `persona ${id} is deleted, and a run cannot conduct a simulation with a deleted persona`,
      );
    }
    return { personaId: id, personaVersionId: row.currentVersionId };
  });
}

/**
 * The run, its k simulations born `queued`, and the facts stamped at start —
 * the requested selection as provenance, the connection's non-secret shape as
 * snapshot, the persona versions as each simulation's pin — in one
 * transaction, so nothing a team triggers can half-exist.
 *
 * The connection is read alive, on the named agent, in the acting project;
 * the composite foreign keys re-check the same pairings underneath, for every
 * path that does not come through here.
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
  if (!isId("agt", input.agentId)) {
    throw new Error(`"${input.agentId}" is not an agent id`);
  }
  if (!isId("con", input.connectionId)) {
    throw new Error(`"${input.connectionId}" is not a connection id`);
  }
  validRequestedPersonas(input.personaIds);
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
            eq(connection.agentId, input.agentId),
            eq(connection.projectId, projectId),
            isNull(connection.deletedAt),
            isNull(agent.deletedAt),
          ),
        ),
      )
      .limit(1);

    if (reached === undefined) {
      throw new Error(
        `there is no connection ${input.connectionId} on agent ${input.agentId} in this project`,
      );
    }

    if (retryOfRunId !== null) {
      const [retried] = await tx
        .select({ id: run.id })
        .from(run)
        .where(theRun(auth, retryOfRunId))
        .limit(1);
      if (retried === undefined) {
        throw new Error(`there is no run ${retryOfRunId} in this project`);
      }
    }

    const pinned = await resolvePersonaVersions(
      tx,
      auth,
      projectId,
      input.personaIds,
    );

    const [header] = await tx
      .insert(run)
      .values({
        id: runId,
        organizationId: auth.organizationId,
        projectId,
        agentId: input.agentId,
        connectionId: input.connectionId,
        label,
        status: "pending",
        triggeredVia: "manual",
        triggeredBy: auth.userId,
        requestedPersonas: { personaIds: input.personaIds },
        connectionSnapshot: {
          type: reached.type,
          modality: reached.modality,
          topology: reached.topology,
          environment: reached.environment,
          config: reached.config,
        },
        expectedSimulationCount: input.personaIds.length,
        retryOfRunId,
        createdAt: now,
      })
      .returning(RUN_COLUMNS);

    if (header === undefined) throw new Error("the run was not written");

    const simulations = await tx
      .insert(simulation)
      .values(
        pinned.map(({ personaId, personaVersionId }, index) => ({
          id: newId("sim"),
          runId,
          organizationId: auth.organizationId,
          projectId,
          agentId: input.agentId,
          connectionId: input.connectionId,
          personaId,
          personaVersionId,
          position: index + 1,
          connectionType: reached.type,
          modality: reached.modality,
          status: "queued",
          createdAt: now,
        })),
      )
      .returning(SIMULATION_COLUMNS);

    return { header, simulations };
  });

  return {
    ...runFromRow(written.header),
    simulations: written.simulations
      .map((row) => row as Simulation)
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

const DEFAULT_PAGE_SIZE = 50;
const LARGEST_PAGE_SIZE = 200;

export async function listRuns(
  auth: AuthContext,
  page?: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Promise<RunPage> {
  authorize(auth, "read", here(auth));

  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LARGEST_PAGE_SIZE) {
    throw new Error(`a page holds between 1 and ${LARGEST_PAGE_SIZE} runs`);
  }
  const cursor = page?.cursor;
  if (cursor !== undefined && !isId("run", cursor)) {
    throw new Error(`"${cursor}" is not a run id, so it cannot be a cursor`);
  }

  const olderThanCursor = cursor === undefined ? undefined : lt(run.id, cursor);

  // One row beyond the page answers "is there more?" without a second query.
  const rows = await db()
    .select(RUN_COLUMNS)
    .from(run)
    .where(within(auth, run, and(runInActingProject(auth), olderThanCursor)))
    .orderBy(desc(run.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit).map(runFromRow);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * One run's simulations, in the order the personas were named. The whole
 * list, unpaged, because a run holds at most `MOST_SIMULATIONS_PER_RUN` of
 * them — the cap `startRun` enforces is what makes this read bounded.
 */
export async function listSimulations(
  auth: AuthContext,
  runId: string,
): Promise<readonly Simulation[] | undefined> {
  authorize(auth, "read", here(auth));

  if ((await getRun(auth, runId)) === undefined) return undefined;

  const rows = await db()
    .select(SIMULATION_COLUMNS)
    .from(simulation)
    .where(within(auth, simulation, eq(simulation.runId, runId)))
    .orderBy(asc(simulation.position));

  return rows.map((row) => row as Simulation);
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
        and(eq(simulation.id, id), simulationInActingProject(auth)),
      ),
    )
    .limit(1);

  return row === undefined ? undefined : (row as Simulation);
}

/**
 * Whether every conversation of the run has landed, and if so the one write
 * that freezes the header: the three counts, `finished_at`, and the terminal
 * status, together.
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
): Promise<void> {
  const [header] = await tx
    .select({ id: run.id, status: run.status, finishedAt: run.finishedAt })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
    .for("update");

  if (header === undefined || header.finishedAt !== null) return;

  const tallies = await tx
    .select({ status: simulation.status, howMany: count() })
    .from(simulation)
    .where(eq(simulation.runId, runId))
    .groupBy(simulation.status);

  const byStatus = new Map(tallies.map((row) => [row.status, row.howMany]));
  const stillMoving = ["queued", "claimed", "running"].some(
    (status) => (byStatus.get(status) ?? 0) > 0,
  );
  if (stillMoving) return;

  await tx
    .update(run)
    .set({
      // A canceled run keeps its status; anything else that got every
      // simulation to a terminal state completed, whatever the contents.
      ...(header.status === "canceled" ? {} : { status: "completed" }),
      completedCount: byStatus.get("completed") ?? 0,
      failedCount: byStatus.get("failed") ?? 0,
      canceledCount: byStatus.get("canceled") ?? 0,
      finishedAt: now,
    })
    .where(eq(run.id, runId));
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
      throw new Error(`run ${id} is completed, and a completed run has nothing left to cancel`);
    }

    // Simulation rows first, the header last — the one lock order every
    // writer keeps. These `where`s narrow by the run id just checked above.
    await tx
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
      );

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
      throw new Error(
        `run ${id} is completed, and a completed run has nothing left to cancel`,
      );
    }

    await finalizeRunIfDone(tx, id, now);

    const [settled] = await tx
      .select(RUN_COLUMNS)
      .from(run)
      .where(theRun(auth, id))
      .limit(1);
    return settled === undefined ? undefined : runFromRow(settled);
  });
}

/**
 * The atomic claim. Up to `capacity` of the oldest queued simulations the
 * caller can reach move to `claimed` in one transaction, stamped with the
 * claimant and their first heartbeat; whatever another claimant holds locked
 * is skipped rather than waited on, so two simulators drain one queue without
 * ever taking the same conversation. The capacity is the simulator's own
 * declaration of what it can hold — a big run degrades to a queue, never to
 * overload.
 *
 * Every claimed simulation's run leaves `pending` here, because a run has
 * started when its first conversation is someone's to conduct.
 */
export async function claimSimulations(
  auth: AuthContext,
  input: { readonly claimant: string; readonly capacity: number },
): Promise<readonly Simulation[]> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const claimant = validClaimant(input.claimant);
  const { capacity } = input;
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
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.status, "queued"),
            simulationInActingProject(auth),
          ),
        ),
      )
      .orderBy(asc(simulation.id))
      .limit(capacity)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

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
      .returning(SIMULATION_COLUMNS);

    // The runs these came from, each flipped at most once, one at a time in
    // one order — so two claimants touching the same runs cannot deadlock.
    // Bare `eq`s: every id came off the tenancy-checked rows just claimed.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const startedRunId of runIds) {
      await tx
        .update(run)
        .set({ status: "running", startedAt: now })
        .where(and(eq(run.id, startedRunId), eq(run.status, "pending")));
    }

    return rows;
  });

  return claimed
    .map((row) => row as Simulation)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Still alive, still holding this conversation — and the answer carries the
 * one directive that travels back on a heartbeat: whether cancellation has
 * been requested. `undefined` is a heartbeat with nothing under it: a
 * simulation out of reach, not this claimant's, or no longer moving — the
 * signal to stop, not to retry.
 */
export async function recordSimulationHeartbeat(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<{ readonly cancelRequested: boolean } | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const [row] = await db()
    .update(simulation)
    .set({ heartbeatAt: new Date() })
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.id, id),
          eq(simulation.claimedBy, validClaimant(claimant)),
          inArray(simulation.status, ["claimed", "running"]),
          simulationInActingProject(auth),
        ),
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
 */
export async function startSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();
  const [row] = await db()
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
          simulationInActingProject(auth),
        ),
      ),
    )
    .returning(SIMULATION_COLUMNS);

  return row === undefined ? undefined : (row as Simulation);
}

/**
 * A conversation happened and this is its record: `running → completed`, the
 * report written once with the terminal facts — how it ended, the transcript,
 * the measured audio band that can never be backfilled. If it was the
 * run's last moving simulation, the header is finalized in the same
 * transaction.
 */
export async function completeSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  report: SimulationReport,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const named = validClaimant(claimant);
  if (!COMPLETED_ENDING_REASONS.includes(report.endingReason)) {
    throw new Error(
      `"${report.endingReason}" is not a way a conversation ends`,
    );
  }
  const band = report.measuredAudioBandHertz;
  if (band !== undefined && (!Number.isInteger(band) || band <= 0)) {
    throw new Error("a measured audio band is a positive whole number of hertz");
  }
  const recording = report.recordingReference?.trim() || null;

  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({
        status: "completed",
        endingReason: report.endingReason,
        endedAt: now,
        heartbeatAt: now,
        transcript: report.transcript ?? null,
        events: report.events ?? null,
        metrics: report.metrics ?? null,
        measuredAudioBandHertz: band ?? null,
        recordingReference: recording,
      })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, named),
            eq(simulation.status, "running"),
            simulationInActingProject(auth),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;
    await finalizeRunIfDone(tx, row.runId, now);
    return row as Simulation;
  });
}

/**
 * The simulation ends without a conversation to grade — or with a partial
 * one, kept as the honest "started, never finished" record. From `claimed`
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

  const named = validClaimant(claimant);
  if (!REPORTABLE_FAILURE_REASONS.includes(failure.reason)) {
    throw new Error(`"${failure.reason}" is not a way a simulation fails`);
  }

  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({
        status: "failed",
        endingReason: failure.reason,
        endedAt: now,
        heartbeatAt: now,
        transcript: failure.transcript ?? null,
        events: failure.events ?? null,
        metrics: failure.metrics ?? null,
      })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, named),
            inArray(simulation.status, ["claimed", "running"]),
            simulationInActingProject(auth),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;
    await finalizeRunIfDone(tx, row.runId, now);
    return row as Simulation;
  });
}

/**
 * The simulator honors the cancel it was told about: `claimed` or `running`
 * to `canceled`, by the claimant, and only where the intent was actually
 * recorded — a simulator abandoning a conversation nobody canceled is a
 * failure, not a cancellation, and is refused by the same guarded update
 * that checks everything else.
 */
export async function markSimulationCanceled(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({ status: "canceled", endedAt: now, heartbeatAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, validClaimant(claimant)),
            inArray(simulation.status, ["claimed", "running"]),
            isNotNull(simulation.cancelRequestedAt),
            simulationInActingProject(auth),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;
    await finalizeRunIfDone(tx, row.runId, now);
    return row as Simulation;
  });
}

/**
 * The orphan sweep: every claimed or running simulation whose simulator has
 * been silent past the staleness window is marked `failed` with reason
 * `orphaned` — an honest "started, never finished" instead of a row stuck
 * running forever — and any run that was waiting only on orphans is
 * finalized. Returns what it swept, so the caller can say what it did.
 *
 * The staleness window is measured in whole seconds against the last
 * heartbeat. The default is generous next to the heartbeat interval, because
 * the sweep's one sin would be calling a slow simulator dead.
 */
export async function sweepOrphanedSimulations(
  auth: AuthContext,
  options?: { readonly staleAfterSeconds?: number | undefined },
): Promise<readonly Simulation[]> {
  authorize(auth, "start_and_cancel_runs", here(auth));

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
        within(
          auth,
          simulation,
          and(
            inArray(simulation.status, ["claimed", "running"]),
            lt(simulation.heartbeatAt, silentSince),
            simulationInActingProject(auth),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    // Each affected run at most once, in one order, as everywhere else.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const orphanedRunId of runIds) {
      await finalizeRunIfDone(tx, orphanedRunId, now);
    }

    return rows;
  });

  return swept.map((row) => row as Simulation);
}
