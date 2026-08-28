import {
  cancelRun,
  conductedWorldRow,
  connectionTypeOf,
  connectionTypeReadsPlatformAtRunStart,
  connectionTypeUsesPlatformCarrier,
  getAgent,
  getConnection,
  getRun,
  IdempotencyConflictError,
  listRunEvents,
  listRuns,
  listSimulations,
  mockedWorldRow,
  mockToolCoverageRow,
  NotPermittedError,
  productLabelOf,
  ProjectOutsideOrganizationError,
  readRunGradingProgress,
  readSimulationGradingStates,
  resolveRunStartReach,
  runAlreadyStartedFor,
  RUN_STATUSES,
  RunWriteRefusedError,
  simulationStatusCountsOfRuns,
  startRun,
  type AuthContext,
  type ConductedSimulation,
  type ConductedWorld,
  type RunStartReach,
  type ExpectedTestVersion,
  type NewRun,
  type Run,
  type RunEvent,
  type RunFilter,
  type RunStatus,
  type SimulationStatus,
  type TraceGradingState,
} from "@egma/db";
import { isId } from "@egma/ids";
import { runOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { CarrierRoute } from "../config.ts";
import { actingIn, cannotActIn, reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  conflict,
  invalid,
  noAdapter,
  notFound,
  notPermitted,
  phoneSetupRequired,
  REFUSALS,
  sendRefusal,
  unprocessable,
} from "../http/refusals.ts";
import { phoneReadiness, phoneSetupRequiredMessage } from "../phone-readiness.ts";
import {
  readPlaygroundWorld,
  type PlatformWorldRead,
} from "../providers/retell-playground.ts";

/**
 * How one connection type reads the agent's platform before its run starts.
 *
 * The registry says *which* kinds read; this says *how* each of them does it,
 * and the two are held level by the check below rather than by anybody
 * remembering. A kind added to the registry's list with no reader here fails
 * the run out loud naming itself, which is the same discipline the connection
 * registry keeps about adapters: nothing may claim what no code can do.
 */
type RunStartReader = (
  reach: RunStartReach,
  fetchImpl: typeof fetch | undefined,
) => Promise<PlatformWorldRead>;

const RUN_START_READERS: Readonly<Record<string, RunStartReader>> = {
  retell_playground: (reach, fetchImpl) =>
    readPlaygroundWorld(
      {
        apiKey: reach.apiKey,
        agentId: reach.config["retellAgentId"] ?? "",
        ...(reach.config["baseUrl"] === undefined
          ? {}
          : { baseUrl: reach.config["baseUrl"] }),
      },
      fetchImpl,
    ),
};

export type RunRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  readonly baseUrl: string;
  readonly carrierRoute: CarrierRoute | undefined;
  /** Test seam for the run-start read on the lanes that pin a version. */
  readonly retellFetch?: typeof fetch | undefined;
};

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;
type StatusCounts = Readonly<Partial<Record<SimulationStatus, number>>>;
type RunGradingProgress = {
  readonly gradable: number;
  readonly graded: number;
};

const LARGEST_PAGE = 200;
const GRADING_PROGRESS_BATCH = 100;

function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
  noun: string,
): string | undefined {
  const key = Object.keys(value).find((one) => !allowed.includes(one));
  return key === undefined ? undefined : `${noun} has no key "${key}"`;
}
function expectedVersions(
  value: unknown,
): readonly ExpectedTestVersion[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "expectedTestVersions must be a list";
  const entries: ExpectedTestVersion[] = [];
  for (const valueEntry of value) {
    if (
      typeof valueEntry !== "object" ||
      valueEntry === null ||
      Array.isArray(valueEntry)
    ) {
      return "each expectedTestVersions entry must be a test/version pair";
    }
    const entry = valueEntry as Body;
    const unexpected = unknownKey(
      entry,
      ["testId", "versionId"],
      "an expected test version",
    );
    if (unexpected !== undefined) return unexpected;
    if (!isId("tst", text(entry.testId)) || !isId("tstv", text(entry.versionId))) {
      return "each expectedTestVersions entry must contain one testId and versionId";
    }
    entries.push({
      testId: text(entry.testId),
      versionId: text(entry.versionId),
    });
  }
  return entries;
}

function page(query: Query): { limit?: number; cursor?: string } | string {
  const cursor = given(text(query.pageToken));
  if (cursor !== undefined && !isId("run", cursor) && !isId("sim", cursor)) {
    return `"${cursor}" is not a valid pageToken`;
  }
  const said =
    query.pageSize === undefined
      ? undefined
      : typeof query.pageSize === "number"
        ? String(query.pageSize)
        : given(text(query.pageSize));
  if (said === undefined) return cursor === undefined ? {} : { cursor };
  if (!/^\d+$/u.test(said)) return "pageSize must be a whole number";
  const limit = Number(said);
  if (limit < 1 || limit > LARGEST_PAGE) {
    return `pageSize must be between 1 and ${LARGEST_PAGE}`;
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function resultsUrl(baseUrl: string, run: Run): string {
  return `${baseUrl.replace(/\/$/u, "")}/projects/${run.projectId}/runs/${run.id}`;
}

function completeStatusCounts(counts?: StatusCounts): Record<SimulationStatus, number> {
  return {
    queued: counts?.queued ?? 0,
    claimed: counts?.claimed ?? 0,
    running: counts?.running ?? 0,
    completed: counts?.completed ?? 0,
    failed: counts?.failed ?? 0,
    canceled: counts?.canceled ?? 0,
  };
}

/**
 * One run's header.
 *
 * `whole` is the single-run read and is the only caller that gets the temporary
 * platform world. That world carries every touched number's inbound routing
 * verbatim — a page of two hundred runs would repeat all of it two hundred
 * times, for a reader who asked for a list of runs and not for anybody's
 * telephone routing. It is a fact about one run, so it is answered when one run
 * is asked for.
 */
function describedHeader(
  run: Run,
  counts: StatusCounts | undefined,
  grading: RunGradingProgress | undefined,
  baseUrl: string,
  whole: boolean,
): Record<string, unknown> {
  const simulations = completeStatusCounts(counts);
  return {
    id: run.id,
    projectId: run.projectId,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    suiteDeleted: run.suiteDeleted,
    name: run.name,
    status: run.status,
    agentId: run.agentId,
    connectionId: run.connectionId,
    agentPlatform: run.connectionSnapshot.agentPlatform,
    connectionType: run.connectionSnapshot.connectionType,
    accessVariant: run.connectionSnapshot.accessVariant,
    modality: run.connectionSnapshot.modality,
    productLabel: productLabelOf(
      run.connectionSnapshot.agentPlatform,
      run.connectionSnapshot.connectionType,
      run.connectionSnapshot.accessVariant,
      run.connectionSnapshot.modality,
    ),
    environment: run.connectionSnapshot.environment,
    // The one number off the conducted world, which is cheap enough for a
    // list: a reader scanning a page of runs can see which version each of
    // them tested. The lists beside it are not, and are answered below.
    conductedAgentVersion: run.conductedWorld?.agentVersion ?? null,
    // The temporary world, whole: the version branched from, the version
    // minted, the engine it runs on, and each touched number's routing exactly
    // as it was read. A reader sees what Egma promised to put back. Absent from
    // a list, on purpose — see the note above.
    ...(whole
      ? {
          mockedWorld:
            run.mockedWorld === null ? null : mockedWorldRow(run.mockedWorld),
          // The world this run read rather than built: the version, the engine
          // it runs on, and the three classes of that version's tools. On the
          // detail read for the same reason the mocked world is — the coverage
          // lists are per-run detail, not something to repeat two hundred times
          // down a page.
          conductedWorld:
            run.conductedWorld === null
              ? null
              : conductedWorldRow(run.conductedWorld),
        }
      : {}),
    expectedSimulationCount: run.expectedSimulationCount,
    completedCount: run.completedCount,
    failedCount: run.failedCount,
    canceledCount: run.canceledCount,
    simulationCounts: simulations,
    finishedCount:
      simulations.completed + simulations.failed + simulations.canceled,
    gradableCount: grading?.gradable ?? simulations.completed,
    gradedCount: grading?.graded ?? 0,
    resultsUrl: resultsUrl(baseUrl, run),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

async function headersOf(
  auth: AuthContext,
  runs: readonly Run[],
  baseUrl: string,
  whole = false,
): Promise<readonly Record<string, unknown>[]> {
  const ids = runs.map((run) => run.id);
  const progressBatches: string[][] = [];
  for (let at = 0; at < ids.length; at += GRADING_PROGRESS_BATCH) {
    progressBatches.push(ids.slice(at, at + GRADING_PROGRESS_BATCH));
  }
  const [statusCounts, progressRows] = await Promise.all([
    simulationStatusCountsOfRuns(auth, ids),
    Promise.all(
      progressBatches.map((batch) => readRunGradingProgress(auth, batch)),
    ).then((batches) => batches.flat()),
  ]);
  const gradingProgress = new Map(
    progressRows.map((progress) => [progress.runId, progress] as const),
  );
  return runs.map((run) =>
    describedHeader(
      run,
      statusCounts.get(run.id),
      gradingProgress.get(run.id),
      baseUrl,
      whole,
    ),
  );
}

async function headerOf(
  auth: AuthContext,
  runId: string,
  baseUrl: string,
): Promise<Record<string, unknown> | undefined> {
  const run = await getRun(auth, runId);
  if (run === undefined) return undefined;
  return (await headersOf(auth, [run], baseUrl))[0];
}

function describedSimulation(
  simulation: ConductedSimulation,
  gradingState: TraceGradingState | null,
  combinedScore: number | null,
): Record<string, unknown> {
  return {
    id: simulation.id,
    position: simulation.position,
    testId: simulation.testId,
    testName: simulation.testName,
    testVersionId: simulation.testVersionId,
    personaId: simulation.personaId,
    personaName: simulation.personaName,
    personaVersionId: simulation.personaVersionId,
    status: simulation.status,
    gradingState,
    combinedScore,
    reason: simulation.endingReason,
    startedAt: simulation.startedAt?.toISOString() ?? null,
    endedAt: simulation.endedAt?.toISOString() ?? null,
    modality: simulation.modality,
    hasRecording: simulation.recordingReference !== null,
    mockToolCoverage:
      simulation.mockToolCoverage === null
        ? null
        : mockToolCoverageRow(simulation.mockToolCoverage),
    // Evidence pins at the evidence grain: this row says what it conducted,
    // without a reader having to fetch the run to find out.
    conductedAgentVersion: simulation.conductedAgentVersion,
  };
}

function describedEvent(event: RunEvent): Record<string, unknown> {
  return event.kind === "run"
    ? {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "run",
        status: event.status,
      }
    : {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "simulation",
        simulationId: event.simulationId,
        testName: event.testName,
        personaName: event.personaName,
        status: event.status,
        reason: event.reason,
      };
}

function noSuchRun(reply: FastifyReply, runId: string) {
  return notFound(reply, REFUSALS.notFound("run", runId));
}

function narrowing(query: Query): RunFilter | string {
  const result: {
    suiteId?: string;
    agentId?: string;
    connectionId?: string;
    testId?: string;
    status?: RunStatus;
    since?: Date;
    until?: Date;
  } = {};
  const ids = [
    ["suiteId", "ste", "suiteId"],
    ["agentId", "agt", "agentId"],
    ["connectionId", "con", "connectionId"],
    ["testId", "tst", "testId"],
  ] as const;
  for (const [wire, prefix, field] of ids) {
    const value = given(text(query[wire]));
    if (value === undefined) continue;
    if (!isId(prefix, value)) return `${wire} must be one ${prefix}_ identifier`;
    result[field] = value;
  }
  const status = given(text(query.status));
  if (status !== undefined) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      return `unknown run status "${status}"`;
    }
    result.status = status as RunStatus;
  }
  for (const field of ["since", "until"] as const) {
    const value = given(text(query[field]));
    if (value === undefined) continue;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
      return `${field} must be an RFC 3339 timestamp`;
    }
    result[field] = at;
  }
  return result;
}

export async function runRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(
    app,
    runOperations.createRun,
    async (request, reply) => {
      const body = (request.body ?? {}) as Body;
      const query = (request.query ?? {}) as Query;
      const unexpectedQuery = unknownKey(query, ["projectId"], "the run query");
      if (unexpectedQuery !== undefined) {
        return unprocessable(reply, unexpectedQuery);
      }
      const unexpected = unknownKey(
        body,
        [
          "suiteId",
          "agentId",
          "connectionId",
          "idempotencyKey",
          "name",
          "expectedTestVersions",
        ],
        "a run",
      );
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await actingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);

      const suiteId = text(body.suiteId);
      const agentId = text(body.agentId);
      const connectionId = text(body.connectionId);
      if (!isId("ste", suiteId)) {
        return unprocessable(
          reply,
          "suiteId must be one ste_ test suite identifier",
        );
      }
      if (!isId("agt", agentId)) {
        return unprocessable(reply, "agentId must be one agt_ identifier");
      }
      if (!isId("con", connectionId)) {
        return unprocessable(reply, "connectionId must be one con_ identifier");
      }
      const idempotencyKey = given(text(body.idempotencyKey));
      if (idempotencyKey === undefined) {
        return unprocessable(reply, REFUSALS.idempotencyKeyRequired);
      }
      if ("name" in body && typeof body.name !== "string") {
        return unprocessable(reply, "name must be text");
      }
      const expected = expectedVersions(body.expectedTestVersions);
      if (typeof expected === "string") return unprocessable(reply, expected);

      const input: NewRun = {
        suiteId,
        agentId,
        connectionId,
        idempotencyKey,
        ...(given(text(body.name)) === undefined
          ? {}
          : { name: text(body.name) }),
        ...(expected === undefined
          ? {}
          : { expectedTestVersions: expected }),
      };
      const replayed = await runAlreadyStartedFor(acting.auth, input);
      if (replayed !== undefined) {
        const described = await headerOf(
          acting.auth,
          replayed.id,
          options.baseUrl,
        );
        if (described === undefined) {
          throw new Error(`run ${replayed.id} vanished during replay`);
        }
        return reply.code(201).send(described);
      }

      const carrier = phoneReadiness(options.carrierRoute);
      if (carrier.state !== "ready") {
        const kind = await connectionTypeOf(acting.auth, connectionId);
        if (kind !== undefined && connectionTypeUsesPlatformCarrier(kind)) {
          return phoneSetupRequired(
            reply,
            phoneSetupRequiredMessage(carrier),
          );
        }
      }

      // The run-start read, on the lanes that pin a version and on no other.
      //
      // **Before the run row exists, and loudly.** A resolve or a tool read
      // that failed after the row was written would leave a queued run nobody
      // can conduct honestly; refused here, nothing was started and the
      // sentence says so. And a run admitted without this read would conduct
      // against a world Egma never looked at, whose coverage stamp would be a
      // claim about tools nobody saw.
      const kind = await connectionTypeOf(acting.auth, connectionId);
      let conducted: ConductedWorld | undefined;
      let conductedIdentity: string | undefined;
      if (kind !== undefined && connectionTypeReadsPlatformAtRunStart(kind)) {
        const reach = await resolveRunStartReach(
          acting.auth,
          agentId,
          connectionId,
        );
        if (reach === undefined) {
          return unprocessable(
            reply,
            `there is no active connection ${connectionId} on agent ` +
              `${agentId} that Egma can read the agent's platform with`,
          );
        }
        // Dispatched on the kind the row actually holds, so the registry's
        // list and the readers above cannot drift apart in silence.
        const reader = RUN_START_READERS[reach.connectionType];
        if (reader === undefined) {
          throw new Error(
            `a run over a ${reach.connectionType} connection is declared to ` +
              `read its agent's platform at run start, and nothing here knows ` +
              `how to read it`,
          );
        }
        const read = await reader(reach, options.retellFetch);
        if (read.kind === "refused") {
          return unprocessable(reply, read.message);
        }
        if (read.kind !== "world") {
          return sendRefusal(reply, "provider_unavailable", read.message);
        }
        conducted = read.world;
        // The fingerprint of the connection the world was read from, carried
        // into the write so it can refuse if the connection moved in between.
        conductedIdentity = reach.connectionIdentity;
      }

      const started = await startRun(acting.auth, {
        ...input,
        ...(conducted === undefined
          ? {}
          : {
              conductedWorld: conducted,
              conductedConnectionIdentity: conductedIdentity,
            }),
      });
      const described = await headerOf(
        acting.auth,
        started.id,
        options.baseUrl,
      );
      if (described === undefined) {
        throw new Error(`run ${started.id} vanished after start`);
      }
      return reply.code(201).send(described);
    },
  );

  registerPlatformOperation(
    app,
    runOperations.listRuns,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const unexpected = unknownKey(
        query,
        [
          "projectId",
          "pageToken",
          "pageSize",
          "suiteId",
          "agentId",
          "connectionId",
          "testId",
          "status",
          "since",
          "until",
        ],
        "the run query",
      );
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await actingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const wanted = page(query);
      if (typeof wanted === "string") return invalid(reply, wanted);
      if (wanted.cursor !== undefined && !isId("run", wanted.cursor)) {
        return sendRefusal(
          reply,
          "invalid_cursor",
          REFUSALS.invalidCursor(wanted.cursor),
        );
      }
      const filter = narrowing(query);
      if (typeof filter === "string") return invalid(reply, filter);
      const found = await listRuns(acting.auth, wanted, filter);
      return reply.send({
        runs: await headersOf(acting.auth, found.items, options.baseUrl),
        nextPageToken: found.nextCursor ?? null,
      });
    },
  );

  registerPlatformOperation(
    app,
    runOperations.getRun,
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = (request.query ?? {}) as Query;
      const unexpected = unknownKey(query, ["projectId"], "the run query");
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await reachingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const run = await getRun(acting.auth, runId);
      if (run === undefined) return noSuchRun(reply, runId);
      const [header, agent, connection] = await Promise.all([
        // The one read that asked for this run in particular, and the only one
        // answered with the temporary platform world.
        headersOf(acting.auth, [run], options.baseUrl, true).then(
          (items) => items[0],
        ),
        getAgent(acting.auth, run.agentId),
        getConnection(acting.auth, run.agentId, run.connectionId),
      ]);
      return reply.send({
        ...header,
        connectionSnapshot: {
          agentPlatform: run.connectionSnapshot.agentPlatform,
          connectionType: run.connectionSnapshot.connectionType,
          accessVariant: run.connectionSnapshot.accessVariant,
          modality: run.connectionSnapshot.modality,
          topology: run.connectionSnapshot.topology,
          environment: run.connectionSnapshot.environment,
          config: run.connectionSnapshot.config,
        },
        agent:
          agent === undefined
            ? null
            : {
                id: agent.id,
                name: agent.name,
                archived: agent.archivedAt !== null,
              },
        connection:
          connection === undefined
            ? null
            : {
                id: connection.id,
                name: connection.name,
                productLabel: connection.productLabel,
                archived: connection.archivedAt !== null,
              },
      });
    },
  );

  registerPlatformOperation(
    app,
    runOperations.listRunSimulations,
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = (request.query ?? {}) as Query;
      const unexpected = unknownKey(
        query,
        ["projectId", "pageToken", "pageSize"],
        "the run query",
      );
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await reachingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const wanted = page(query);
      if (typeof wanted === "string") return invalid(reply, wanted);
      if (wanted.cursor !== undefined && !isId("sim", wanted.cursor)) {
        return sendRefusal(
          reply,
          "invalid_cursor",
          REFUSALS.invalidCursor(wanted.cursor),
        );
      }
      const found = await listSimulations(acting.auth, runId, wanted);
      if (found === undefined) return noSuchRun(reply, runId);
      const stateRows = await readSimulationGradingStates(
        acting.auth,
        found.items.map((simulation) => ({
          simulationId: simulation.id,
          runId: simulation.runId,
        })),
      );
      const states = new Map(
        stateRows.map((state) => [state.simulationId, state] as const),
      );
      return reply.send({
        simulations: found.items.map((simulation) => {
          const grading = states.get(simulation.id);
          return describedSimulation(
            simulation,
            grading?.state ?? null,
            grading?.combinedScore ?? null,
          );
        }),
        nextPageToken: found.nextCursor ?? null,
      });
    },
  );

  registerPlatformOperation(
    app,
    runOperations.listRunEvents,
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = (request.query ?? {}) as Query;
      const unexpected = unknownKey(
        query,
        ["projectId", "after"],
        "the run query",
      );
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await reachingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const said =
        query.after === undefined
          ? undefined
          : typeof query.after === "number"
            ? String(query.after)
            : given(text(query.after));
      if (said !== undefined && !/^\d+$/u.test(said)) {
        return invalid(reply, "after must be a sequence number from zero");
      }
      const found = await listRunEvents(acting.auth, runId, {
        ...(said === undefined ? {} : { after: Number(said) }),
      });
      if (found === undefined) return noSuchRun(reply, runId);
      const grading = (await readRunGradingProgress(acting.auth, [runId]))[0];
      const gradingDone =
        grading !== undefined &&
        grading.graded === grading.gradable;
      return reply.send({
        events: found.events.map(describedEvent),
        next: found.next,
        done: found.done && gradingDone,
      });
    },
  );

  registerPlatformOperation(
    app,
    runOperations.cancelRun,
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = (request.query ?? {}) as Query;
      const unexpected = unknownKey(query, ["projectId"], "the run query");
      if (unexpected !== undefined) return unprocessable(reply, unexpected);
      const acting = await reachingIn(
        requesterOf(request).auth,
        given(text(query.projectId)),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const canceled = await cancelRun(acting.auth, runId);
      if (canceled === undefined) return noSuchRun(reply, runId);
      const described = await headerOf(acting.auth, runId, options.baseUrl);
      return described === undefined
        ? noSuchRun(reply, runId)
        : reply.send(described);
    },
  );

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof RunWriteRefusedError) {
      if (error.reason === "no_adapter") return noAdapter(reply, error.message);
      if (error.reason === "already_finished") {
        return conflict(reply, error.message);
      }
      return unprocessable(reply, error.message);
    }
    if (error instanceof IdempotencyConflictError) {
      return sendRefusal(reply, "idempotency_conflict", error.message);
    }
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
