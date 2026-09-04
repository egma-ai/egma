import {
  getAgent,
  getConnection,
  getGradingPlan,
  getPersona,
  getPersonaVersion,
  getRun,
  getSimulation,
  getSimulationExecutionEvidence,
  NotPermittedError,
  readTrace,
  readTraceGrading,
  regradeTrace,
  type GradingPlan,
  type Simulation,
  type TraceDetail,
  type TraceSpan,
} from "@egma/db";
import { simulationOperations } from "@egma/platform-api/contract";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { describedMetrics } from "../http/metrics.ts";
import { describedTraceGrading } from "../http/grades.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { notFound, notPermitted, unprocessable } from "../http/refusals.ts";

export type SimulationRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

function projectNamedByPlatform(
  query: Record<string, unknown>,
): string | undefined {
  return given(text(query.projectId));
}
const NO_SUCH_SIMULATION =
  "no simulation of yours has that id. Check the id, or open the run it " +
  "belongs to with GET /v1/runs/{runId}.";

const AROUND_THE_SIMULATION_MS = 60_000;

function windowOf(
  simulation: Simulation,
  runCreatedAt: Date,
): { readonly from: bigint; readonly to: bigint } {
  const opened = simulation.startedAt ?? simulation.createdAt ?? runCreatedAt;
  const closed = simulation.endedAt ?? new Date();
  const from = opened.getTime() - AROUND_THE_SIMULATION_MS;
  const to =
    Math.max(closed.getTime(), opened.getTime()) + AROUND_THE_SIMULATION_MS;
  return { from: BigInt(from) * 1000n, to: BigInt(to) * 1000n };
}

function describedSpan(span: TraceSpan): Record<string, unknown> {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: span.startedAt,
    durationNs: span.durationNanoseconds,
    text: span.text,
    audioUrl: span.audioUrl,
    toolName: span.toolName,
    toolArguments: span.toolArguments,
    toolResult: span.toolResult,
    spans: span.spans.map(describedSpan),
  };
}

function describedTranscript(
  detail: TraceDetail | undefined,
): Record<string, unknown> | null {
  if (detail === undefined) return null;
  return {
    traceId: detail.traceId,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    durationNs: detail.durationNanoseconds,
    spanCount: detail.spanCount,
    turnCounts: { human: detail.humanTurnCount, agent: detail.agentTurnCount },
    toolSpanCount: detail.toolSpanCount,
    erroredSpanCount: detail.erroredSpanCount,
    turns: detail.turns.map(describedSpan),
    spans: detail.spans.map(describedSpan),
    spansTruncated: detail.truncated,
  };
}

/** The exact grader selection frozen for this simulation's test. */
function describedPlanForSimulation(
  plan: GradingPlan | undefined,
  testId: string,
  testVersionId: string,
): Record<string, unknown> | null {
  if (plan === undefined) return null;
  const group = plan.groups.find(
    (candidate) =>
      candidate.testId === testId &&
      candidate.testVersionId === testVersionId,
  );
  if (group === undefined) {
    throw new Error(
      `grading plan for test version ${testVersionId} is not readable`,
    );
  }
  return {
    state: plan.state,
    capturedAt: plan.capturedAt.toISOString(),
    items: group.items.map((item) => ({
      projectGraderId: item.projectGraderId,
      graderDefinitionId: item.graderDefinitionId,
      graderDefinitionVersion: item.graderDefinitionVersion,
      graderName: item.graderName,
      passThreshold: item.passThreshold,
    })),
  };
}

function describedMeasures(
  simulation: Simulation,
  detail: TraceDetail | undefined,
): Record<string, unknown> {
  const measures: Record<string, unknown> = {};
  if (simulation.startedAt !== null && simulation.endedAt !== null) {
    measures.durationMs =
      simulation.endedAt.getTime() - simulation.startedAt.getTime();
  }
  if (simulation.turnCount !== null) measures.turnCount = simulation.turnCount;
  if (detail !== undefined) {
    measures.toolCallCount = detail.toolSpanCount;
    measures.erroredStepCount = detail.erroredSpanCount;
    measures.humanTurnCount = detail.humanTurnCount;
    measures.agentTurnCount = detail.agentTurnCount;
  }
  return measures;
}

export async function simulationRoutes(
  app: FastifyInstance,
  options: SimulationRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(
    app,
    simulationOperations.getSimulation,
    async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const { simulationId } = request.params as { simulationId: string };
      const acting = await reachingIn(
        requesterOf(request).auth,
        projectNamedByPlatform(query),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const who = acting.auth;

      const simulation = await getSimulation(who, simulationId);
      if (simulation === undefined) {
        return notFound(reply, NO_SUCH_SIMULATION);
      }
      // An organization-wide key can find this id across its projects. Once
      // the row is known, every related read must use the exact project the
      // row names; grades are project policy and deliberately refuse an
      // unscoped context.
      const simulationAuth =
        who.projectId === simulation.projectId
          ? who
          : { ...who, projectId: simulation.projectId };
      const run = await getRun(simulationAuth, simulation.runId);
      if (run === undefined) return notFound(reply, NO_SUCH_SIMULATION);

      const traceId = traceIdOfSimulation(simulation.id);
      const window = windowOf(simulation, run.createdAt);
      const [
        executionEvidence,
        persona,
        personaVersion,
        agent,
        connection,
        plan,
        transcript,
        grading,
      ] = await Promise.all([
        getSimulationExecutionEvidence(simulationAuth, simulation.id),
        getPersona(simulationAuth, simulation.personaId),
        getPersonaVersion(simulationAuth, simulation.personaVersionId),
        getAgent(simulationAuth, simulation.agentId),
        getConnection(
          simulationAuth,
          simulation.agentId,
          simulation.connectionId,
        ),
        getGradingPlan(simulationAuth, simulation.runId),
        traceId === undefined
          ? Promise.resolve(undefined)
          : readTrace(simulationAuth, traceId, { window }).catch(() => undefined),
        simulation.status !== "completed" || traceId === undefined
          ? Promise.resolve(undefined)
          : readTraceGrading(simulationAuth, {
              source: "simulation",
              traceId,
              runId: simulation.runId,
            }),
      ]);

      const testVersion = executionEvidence?.testVersion;

      return reply.send({
        id: simulation.id,
        projectId: simulation.projectId,
        runId: simulation.runId,
        runName: run.name,
        position: simulation.position,
        status: simulation.status,
        ...describedTraceGrading(grading),
        reason: simulation.endingReason,
        executionFailure: simulation.executionFailure,
        modality: simulation.modality,
        createdAt: simulation.createdAt.toISOString(),
        startedAt: simulation.startedAt?.toISOString() ?? null,
        endedAt: simulation.endedAt?.toISOString() ?? null,
        providerReference: simulation.providerReference,
        // What this one conversation was conducted against, off its own row.
        // A result is read here, so it answers here — never by fetching the
        // run to find out.
        hasRecording: simulation.recordingReference !== null,
        measures: describedMeasures(simulation, transcript),
        // The observed metrics, off the one shared projection the transcript
        // answers with — so the strip on a simulation's evidence and the strip
        // on a production transcript can never come to disagree about one
        // conversation. Empty when no trace was filed: nothing measured is an
        // ordinary answer, not a missing field.
        metrics: transcript === undefined ? [] : describedMetrics(transcript),
        test: {
          id: simulation.testId,
          versionId: simulation.testVersionId,
          name: testVersion?.testName ?? null,
          scenario: testVersion?.scenario ?? null,
          expectedBehaviors:
            testVersion === undefined
              ? null
              : [...testVersion.expectedBehaviors],
        },
        // The team's label reads live, so a rename shows here. The authored
        // person comes off the pinned version and never moves — which is how
        // an old result can still say exactly who the agent heard.
        persona: {
          id: simulation.personaId,
          name: persona?.name ?? null,
          versionId: simulation.personaVersionId,
          identityName: personaVersion?.identityName ?? null,
          personality: personaVersion?.personality ?? null,
          language: personaVersion?.language ?? null,
        },
        agent:
          agent === undefined
            ? { id: simulation.agentId, name: null, archived: null }
            : {
                id: agent.id,
                name: agent.name,
                archived: agent.archivedAt !== null,
              },
        connection:
          connection === undefined
            ? { id: simulation.connectionId, name: null, archived: null }
            : {
                id: connection.id,
                name: connection.name,
                archived: connection.archivedAt !== null,
              },
        connectionSnapshot: {
          agentPlatform: run.connectionSnapshot.agentPlatform,
          connectionType: run.connectionSnapshot.connectionType,
          accessVariant: run.connectionSnapshot.accessVariant,
          modality: run.connectionSnapshot.modality,
          topology: run.connectionSnapshot.topology,
          environment: run.connectionSnapshot.environment,
          config: run.connectionSnapshot.config,
        },
        gradingPlan: describedPlanForSimulation(
          plan,
          simulation.testId,
          simulation.testVersionId,
        ),
        transcript: describedTranscript(transcript),
      });
    },
  );

  registerPlatformOperation(
    app,
    simulationOperations.regradeSimulation,
    async (request, reply) => {
      const body = request.body;
      if (
        body !== undefined &&
        body !== null &&
        (typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body as Record<string, unknown>).length > 0)
      ) {
        return unprocessable(
          reply,
          "regrading always runs the whole frozen grader selection; send no request body.",
        );
      }
      const query = (request.query ?? {}) as Record<string, unknown>;
      const { simulationId } = request.params as { simulationId: string };
      const acting = await actingIn(
        requesterOf(request).auth,
        projectNamedByPlatform(query),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);

      const simulation = await getSimulation(acting.auth, simulationId);
      if (simulation === undefined) {
        return notFound(reply, NO_SUCH_SIMULATION);
      }
      const traceId = traceIdOfSimulation(simulation.id);
      if (simulation.status !== "completed" || traceId === undefined) {
        return unprocessable(
          reply,
          `simulation ${simulationId} has no completed trace to grade again.`,
        );
      }

      const requested = await regradeTrace(acting.auth, {
        source: "simulation",
        traceId,
        runId: simulation.runId,
      });
      if (requested.kind === "not_requested") {
        return unprocessable(
          reply,
          `simulation ${simulationId} has no frozen grader selection to run again.`,
        );
      }
      if (requested.kind !== "queued") {
        return unprocessable(
          reply,
          `simulation ${simulationId} is not ready to grade again.`,
        );
      }

      return reply.send({
        simulationId,
        reopened: requested.reopened ? 1 : 0,
        alreadyWaiting: requested.alreadyWaiting ? 1 : 0,
      });
    },
  );

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
