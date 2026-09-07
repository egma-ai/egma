import {
  AGENT_POV_BOUND_SECONDS,
  getAgent,
  getConnection,
  getGradingPlan,
  getPersona,
  getPersonaVersion,
  getRun,
  getSimulation,
  getSimulationExecutionEvidence,
  LANES_SERVING_MOCK_TOOLS,
  laneProducesAnAgentPov,
  NotPermittedError,
  readTrace,
  readTraceGrading,
  regradeTrace,
  type GradingPlan,
  type Run,
  type Simulation,
  type TraceDetail,
  type TraceSpan,
} from "@egma/db";
import { everySpanIn } from "@egma/metrics";
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

/**
 * Derive mock tool marks from the pinned test version and connection type.
 * Phone connections cannot serve mock tools, even if the test names them.
 * The mark describes configured coverage; it is not a separate execution receipt.
 */
function mockedToolNames(
  connectionType: string,
  mockTools: readonly { readonly tool: string }[] | undefined,
): ReadonlySet<string> {
  if (
    !(LANES_SERVING_MOCK_TOOLS as readonly string[]).includes(connectionType)
  ) {
    return new Set();
  }
  return new Set((mockTools ?? []).map((mock) => mock.tool));
}

function describedSpan(
  span: TraceSpan,
  mocked: ReadonlySet<string>,
): Record<string, unknown> {
  // Only a tool span can carry the mark, and only for a name the pinned
  // version answers for. Whichever POV reported the call is marked the same
  // way: what egma stood in front of is a fact about the test, not about who
  // wrote the row down. The mock tool's own name is not written beside it —
  // matching is by tool name and by nothing else, so it is `toolName`.
  const answeredByAMockTool = span.kind === "tool" && mocked.has(span.toolName);
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
    // Whose POV this row is. `emitter` is the storage word and never reaches
    // a screen.
    pov: span.pov,
    // Absent on a real call, so nothing downstream has to tell "ran for real"
    // from "nobody recorded who answered".
    ...(answeredByAMockTool ? { toolProvenance: "mocked" as const } : {}),
    spans: span.spans.map((nested) => describedSpan(nested, mocked)),
  };
}

function describedTranscript(
  detail: TraceDetail | undefined,
  mocked: ReadonlySet<string>,
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
    turns: detail.turns.map((span) => describedSpan(span, mocked)),
    spans: detail.spans.map((span) => describedSpan(span, mocked)),
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

/**
 * Report a missing agent POV after the wait bound for a completed simulation
 * whose connection type and provider reference indicate that one was expected.
 * Any agent span clears this flag; it does not detect partial exports.
 */
function agentPovIncomplete(
  simulation: Simulation,
  run: Run,
  transcript: TraceDetail | undefined,
): boolean {
  if (simulation.status !== "completed") return false;
  const reference = simulation.providerReference;
  if (reference === null || reference === "") return false;
  if (!laneProducesAnAgentPov(run.connectionSnapshot.connectionType)) {
    return false;
  }
  if (transcript !== undefined) {
    for (const span of everySpanIn(transcript)) {
      if (span.pov === "agent") return false;
    }
  }
  // The wait began when the conversation ended, on the earlier of the two
  // clocks that answer for that — the same reading grading itself takes, so a
  // report from a machine running ahead cannot make this say "still waiting"
  // forever.
  const reported = simulation.endedAt;
  const stamped = simulation.heartbeatAt;
  const began =
    reported === null
      ? stamped
      : stamped === null || reported < stamped
        ? reported
        : stamped;
  if (began === null) return false;
  return Date.now() - began.getTime() >= AGENT_POV_BOUND_SECONDS * 1_000;
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
      const mocked = mockedToolNames(
        run.connectionSnapshot.connectionType,
        executionEvidence?.mockTools,
      );

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
        // **That grading stopped waiting for the agent's own account of this
        // conversation.** The wait is bounded at thirty seconds so a broken
        // exporter or a failed pull cannot hold a simulation open forever
        // (ADR-0024 §6), and past the bound the record has to say so: a reader
        // showing the agent's POV would otherwise show whatever fragment
        // arrived as if it were the conversation. False is the ordinary answer
        // — the account landed, or the lane files none.
        agentPovIncomplete: agentPovIncomplete(simulation, run, transcript),
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
        transcript: describedTranscript(transcript, mocked),
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
