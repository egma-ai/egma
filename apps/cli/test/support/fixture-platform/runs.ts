/** Current complete-suite run fixture contract with bounded simulation pages. */

import type { GetSimulationResponse } from "@egma/platform-api/client";

import { CONDUCTABLE_KINDS } from "./agents.ts";
import { given, newId, NOT_AUTHENTICATED, refuse, text } from "./reading.ts";
import type { FixtureTestVersion } from "./tests.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

export type SimulationStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type GradingState =
  | "not_requested"
  | "pending"
  | "running"
  | "complete"
  | "error";
export type RunStatus = "pending" | "running" | "completed" | "canceled";
export type FixtureGrade = GetSimulationResponse["grades"][number];

export type ReachableConnection = {
  readonly id: string;
  readonly agentId: string;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: string;
  readonly productLabel: string;
};

export type AdvanceStep = {
  readonly run?: string;
  readonly simulation: string;
  readonly status: SimulationStatus;
  readonly gradingState?: GradingState;
  readonly reason?: string;
};
export type GradingStep = {
  readonly run?: string;
  readonly simulation: string;
  readonly state: GradingState;
  readonly grades?: readonly FixtureGrade[];
  readonly combinedScore?: number | null;
};
/**
 * The authored person every fixture simulation pinned.
 *
 * One value for all of them, because no test here reads it: the CLI shows a
 * persona by the team's `personaName` and never opens the version. What this
 * exists for is the shape — the simulation read answers the person flat, and a
 * fixture answering anything else would teach a document the platform can no
 * longer produce.
 */
const FIXTURE_PERSON = {
  identityName: "Sam Okafor",
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
} as const;

export type SeededRun = {
  readonly id: string;
  readonly suiteId: string;
  readonly status: RunStatus;
  readonly expectedSimulationCount: number;
};
export type SeededSimulation = {
  readonly id: string;
  readonly position: number;
  readonly testName: string;
  readonly personaName: string;
  readonly status: SimulationStatus;
  readonly gradingState: GradingState | null;
};
export type RunControls = {
  readonly runs: readonly SeededRun[];
  simulationsOf(runId?: string): readonly SeededSimulation[];
  advance(step: AdvanceStep): void;
  setGrading(step: GradingStep): void;
  noAdapterFor(connectionType: string): void;
  noAdapterMessage(connectionType: string): string;
};

type StoredRun = Omit<SeededRun, "status"> & {
  status: RunStatus;
  readonly agentId: string;
  readonly connectionId: string;
  readonly name: string | null;
};
type StoredSimulation = SeededSimulation & {
  readonly runId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly personaId: string;
  reason: string | null;
  status: SimulationStatus;
  gradingState: GradingState | null;
  grades: FixtureGrade[];
  combinedScore: number | null;
};
type StoredEvent =
  | {
      readonly seq: number;
      readonly runId: string;
      readonly kind: "run";
      readonly status: RunStatus;
    }
  | {
      readonly seq: number;
      readonly runId: string;
      readonly kind: "simulation";
      readonly simulationId: string;
      readonly testName: string;
      readonly personaName: string;
      readonly status: SimulationStatus;
      readonly reason: string | null;
    };
type StoredEventInput = StoredEvent extends infer Event
  ? Event extends StoredEvent
    ? Omit<Event, "seq">
    : never
  : never;

const TERMINAL: readonly SimulationStatus[] = ["completed", "failed", "canceled"];
const TERMINAL_GRADING: readonly GradingState[] = ["not_requested", "complete", "error"];
const NEXT: Readonly<Record<SimulationStatus, readonly SimulationStatus[]>> = {
  queued: ["claimed", "canceled"],
  claimed: ["running", "failed", "canceled"],
  running: ["completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

function bearer(request: FixtureRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
export function noAdapterMessage(
  connectionType: string,
  conductable: readonly string[],
): string {
  return `Egma has no simulator adapter for a ${connectionType} connection yet, so it will not start a run it cannot conduct. Run this suite over a connection Egma conducts today: ${conductable.join(", ")}.`;
}

export function runRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly origin: () => string;
  readonly projectId: string;
  readonly testsInSuite: (suiteId: string) => readonly FixtureTestVersion[];
  readonly testVersionById: (versionId: string) => FixtureTestVersion | null;
  readonly suiteWasDeleted: (suiteId: string) => boolean;
  readonly connectionById: (connectionId: string) => ReachableConnection | null;
}): { readonly group: RouteGroup; readonly controls: RunControls } {
  const runs: StoredRun[] = [];
  const simulations: StoredSimulation[] = [];
  const events: StoredEvent[] = [];
  const idempotent = new Map<string, { readonly digest: string; readonly run: StoredRun }>();
  const withoutAdapter = new Set<string>();
  const conductable = (): readonly string[] =>
    CONDUCTABLE_KINDS.filter((kind) => !withoutAdapter.has(kind));
  const behind = (request: FixtureRequest, action: () => FixtureAnswer): FixtureAnswer =>
    options.holdsKey(bearer(request)) ? action() : { status: 401, body: NOT_AUTHENTICATED };
  const runById = (id: string): StoredRun | undefined => runs.find((run) => run.id === id);
  const simulationsIn = (runId: string): StoredSimulation[] =>
    simulations.filter((simulation) => simulation.runId === runId);
  const event = (value: StoredEventInput): void => {
    events.push({ ...value, seq: events.length + 1 } as StoredEvent);
  };
  const runOut = (run: StoredRun): Record<string, unknown> => ({
    ...(() => {
      const connection = options.connectionById(run.connectionId);
      const mine = simulationsIn(run.id);
      const finished = mine.filter((one) => TERMINAL.includes(one.status));
      const gradable = mine.filter(
        (one) => one.status === "completed" && one.gradingState !== "not_requested",
      );
      const graded = gradable.filter(
        (one) => one.gradingState !== null && TERMINAL_GRADING.includes(one.gradingState),
      );
      return {
        projectId: options.projectId,
        suiteName: "Fixture suite",
        suiteDeleted: options.suiteWasDeleted(run.suiteId),
        agentPlatform: connection?.agentPlatform ?? null,
        connectionType: connection?.connectionType ?? "",
        accessVariant: connection?.accessVariant ?? "",
        modality: connection?.modality ?? "voice",
        productLabel: connection?.productLabel ?? "",
        environment: null,
        completedCount: mine.filter((one) => one.status === "completed").length,
        failedCount: mine.filter((one) => one.status === "failed").length,
        canceledCount: mine.filter((one) => one.status === "canceled").length,
        simulationCounts: {
          queued: mine.filter((one) => one.status === "queued").length,
          claimed: mine.filter((one) => one.status === "claimed").length,
          running: mine.filter((one) => one.status === "running").length,
          completed: mine.filter((one) => one.status === "completed").length,
          failed: mine.filter((one) => one.status === "failed").length,
          canceled: mine.filter((one) => one.status === "canceled").length,
        },
        finishedCount: finished.length,
        gradableCount: gradable.length,
        gradedCount: graded.length,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      };
    })(),
    id: run.id,
    suiteId: run.suiteId,
    agentId: run.agentId,
    connectionId: run.connectionId,
    name: run.name,
    status: run.status,
    expectedSimulationCount: run.expectedSimulationCount,
    resultsUrl: `${options.origin()}/projects/${options.projectId}/runs/${run.id}`,
  });
  const simulationOut = (simulation: StoredSimulation): Record<string, unknown> => {
    const run = runById(simulation.runId);
    const connection = run === undefined
      ? null
      : options.connectionById(run.connectionId);
    return {
      id: simulation.id,
      position: simulation.position,
      testId: simulation.testId,
      testName: simulation.testName,
      testVersionId: simulation.testVersionId,
      personaId: simulation.personaId,
      personaName: simulation.personaName,
      personaVersionId: simulation.personaId,
      status: simulation.status,
      gradingState: simulation.gradingState,
      reason: simulation.reason,
      modality: connection?.modality ?? "voice",
      hasRecording: false,
    };
  };
  const simulationDetailOut = (
    simulation: StoredSimulation,
  ): Record<string, unknown> => {
    const run = runById(simulation.runId);
    const connection =
      run === undefined ? null : options.connectionById(run.connectionId);
    const version = options.testVersionById(simulation.testVersionId);
    return {
      ...simulationOut(simulation),
      projectId: options.projectId,
      runId: simulation.runId,
      runName: run?.name ?? null,
      grades: simulation.grades,
      gradeHistory: [],
      combinedScore: simulation.combinedScore,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      endedAt: simulation.status === "completed" ? "2026-01-01T00:01:00.000Z" : null,
      providerReference: null,
      measures: {},
      test: {
        id: simulation.testId,
        versionId: simulation.testVersionId,
        name: simulation.testName,
        scenario: version?.scenario ?? null,
        expectedBehaviors: version?.expectedBehaviors ?? null,
      },
      // Two names, because the platform has two: `name` is the team's label
      // for the library row, and `identityName` is the human name the agent
      // was told — read off the version this simulation pinned, along with the
      // personality and language beside it.
      //
      // Answered whole rather than as nulls. Null here is what a simulation
      // whose pinned version could not be read at all looks like, and a
      // fixture must not teach that shape for an ordinary healthy run.
      persona: {
        id: simulation.personaId,
        name: simulation.personaName,
        versionId: simulation.personaId,
        ...FIXTURE_PERSON,
      },
      agent: {
        id: run?.agentId ?? "",
        name: null,
        archived: false,
      },
      connection: {
        id: run?.connectionId ?? "",
        name: null,
        archived: false,
      },
      connectionSnapshot: {
        agentPlatform: connection?.agentPlatform ?? null,
        connectionType: connection?.connectionType ?? "",
        accessVariant: connection?.accessVariant ?? "",
        modality: connection?.modality ?? "voice",
        topology: "fixture",
        environment: null,
        config: {},
      },
      mockTools: { defaults: [], overrides: [] },
      gradingPlan:
        simulation.grades.length === 0
          ? null
          : {
              state: "run_start",
              capturedAt: "2026-01-01T00:00:00.000Z",
              items: simulation.grades.map((grade) => ({
                projectGraderId: grade.projectGraderId,
                graderDefinitionId: grade.graderDefinitionId,
                graderDefinitionVersion: grade.graderDefinitionVersion,
                graderName: grade.graderName,
                passThreshold: grade.passThreshold,
              })),
            },
      transcript: null,
    };
  };
  const expectedSet = (value: unknown): readonly { readonly testId: string; readonly versionId: string }[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const parsed = value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const testId = text(row.testId);
      const versionId = text(row.versionId);
      return testId === "" || versionId === "" ? null : { testId, versionId };
    });
    return parsed.some((entry) => entry === null)
      ? null
      : (parsed as readonly { readonly testId: string; readonly versionId: string }[]);
  };
  const start = (said: Record<string, unknown>): FixtureAnswer => {
    if ("testVersionIds" in said || "label" in said) {
      return refuse(422, "unprocessable", "this API starts one complete suite; old run selection fields are unsupported");
    }
    const suiteId = text(said.suiteId);
    const connectionId = text(said.connectionId);
    const idempotencyKey = text(said.idempotencyKey);
    if (suiteId === "" || connectionId === "" || idempotencyKey === "") {
      return refuse(422, "unprocessable", "suiteId, connectionId, and idempotencyKey are required");
    }
    const connection = options.connectionById(connectionId);
    if (connection === null || (text(said.agentId) !== "" && text(said.agentId) !== connection.agentId)) {
      return refuse(404, "not_found", "there is no matching active connection");
    }
    if (!conductable().includes(connection.connectionType)) {
      return refuse(422, "no_adapter", noAdapterMessage(connection.connectionType, conductable()));
    }
    const versions = options.testsInSuite(suiteId);
    if (versions.length === 0) return refuse(422, "empty_suite", "an empty suite cannot start a run");
    const expected = expectedSet(said.expectedTestVersions);
    if (expected === null) return refuse(422, "unprocessable", "expectedTestVersions must be test/version pairs");
    if (expected.length > 0) {
      const actual = versions
        .map((version) => `${version.testId}:${version.id}`)
        .sort();
      const asked = expected.map((entry) => `${entry.testId}:${entry.versionId}`).sort();
      if (new Set(asked).size !== asked.length || JSON.stringify(actual) !== JSON.stringify(asked)) {
        return refuse(409, "suite_changed", "the suite changed after the repository checked it");
      }
    }
    const digest = JSON.stringify({
      suiteId,
      agentId: connection.agentId,
      connectionId,
      name: text(said.name),
      expected,
    });
    const replay = idempotent.get(idempotencyKey);
    if (replay !== undefined) {
      return replay.digest === digest
        ? { status: 200, body: runOut(replay.run) }
        : refuse(409, "idempotency_conflict", "this idempotency key already names another request");
    }
    const run: StoredRun = {
      id: newId("run"),
      suiteId,
      agentId: connection.agentId,
      connectionId,
      name: text(said.name) || null,
      status: "pending",
      expectedSimulationCount: versions.reduce(
        (total, version) => total + Math.max(version.personas.length, 1),
        0,
      ),
    };
    let position = 0;
    for (const version of versions) {
      const personas = version.personas.length === 0
        ? [{ id: "prs_default", name: "default-persona" }]
        : version.personas;
      for (const persona of personas) {
        position += 1;
        simulations.push({
          id: newId("sim"),
          runId: run.id,
          position,
          testId: version.testId,
          testName: version.testName,
          personaId: persona.id,
          personaName: persona.name,
          testVersionId: version.id,
          status: "queued",
          gradingState: null,
          reason: null,
          grades: [],
          combinedScore: null,
        });
      }
    }
    runs.push(run);
    idempotent.set(idempotencyKey, { digest, run });
    return { status: 201, body: runOut(run) };
  };
  const settle = (run: StoredRun): void => {
    const held = simulationsIn(run.id);
    if (run.status === "pending" && held.some((one) => one.status !== "queued")) {
      run.status = "running";
      event({ runId: run.id, kind: "run", status: "running" });
    }
    if (held.length > 0 && held.every((one) => TERMINAL.includes(one.status))) {
      run.status = held.every((one) => one.status === "canceled") ? "canceled" : "completed";
      event({ runId: run.id, kind: "run", status: run.status });
    }
  };
  const find = (step: AdvanceStep | GradingStep): StoredSimulation => {
    const run = step.run === undefined ? runs.at(-1) : runById(step.run);
    if (run === undefined) throw new Error("no run has been created on this fixture");
    const found = simulationsIn(run.id).find(
      (one) =>
        one.id === step.simulation ||
        one.testName === step.simulation ||
        String(one.position) === step.simulation,
    );
    if (found === undefined) throw new Error(`run ${run.id} has no simulation called ${step.simulation}`);
    return found;
  };

  const group: RouteGroup = {
    name: "runs",
    routes: [
      {
        method: "POST",
        path: "/v1/runs",
        handle: (request) => behind(request, () => start(request.body ?? {})),
      },
      {
        method: "GET",
        path: "/v1/runs/:runId",
        handle: (request) =>
          behind(request, () => {
            const run = runById(request.params.runId ?? "");
            return run === undefined
              ? refuse(404, "not_found", "no run of yours has that id")
              : { status: 200, body: runOut(run) };
          }),
      },
      {
        method: "GET",
        path: "/v1/runs/:runId/simulations",
        handle: (request) =>
          behind(request, () => {
            const run = runById(request.params.runId ?? "");
            return run === undefined
              ? refuse(404, "not_found", "no run of yours has that id")
              : {
                  status: 200,
                  body: { simulations: simulationsIn(run.id).map(simulationOut), nextPageToken: null },
                };
          }),
      },
      {
        method: "GET",
        path: "/v1/simulations/:simulationId",
        handle: (request) =>
          behind(request, () => {
            const simulation = simulations.find(
              (one) => one.id === (request.params.simulationId ?? ""),
            );
            return simulation === undefined
              ? refuse(404, "not_found", "no simulation of yours has that id")
              : { status: 200, body: simulationDetailOut(simulation) };
          }),
      },
      {
        method: "GET",
        path: "/v1/runs/:runId/events",
        handle: (request) =>
          behind(request, () => {
            const run = runById(request.params.runId ?? "");
            if (run === undefined) return refuse(404, "not_found", "no run of yours has that id");
            const after = Number(given(request.url.searchParams.get("after")) ?? "0");
            const mine = events.filter((one) => one.runId === run.id && one.seq > after);
            return {
              status: 200,
              body: {
                events: mine.map((one) =>
                  one.kind === "run"
                    ? {
                        seq: one.seq,
                        at: "2026-01-01T00:00:00.000Z",
                        kind: "run",
                        status: one.status,
                      }
                    : {
                        seq: one.seq,
                        at: "2026-01-01T00:00:00.000Z",
                        kind: "simulation",
                        simulationId: one.simulationId,
                        testName: one.testName,
                        personaName: one.personaName,
                        status: one.status,
                        reason: one.reason,
                      },
                ),
                next: mine.at(-1)?.seq ?? after,
                done:
                  (run.status === "completed" || run.status === "canceled") &&
                  simulationsIn(run.id).every(
                    (one) =>
                      one.status !== "completed" ||
                      (one.gradingState !== null &&
                        TERMINAL_GRADING.includes(one.gradingState)),
                  ),
              },
            };
          }),
      },
    ],
  };

  const controls: RunControls = {
    get runs() {
      return runs.map((run) => ({
        id: run.id,
        suiteId: run.suiteId,
        status: run.status,
        expectedSimulationCount: run.expectedSimulationCount,
      }));
    },
    simulationsOf(runId) {
      const run = runId === undefined ? runs.at(-1) : runById(runId);
      return run === undefined
        ? []
        : simulationsIn(run.id).map((one) => ({
            id: one.id,
            position: one.position,
            testName: one.testName,
            personaName: one.personaName,
            status: one.status,
            gradingState: one.gradingState,
          }));
    },
    advance(step) {
      const simulation = find(step);
      if (!NEXT[simulation.status].includes(step.status)) {
        throw new Error(`simulation ${simulation.id} may not move from ${simulation.status} to ${step.status}`);
      }
      simulation.status = step.status;
      simulation.gradingState =
        step.status === "completed"
          ? (step.gradingState ?? "pending")
          : null;
      simulation.reason = step.reason ?? null;
      event({
        runId: simulation.runId,
        kind: "simulation",
        simulationId: simulation.id,
        testName: simulation.testName,
        personaName: simulation.personaName,
        status: simulation.status,
        reason: simulation.reason,
      });
      settle(runById(simulation.runId)!);
    },
    setGrading(step) {
      const simulation = find(step);
      if (simulation.status !== "completed") {
        throw new Error("only a completed trace has grading state");
      }
      simulation.gradingState = step.state;
      if (step.grades !== undefined) simulation.grades = [...step.grades];
      if (step.combinedScore !== undefined) {
        simulation.combinedScore = step.combinedScore;
      }
    },
    noAdapterFor(connectionType) {
      withoutAdapter.add(connectionType);
    },
    noAdapterMessage: (connectionType) => noAdapterMessage(connectionType, conductable()),
  };
  return { group, controls };
}

export function runControlRoutes(controls: () => RunControls): RouteGroup {
  return {
    name: "fixture-run-controls",
    routes: [
      {
        method: "POST",
        path: "/fixture/runs/advance",
        handle: (request) => {
          try {
            controls().advance({
              ...(typeof request.body?.run === "string" ? { run: request.body.run } : {}),
              simulation: text(request.body?.simulation),
              status: text(request.body?.status) as SimulationStatus,
              ...(typeof request.body?.gradingState === "string"
                ? { gradingState: request.body.gradingState as GradingState }
                : {}),
              ...(typeof request.body?.reason === "string" ? { reason: request.body.reason } : {}),
            });
            return { status: 200, body: { done: true } };
          } catch (cause) {
            return { status: 409, body: { done: false, message: cause instanceof Error ? cause.message : String(cause) } };
          }
        },
      },
      {
        method: "POST",
        path: "/fixture/runs/no-adapter",
        handle: (request) => {
          controls().noAdapterFor(text(request.body?.connectionType));
          return { status: 200, body: { done: true } };
        },
      },
      {
        method: "GET",
        path: "/fixture/runs",
        handle: () => ({ status: 200, body: { runs: controls().runs } }),
      },
    ],
  };
}
