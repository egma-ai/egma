import {
  cancelRun,
  connectionTypeOf,
  connectionTypeUsesPlatformCarrier,
  foldSimulation,
  getAgent,
  getConnection,
  IdempotencyConflictError,
  listRunEvents,
  listRunHistory,
  listSimulations,
  NotPermittedError,
  platformFacts,
  productLabelOf,
  ProjectOutsideOrganizationError,
  readRunFold,
  readVerdicts,
  runAlreadyStartedFor,
  RUN_STATUSES,
  RunWriteRefusedError,
  startRun,
  VERDICTS,
  type AuthContext,
  type ConductedSimulation,
  type ExpectedTestVersion,
  type NewRun,
  type Run,
  type RunEvent,
  type RunHistoryEntry,
  type RunHistoryRequest,
  type RunStatus,
  type Verdict,
} from "@egma/db";
import { isId } from "@egma/ids";
import { runOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
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
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { phoneReadiness, phoneSetupRequiredMessage } from "../phone-readiness.ts";

export type RunRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  readonly baseUrl: string;
};

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;
const LARGEST_PAGE = 200;

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
    if (typeof valueEntry !== "object" || valueEntry === null || Array.isArray(valueEntry)) {
      return "each expectedTestVersions entry must be a test/version pair";
    }
    const entry = valueEntry as Body;
    const unexpected = unknownKey(entry, ["testId", "versionId"], "an expected test version");
    if (unexpected !== undefined) return unexpected;
    if (!isId("tst", text(entry.testId)) || !isId("tstv", text(entry.versionId))) {
      return "each expectedTestVersions entry must contain one testId and versionId";
    }
    entries.push({ testId: text(entry.testId), versionId: text(entry.versionId) });
  }
  return entries;
}

function page(query: Query): { limit?: number; cursor?: string } | string {
  const cursor = given(text(query.pageToken));
  if (cursor !== undefined && !isId("run", cursor) && !isId("sim", cursor)) {
    return `"${cursor}" is not a valid pageToken`;
  }
  const said = query.pageSize === undefined
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

function describedHeader(
  entry: RunHistoryEntry,
  baseUrl: string,
): Record<string, unknown> {
  const { run, fold } = entry;
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
    expectedSimulationCount: run.expectedSimulationCount,
    completedCount: run.completedCount,
    failedCount: run.failedCount,
    canceledCount: run.canceledCount,
    simulationCounts: fold.simulations,
    finishedCount: fold.finished,
    gradableCount: fold.gradable,
    gradedCount: fold.graded,
    verdict: fold.verdict,
    score: fold.score ?? null,
    verdictCounts: fold.counts,
    resultsUrl: resultsUrl(baseUrl, run),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

async function headerOf(
  auth: AuthContext,
  runId: string,
  baseUrl: string,
): Promise<Record<string, unknown> | undefined> {
  const found = await readRunFold(auth, runId);
  return found === undefined ? undefined : describedHeader(found, baseUrl);
}

function describedSimulation(
  one: ConductedSimulation,
  fold: ReturnType<typeof foldSimulation>,
): Record<string, unknown> {
  return {
    id: one.id,
    position: one.position,
    testId: one.testId,
    testName: one.testName,
    testVersionId: one.testVersionId,
    personaId: one.personaId,
    personaName: one.personaName,
    personaVersionId: one.personaVersionId,
    status: one.status,
    grading: fold.grading,
    verdict: fold.verdict,
    score: fold.score ?? null,
    counts: fold.counts,
    reason: one.endingReason,
    modality: one.modality,
    hasRecording: one.recordingReference !== null,
    mockToolCoverage: one.mockToolCoverage === null
      ? null
      : {
          discovered: [...one.mockToolCoverage.discovered],
          covered: [...one.mockToolCoverage.covered],
          uncovered: [...one.mockToolCoverage.uncovered],
        },
  };
}

function describedEvent(event: RunEvent): Record<string, unknown> {
  return event.kind === "run"
    ? { seq: event.seq, at: event.at.toISOString(), kind: "run", status: event.status }
    : {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "simulation",
        simulationId: event.simulationId,
        testName: event.testName,
        personaName: event.personaName,
        status: event.status,
        verdict: event.verdict,
        reason: event.reason,
      };
}

function noSuchRun(reply: FastifyReply, runId: string) {
  return notFound(reply, REFUSALS.notFound("run", runId));
}

function narrowing(query: Query): RunHistoryRequest | string {
  const result: {
    suiteId?: string;
    agentId?: string;
    connectionId?: string;
    testId?: string;
    status?: RunStatus;
    verdict?: Verdict;
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
  const verdict = given(text(query.verdict));
  if (verdict !== undefined) {
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      return `unknown verdict "${verdict}"`;
    }
    result.verdict = verdict as Verdict;
  }
  for (const field of ["since", "until"] as const) {
    const value = given(text(query[field]));
    if (value === undefined) continue;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return `${field} must be an RFC 3339 timestamp`;
    result[field] = at;
  }
  return result;
}

export async function runRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(app, runOperations.createRun, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Query;
    const unexpectedQuery = unknownKey(query, ["projectId"], "the run query");
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(
      body,
      ["suiteId", "agentId", "connectionId", "idempotencyKey", "name", "expectedTestVersions"],
      "a run",
    );
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const suiteId = text(body.suiteId);
    const agentId = text(body.agentId);
    const connectionId = text(body.connectionId);
    if (!isId("ste", suiteId)) {
      return unprocessable(reply, "suiteId must be one ste_ test suite identifier");
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

    const runInput: NewRun = {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey,
      ...(given(text(body.name)) === undefined ? {} : { name: text(body.name) }),
      ...(expected === undefined ? {} : { expectedTestVersions: expected }),
    };
    const replayed = await runAlreadyStartedFor(acting.auth, runInput);
    if (replayed !== undefined) {
      const described = await headerOf(acting.auth, replayed.id, options.baseUrl);
      if (described === undefined) throw new Error(`run ${replayed.id} vanished during replay`);
      return reply.code(201).send(described);
    }

    const carrier = phoneReadiness(await platformFacts());
    if (carrier.state !== "ready") {
      const kind = await connectionTypeOf(acting.auth, connectionId);
      if (kind !== undefined && connectionTypeUsesPlatformCarrier(kind)) {
        return phoneSetupRequired(reply, phoneSetupRequiredMessage(carrier));
      }
    }

    const started = await startRun(acting.auth, runInput);
    const described = await headerOf(acting.auth, started.id, options.baseUrl);
    if (described === undefined) throw new Error(`run ${started.id} vanished after start`);
    return reply.code(201).send(described);
  });

  registerPlatformOperation(app, runOperations.listRuns, async (request, reply) => {
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(
      query,
      [
        "projectId", "pageToken", "pageSize", "suiteId", "agentId",
        "connectionId", "testId", "status", "verdict", "since", "until",
      ],
      "the run query",
    );
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const wanted = page(query);
    if (typeof wanted === "string") return invalid(reply, wanted);
    if (wanted.cursor !== undefined && !isId("run", wanted.cursor)) {
      return sendRefusal(reply, "invalid_cursor", REFUSALS.invalidCursor(wanted.cursor));
    }
    const filter = narrowing(query);
    if (typeof filter === "string") return invalid(reply, filter);
    const found = await listRunHistory(acting.auth, { ...wanted, ...filter });
    return reply.send({
      runs: found.items.map((entry) => describedHeader(entry, options.baseUrl)),
      nextPageToken: found.nextCursor ?? null,
    });
  });

  registerPlatformOperation(app, runOperations.getRun, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId"], "the run query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await reachingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const found = await readRunFold(acting.auth, runId);
    if (found === undefined) return noSuchRun(reply, runId);
    const [agent, connection] = await Promise.all([
      getAgent(acting.auth, found.run.agentId),
      getConnection(acting.auth, found.run.agentId, found.run.connectionId),
    ]);
    return reply.send({
      ...describedHeader(found, options.baseUrl),
      counts: found.fold.counts,
      connectionSnapshot: {
        agentPlatform: found.run.connectionSnapshot.agentPlatform,
        connectionType: found.run.connectionSnapshot.connectionType,
        accessVariant: found.run.connectionSnapshot.accessVariant,
        modality: found.run.connectionSnapshot.modality,
        topology: found.run.connectionSnapshot.topology,
        environment: found.run.connectionSnapshot.environment,
        config: found.run.connectionSnapshot.config,
      },
      agent: agent === undefined ? null : {
        id: agent.id,
        name: agent.name,
        archived: agent.archivedAt !== null,
      },
      connection: connection === undefined ? null : {
        id: connection.id,
        name: connection.name,
        productLabel: connection.productLabel,
        archived: connection.archivedAt !== null,
      },
    });
  });

  registerPlatformOperation(app, runOperations.listRunSimulations, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId", "pageToken", "pageSize"], "the run query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await reachingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const wanted = page(query);
    if (typeof wanted === "string") return invalid(reply, wanted);
    if (wanted.cursor !== undefined && !isId("sim", wanted.cursor)) {
      return sendRefusal(reply, "invalid_cursor", REFUSALS.invalidCursor(wanted.cursor));
    }
    const found = await listSimulations(acting.auth, runId, wanted);
    if (found === undefined) return noSuchRun(reply, runId);
    const described = await Promise.all(found.items.map(async (one) => {
      const judged = await readVerdicts(acting.auth, one.id).catch(() => undefined);
      const outcome = judged === undefined || judged.verdicts.length === 0
        ? undefined
        : judged.outcome;
      return describedSimulation(one, foldSimulation(one.status, outcome));
    }));
    return reply.send({ simulations: described, nextPageToken: found.nextCursor ?? null });
  });

  registerPlatformOperation(app, runOperations.listRunEvents, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId", "after"], "the run query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await reachingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const said = query.after === undefined
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
    return reply.send({
      events: found.events.map(describedEvent),
      next: found.next,
      done: found.done,
    });
  });

  registerPlatformOperation(app, runOperations.cancelRun, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId"], "the run query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await reachingIn(requesterOf(request).auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const canceled = await cancelRun(acting.auth, runId);
    if (canceled === undefined) return noSuchRun(reply, runId);
    const described = await headerOf(acting.auth, runId, options.baseUrl);
    return described === undefined ? noSuchRun(reply, runId) : reply.send(described);
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof RunWriteRefusedError) {
      if (error.reason === "no_adapter") return noAdapter(reply, error.message);
      if (error.reason === "already_finished") return conflict(reply, error.message);
      return unprocessable(reply, error.message);
    }
    if (error instanceof IdempotencyConflictError) {
      return sendRefusal(reply, "idempotency_conflict", error.message);
    }
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }
    if (error instanceof NotPermittedError) return notPermitted(reply, error.message);
    throw error;
  });
}
