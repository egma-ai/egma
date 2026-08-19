import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { agent, connection } from "../schema/agents.ts";
import { persona } from "../schema/personas.ts";
import { test, testPersona, testVersion } from "../schema/tests.ts";
import type { Verdict } from "../verdicts/fold.ts";
import {
  foldRun,
  foldSimulation,
  type RunFold,
  type SimulationFold,
} from "../verdicts/read-fold.ts";
import type { AuthContext } from "./context.ts";
import {
  refuseRetry,
  SimulationRerunRefusedError,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { LARGEST_PAGE_SIZE, type PageRequest } from "./pages.ts";
import { testsApplyingToAgent } from "./tests.ts";
import {
  getRun,
  getSimulation,
  listRuns,
  runAlreadyStartedFor,
  runAlreadyStartedForSimulation,
  simulationStatusesOfRuns,
  startRun,
  startRunForSimulation,
  type NewRun,
  type Run,
  type RunFilter,
  type SingleSimulationSelection,
  type StartedRun,
} from "./runs.ts";
import { readVerdictsAcrossRuns } from "./verdicts.ts";
import { within } from "./within.ts";

/**
 * Reading a project's run history, and retrying one run under today's
 * conditions.
 *
 * It sits above `runs.ts` rather than inside it because both of its jobs need
 * two stores at once. A run's machinery lives in Postgres and its judgment lives
 * in the trace store, and the whole point of this effort is that those two are
 * never confused for each other — so the place they are read together is one
 * place, named after what it produces, and `verdicts/read-fold.ts` owns the
 * arithmetic that keeps them apart.
 *
 * **Retry lives here for the opposite reason: it must not become a second way to
 * start a run.** It is derived entirely from an earlier run — the agent, the
 * connection and the exact frozen test versions come off that row and from
 * nothing a caller sends — and then it calls `startRun` like everybody else. A
 * client cannot reach `retry_of_run_id` any other way, which is what makes the
 * link on a run trustworthy.
 */

/* ------------------------------------------------------------------- *
 * The history.
 * ------------------------------------------------------------------- */

/** One run of the history: the header, and its four facts already folded. */
export type RunHistoryEntry = {
  readonly run: Run;
  readonly fold: RunFold;
};

export type RunHistoryPage = {
  readonly items: readonly RunHistoryEntry[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export type RunHistoryRequest = PageRequest &
  RunFilter & {
    /**
     * Narrow to runs whose folded verdict is this one.
     *
     * **Applied after the fold, because a verdict is not a column.** It is
     * computed from rows in the trace store at the moment of asking, and there
     * is nothing stored anywhere for a `where` to name — which is the same
     * decision that stops a run header and the rows beneath it ever disagreeing.
     * A run still being judged has no verdict yet and matches nothing here.
     */
    readonly verdict?: Verdict | undefined;
  };

/**
 * How many windows of the underlying list one filtered page may sweep.
 *
 * A verdict filter cannot be pushed into the query, so a page of matches is
 * gathered by reading windows of runs and folding them. Unbounded, a filter that
 * matches nothing would walk a project's whole history on one request; bounded,
 * the worst case is a short page with a cursor on it, and asking again continues
 * from exactly where the sweep stopped. A short page is honest — `nextCursor` is
 * the promise that there is more to look at, not that there is more to show.
 */
const MOST_SWEEPS = 5;

/**
 * One page of this project's runs, newest first, each with its machinery and its
 * judgment folded and kept apart.
 *
 * The cursor is the run id, exactly as every other list here pages: the ids are
 * time-sortable, so ordering by id is ordering by when the run was started and
 * the last id of a page is the whole cursor.
 */
export async function listRunHistory(
  auth: AuthContext,
  request: RunHistoryRequest = {},
): Promise<RunHistoryPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor, verdict, ...filter } = request;
  const wanted = limit ?? 50;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > LARGEST_PAGE_SIZE) {
    throw new Error(`a page holds between 1 and ${LARGEST_PAGE_SIZE} runs`);
  }

  const kept: RunHistoryEntry[] = [];
  let after = cursor;
  let more = false;
  let exhausted = false;

  // One sweep where nothing is filtered out after the fact, and up to
  // `MOST_SWEEPS` where a verdict filter is doing the removing.
  const sweeps = verdict === undefined ? 1 : MOST_SWEEPS;

  for (let sweep = 0; sweep < sweeps && !exhausted && kept.length < wanted; sweep += 1) {
    const page = await listRuns(
      auth,
      { limit: wanted, ...(after === undefined ? {} : { cursor: after }) },
      filter,
    );

    if (page.items.length === 0) {
      exhausted = true;
      break;
    }

    const folded = await foldEachRun(auth, page.items);
    for (const entry of folded) {
      if (kept.length === wanted) {
        // Stopped part way through a window, so there is definitely more to
        // examine and `after` names where to carry on from.
        more = true;
        break;
      }
      if (verdict === undefined || entry.fold.verdict === verdict) {
        kept.push(entry);
      }
      after = entry.run.id;
    }

    if (kept.length === wanted && !more) {
      // The window ran out at exactly the same moment the page filled, so
      // whether there is more is what the underlying list already answered.
      more = page.nextCursor !== undefined;
    }
    if (page.nextCursor === undefined) exhausted = true;
  }

  return {
    items: kept,
    nextCursor: exhausted && !more ? undefined : more || !exhausted ? after : undefined,
  };
}

/**
 * The four facts of one run, read on its own.
 *
 * The same fold the list uses, so a row and the page it opens can never disagree
 * about what a run's verdict is.
 */
export async function readRunFold(
  auth: AuthContext,
  runId: string,
): Promise<RunHistoryEntry | undefined> {
  authorize(auth, "read", here(auth));

  const header = await getRun(auth, runId);
  if (header === undefined) return undefined;

  const [entry] = await foldEachRun(auth, [header]);
  return entry;
}

/**
 * A page of runs, folded — two reads for the whole page rather than two per row.
 *
 * The trace store is allowed to be unreachable while the run table reads
 * perfectly well, and a history that answered 500 because grading was down would
 * present a grading outage as a broken list. So an unreachable verdict store
 * degrades to "nothing judged yet", which is the same shape a genuinely ungraded
 * run has and which the next read corrects on its own.
 */
async function foldEachRun(
  auth: AuthContext,
  runs: readonly Run[],
): Promise<readonly RunHistoryEntry[]> {
  const runIds = runs.map((one) => one.id);
  const conversations = await simulationStatusesOfRuns(auth, runIds);
  const judged = await readVerdictsAcrossRuns(auth, runIds).catch(
    () => new Map<string, ReadonlyMap<string, never>>(),
  );

  return runs.map((one) => {
    const rows = conversations.get(one.id) ?? [];
    const outcomes = judged.get(one.id);
    const folds: SimulationFold[] = rows.map((row) =>
      foldSimulation(row.status, outcomes?.get(row.id)),
    );
    return {
      run: one,
      fold: foldRun(one.status, one.expectedSimulationCount, folds),
    };
  });
}

/* ------------------------------------------------------------------- *
 * Retry.
 * ------------------------------------------------------------------- */

export type RetryRequest = {
  /**
   * The caller's own word for this attempt, on the same terms every start has
   * one: a retry dials a real agent and spends a real judge, so an answer lost
   * on the way back must never become a second conversation.
   */
  readonly idempotencyKey: string;
};

export type SimulationRerunRequest = {
  /** A new run is a new record and needs its own readable name. */
  readonly label: string;
  /** Prevents a repeated request from conducting the simulation twice. */
  readonly idempotencyKey: string;
};

type PreparedSimulationRerun = {
  readonly start: NewRun;
  readonly selection: SingleSimulationSelection;
};

/**
 * The immutable source facts shared by recall and the first write.
 *
 * Keeping this derivation in one place matters: idempotency compares a digest
 * of this exact start and selection. If recall rebuilt either one differently,
 * the same request could miss its first run and conduct a second conversation.
 */
async function prepareSimulationRerun(
  auth: AuthContext,
  simulationId: string,
  request: SimulationRerunRequest,
): Promise<PreparedSimulationRerun | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const source = await getSimulation(auth, simulationId);
  if (source === undefined) return undefined;
  const earlier = await getRun(auth, source.runId);
  if (earlier === undefined) return undefined;
  if (
    source.status !== "completed" &&
    source.status !== "failed" &&
    source.status !== "canceled" &&
    source.status !== "skipped"
  ) {
    throw new SimulationRerunRefusedError(
      simulationId,
      "not_terminal",
      `This simulation is still ${source.status}, so it cannot run again yet. ` +
        `Wait for it to finish or cancel its run; the source simulation was ` +
        `not changed.`,
    );
  }
  if (source.testId === null || source.testVersionId === null) {
    throw new SimulationRerunRefusedError(
      simulationId,
      "legacy",
      `This simulation does not record the test version it ran, so Egma ` +
        `cannot build the same simulation again. Start a new run from the ` +
        `test; the source simulation was not changed.`,
    );
  }

  const label = request.label.trim();
  if (label === "") {
    throw new SimulationRerunRefusedError(
      simulationId,
      "name_required",
      `A new run needs a name. Enter a run name and try again; the source ` +
        `simulation was not changed.`,
    );
  }
  const idempotencyKey = request.idempotencyKey.trim();
  if (idempotencyKey === "") {
    throw new SimulationRerunRefusedError(
      simulationId,
      "idempotency_key_required",
      `Running this simulation again requires an idempotency key. Send one ` +
        `stable key for this action; the source simulation was not changed.`,
    );
  }

  return {
    start: {
      agentId: earlier.agentId,
      connectionId: earlier.connectionId,
      testVersionIds: [source.testVersionId],
      label,
      retryOfRunId: earlier.id,
      idempotencyKey,
    },
    selection: {
      sourceSimulationId: source.id,
      testVersionId: source.testVersionId,
      personaId: source.personaId,
    },
  };
}

/**
 * Return the run this exact simulation-rerun request already created.
 *
 * This read exists for a product door that has mutable safety checks before a
 * first write. A repeated key must answer the run that already passed those
 * checks, even if deployment readiness changed afterwards. When nothing is
 * remembered, this writes nothing and the caller must still perform every
 * readiness check before calling `rerunSimulation`.
 */
export async function simulationRerunAlreadyStarted(
  auth: AuthContext,
  simulationId: string,
  request: SimulationRerunRequest,
): Promise<StartedRun | undefined> {
  const prepared = await prepareSimulationRerun(auth, simulationId, request);
  if (prepared === undefined) return undefined;
  return runAlreadyStartedForSimulation(
    auth,
    prepared.start,
    prepared.selection,
  );
}

/**
 * Run one stored simulation again as one new run under today's conditions.
 *
 * The client names only the source simulation, a new label, and an idempotency
 * key. The agent, connection, exact test version, and persona identity all
 * come from the stored source. `startRunForSimulation` then resolves the
 * persona's current version, the connection's current configuration, today's
 * graders, and today's mock tools while keeping the new run to exactly this
 * one test-and-persona pair.
 */
export async function rerunSimulation(
  auth: AuthContext,
  simulationId: string,
  request: SimulationRerunRequest,
): Promise<StartedRun | undefined> {
  const prepared = await prepareSimulationRerun(auth, simulationId, request);
  if (prepared === undefined) return undefined;

  return startRunForSimulation(
    auth,
    prepared.start,
    prepared.selection,
  );
}

/**
 * A new run derived from an earlier one, under today's conditions.
 *
 * **Server-derived, and that is the whole of its safety.** The agent, the
 * connection and the exact frozen test versions are read off the earlier run;
 * nothing a caller sends can name any of them, and `retry_of_run_id` is
 * unreachable from the ordinary create body. So a run that says it retries
 * another one really does execute what that one executed.
 *
 * **It rechecks and never substitutes.** Every resource the earlier run used is
 * checked as it stands now — the agent and the connection are active, each test
 * is active and still applies to that agent, each pinned version still exists,
 * and every persona those versions name is active. One of those failing refuses
 * the whole Retry and says which; swapping in a live replacement would answer
 * "we ran it again" about a different run, and the two results would be
 * compared as though they were about the same thing.
 *
 * **It is honestly not a replay.** Persona versions, the project's running
 * copies, the judge setting, the connection's current configuration and
 * credential, and the project's mock tools are all resolved fresh by `startRun`
 * — because those are what a run under current conditions means. The earlier run
 * is never reopened and never changed. A copy switched off since is therefore
 * simply not in the new plan, which is what switching one off means.
 *
 * **The idempotency key is asked about before any of the rechecks.** The common
 * repeat is a client that never learned its first attempt succeeded, and by then
 * the retry it is asking about is already dialing a real agent — so anything it
 * used may have been archived in the meantime, with no race needed. A recheck in
 * front of the recall would answer "this cannot be retried" about a retry that
 * is running, which is the exact failure a key exists to prevent. So the recall
 * comes first, off the same input `startRun` is later handed, and the rechecks
 * run only when the key remembers nothing.
 */
export async function retryRun(
  auth: AuthContext,
  runId: string,
  request: RetryRequest,
): Promise<StartedRun | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const earlier = await getRun(auth, runId);
  if (earlier === undefined) return undefined;

  const on = db();
  const versionIds = earlier.pinnedTestVersionIds;

  // An upgraded instance's history holds runs that recorded no selection. There
  // is nothing to copy and nothing honest to invent, so the selection itself is
  // what is named.
  if (versionIds.length === 0) {
    refuseRetry(
      runId,
      "selection",
      "the test selection this run recorded",
      null,
    );
  }

  // Built before anything is asked, because the digest the recall matches on is
  // taken from this exact object: a recall computed from anything else would
  // miss, and the shield would be gone in a way nothing shows.
  const start: NewRun = {
    agentId: earlier.agentId,
    connectionId: earlier.connectionId,
    testVersionIds: [...versionIds],
    retryOfRunId: runId,
    idempotencyKey: request.idempotencyKey,
    ...(earlier.label === null ? {} : { label: earlier.label }),
  };

  // Ahead of every recheck below. The answer is a read, there is nothing to
  // write, and a refusal in front of it would be a sentence about a retry that
  // is already running. A key reused with a *different* body still refuses out
  // loud from in here, and that refusal is a conflict rather than a Retry the
  // conditions stopped — two different sentences leading two different ways.
  const remembered = await runAlreadyStartedFor(auth, start);
  if (remembered !== undefined) return remembered;

  await demandActiveAgent(on, auth, runId, earlier.agentId);
  await demandActiveConnection(on, auth, runId, earlier.connectionId);
  const versions = await demandLiveVersions(on, auth, runId, versionIds);
  await demandApplicableTests(on, auth, runId, earlier.agentId, versions);
  await demandActivePersonas(on, auth, runId, versionIds);

  return startRun(auth, start);
}

async function demandActiveAgent(
  on: Queryable,
  auth: AuthContext,
  runId: string,
  agentId: string,
): Promise<void> {
  const [row] = await on
    .select({ id: agent.id })
    .from(agent)
    .where(within(auth, agent, and(eq(agent.id, agentId), isNull(agent.archivedAt))))
    .limit(1);
  if (row === undefined) {
    refuseRetry(runId, "agent", `agent ${agentId}`, agentId);
  }
}

async function demandActiveConnection(
  on: Queryable,
  auth: AuthContext,
  runId: string,
  connectionId: string,
): Promise<void> {
  const [row] = await on
    .select({ id: connection.id })
    .from(connection)
    .where(
      within(
        auth,
        connection,
        and(eq(connection.id, connectionId), isNull(connection.archivedAt)),
      ),
    )
    .limit(1);
  if (row === undefined) {
    refuseRetry(runId, "connection", `connection ${connectionId}`, connectionId);
  }
}

/** One pinned version and the test it belongs to, as the rechecks need them. */
type LiveVersion = {
  readonly versionId: string;
  readonly testId: string;
  readonly archived: boolean;
};

async function demandLiveVersions(
  on: Queryable,
  auth: AuthContext,
  runId: string,
  versionIds: readonly string[],
): Promise<readonly LiveVersion[]> {
  const rows = await on
    .select({
      versionId: testVersion.id,
      testId: test.id,
      archivedAt: test.archivedAt,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(within(auth, test, inArray(testVersion.id, [...versionIds])));

  const found = new Map(rows.map((row) => [row.versionId, row] as const));

  return versionIds.map((versionId) => {
    const row = found.get(versionId);
    // A version the run pinned that this caller can no longer resolve: the test
    // was hard-deleted, or the run belongs to a project this credential has
    // stopped reaching. Either way there is nothing to execute.
    if (row === undefined) {
      refuseRetry(
        runId,
        "test_version",
        `test version ${versionId}`,
        versionId,
      );
    }
    if (row.archivedAt !== null) {
      refuseRetry(runId, "test", `test ${row.testId}`, row.testId);
    }
    return { versionId, testId: row.testId, archived: false };
  });
}

async function demandApplicableTests(
  on: Queryable,
  auth: AuthContext,
  runId: string,
  agentId: string,
  versions: readonly LiveVersion[],
): Promise<void> {
  const testIds = [...new Set(versions.map((one) => one.testId))];
  const applying = await testsApplyingToAgent(on, agentId, testIds);
  for (const one of versions) {
    if (applying.has(one.testId)) continue;
    // The test and the agent are both perfectly alive; somebody unlinked them.
    // Named as the test, because that is the page where the link is repaired.
    refuseRetry(runId, "applicability", `test ${one.testId}`, one.testId);
  }
}

async function demandActivePersonas(
  on: Queryable,
  auth: AuthContext,
  runId: string,
  versionIds: readonly string[],
): Promise<void> {
  const named = await on
    .select({ personaId: testPersona.personaId })
    .from(testPersona)
    .where(inArray(testPersona.testVersionId, [...versionIds]));

  const personaIds = [...new Set(named.map((one) => one.personaId))];
  if (personaIds.length === 0) return;

  const alive = new Set(
    (
      await on
        .select({ id: persona.id })
        .from(persona)
        .where(
          within(
            auth,
            persona,
            and(inArray(persona.id, personaIds), isNull(persona.archivedAt)),
          ),
        )
    ).map((row) => row.id),
  );

  for (const personaId of personaIds) {
    if (alive.has(personaId)) continue;
    refuseRetry(runId, "persona", `persona ${personaId}`, personaId);
  }
}

/*
 * **There is no `demandActiveGraders`, and there was.** It refused a Retry
 * while a grader a pinned version named *directly* had been deleted since. A
 * test names no graders now — what judges a run is the project's live copies —
 * so a copy switched off between two runs is a decision about the project and
 * not something a Retry may overrule. `RetryBlocker` keeps its `grader` word:
 * no path raises it today, and the word is what a stored refusal from before
 * this change still reads as.
 */
