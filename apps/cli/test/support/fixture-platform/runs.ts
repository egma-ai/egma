/**
 * The run endpoints of the fixture platform.
 *
 * This is the contract `egma run` and the wizard's run screen are built
 * against, written down as something that runs. It mirrors the real run
 * machinery (`packages/db/src/access/runs.ts` and the `0007_runs` migration)
 * where the mirroring is what the CLI depends on, and it is deliberately not
 * kinder than the real thing anywhere:
 *
 * - **A run pins the versions it executed.** The request names test version
 *   ids, every one is resolved before anything is written, and a version this
 *   egma never issued refuses the whole creation rather than quietly running
 *   eleven of twelve.
 * - **A run produces one simulation per test per persona.** The count is
 *   stamped at creation and never moves, exactly as `expected_simulation_count`
 *   is stamped once and frozen by the real trigger.
 * - **A simulation's lifecycle is a one-way street.** `queued → claimed →
 *   running → completed | failed | canceled`, and a terminal simulation is
 *   written once. The same transitions the real `simulation_lifecycle_guard`
 *   enforces, refused here with the same shape of message.
 * - **A verdict is not a status.** The status says how far the simulation
 *   got; the verdict says what the graders made of it. `passed`,
 *   `failed`, `skipped` and `errored`, and the last two are never folded into
 *   the third — a test that could not run is not a test that failed, so the
 *   fixture refuses a pairing that would say it did.
 *
 * Advancing a simulation is a control, not a contract. On a real instance the
 * simulator claims the work and reports what it found; here a test says so
 * directly, which is what lets a whole run be choreographed in CI with no
 * simulator, no provider and no audio.
 */

// The platform's own identifier generator, reached by path for the same reason
// the test group reaches it that way: the smoke checks run this fixture under
// plain node, where a package name nothing has installed does not resolve.
import { newId } from "../../../../../packages/ids/src/index.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

/** How far one simulation got. The real `simulation_status_allowed`. */
export type SimulationStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** What the graders made of it. The glossary's four, and only these four. */
export type Verdict = "passed" | "failed" | "skipped" | "errored";

/** The real `run_status_allowed`. */
export type RunStatus = "pending" | "running" | "completed" | "canceled";

const TERMINAL: readonly SimulationStatus[] = ["completed", "failed", "canceled"];

/**
 * Which status may follow which, mirroring `guard_simulation_lifecycle`.
 */
const NEXT: Readonly<Record<SimulationStatus, readonly SimulationStatus[]>> = {
  queued: ["claimed", "canceled"],
  claimed: ["running", "failed", "canceled"],
  running: ["completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

/**
 * Which verdicts may arrive with which ending, and why each pairing is the
 * only honest one.
 *
 * A simulation that ran is judged: it passed, it failed, or the graders had
 * nothing they could score and it was skipped. A simulation that never ran
 * errored — nobody judged anything, and naming that a failure would put a red
 * mark against a test that was never executed. A simulation somebody stopped
 * was likewise never judged, so it is skipped.
 */
const VERDICTS_FOR: Readonly<Record<SimulationStatus, readonly Verdict[]>> = {
  queued: [],
  claimed: [],
  running: [],
  completed: ["passed", "failed", "skipped"],
  failed: ["errored"],
  canceled: ["skipped"],
};

type StoredSimulation = {
  readonly id: string;
  readonly runId: string;
  readonly position: number;
  readonly testId: string;
  readonly testName: string;
  readonly testVersionId: string;
  readonly personaId: string;
  readonly personaName: string;
  status: SimulationStatus;
  verdict: Verdict | null;
  /** What the platform says about an ending, in its own words, or `null`. */
  reason: string | null;
};

type StoredRun = {
  readonly id: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly connectionType: string;
  readonly modality: string;
  readonly label: string | null;
  readonly testVersionIds: readonly string[];
  readonly expectedSimulationCount: number;
  status: RunStatus;
  completedCount: number | null;
  failedCount: number | null;
  canceledCount: number | null;
  readonly createdAt: string;
  finishedAt: string | null;
};

/** One change, in the order it happened. The feed a follower reads. */
type StoredEvent = {
  readonly seq: number;
  readonly runId: string;
  readonly at: string;
} & (
  | {
      readonly kind: "simulation";
      readonly simulationId: string;
      readonly testName: string;
      readonly personaName: string;
      readonly status: SimulationStatus;
      readonly verdict: Verdict | null;
      readonly reason: string | null;
    }
  | { readonly kind: "run"; readonly status: RunStatus }
);

/** What a version of a test is, to a run that is about to pin it. */
export type PinnedVersion = {
  readonly versionId: string;
  readonly testId: string;
  readonly testName: string;
  /** Who calls about it, in the order they were authored. */
  readonly personas: readonly { readonly id: string; readonly name: string }[];
};

/** What a connection is, to a run that is about to execute over it. */
export type ReachableConnection = {
  readonly id: string;
  readonly agentId: string;
  readonly type: string;
  readonly modality: string;
};

/** One step of a scripted lifecycle. */
export type AdvanceStep = {
  /** Omit when there is only one run. */
  readonly run?: string;
  /** A simulation id, a test name, or a 1-based position. */
  readonly simulation: string;
  readonly status: SimulationStatus;
  /** Required for a terminal status, refused for any other. */
  readonly verdict?: Verdict;
  readonly reason?: string;
};

export type SeededRun = {
  readonly id: string;
  readonly status: RunStatus;
  readonly expectedSimulationCount: number;
  readonly testVersionIds: readonly string[];
};

export type SeededSimulation = {
  readonly id: string;
  readonly position: number;
  readonly testName: string;
  readonly personaName: string;
  readonly status: SimulationStatus;
  readonly verdict: Verdict | null;
};

export type RunControls = {
  /** Every run created, oldest first. */
  readonly runs: readonly SeededRun[];
  /** Every simulation of a run, in position order. */
  simulationsOf(runId?: string): readonly SeededSimulation[];
  /**
   * Move one simulation along, and deliver the verdict that goes with the
   * ending. This is what lets a check choreograph the exact sequence it wants
   * to see on a screen or on standard output.
   */
  advance(step: AdvanceStep): void;
  /**
   * Make this egma refuse a run over a connection of this type, because no
   * simulator adapter for it has shipped. The refusal is the platform's own
   * and the CLI must relay it word for word.
   */
  noAdapterFor(type: string): void;
  /** The words that refusal is made of, so a check can assert on the same ones. */
  noAdapterMessage(type: string): string;
};

function refuse(status: number, error: string, message: string): FixtureAnswer {
  return { status, body: { error, message } };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => text(item)) : [];
}

/**
 * The platform's own words for a connection type it cannot conduct a run over.
 *
 * A connection type lands in egma one adapter at a time, and a run over a type
 * whose adapter has not shipped can never happen — so it is refused at
 * creation, loudly, rather than left queued forever. The wording is the
 * platform's; egma's terminal repeats it and never paraphrases it.
 */
export function noAdapterMessage(type: string): string {
  return (
    `egma has no simulator adapter for a ${type} connection yet, ` +
    `so it will not start a run it cannot conduct`
  );
}

export function runRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  /** Where this instance is, for the address a person opens results at. */
  readonly origin: () => string;
  /** One pinned version, or `null` when this egma never issued it. */
  readonly versionById: (versionId: string) => PinnedVersion | null;
  /** One connection, or `null` when no agent of this key's has it. */
  readonly connectionById: (connectionId: string) => ReachableConnection | null;
}): { readonly group: RouteGroup; readonly controls: RunControls } {
  const runs: StoredRun[] = [];
  const simulations: StoredSimulation[] = [];
  const events: StoredEvent[] = [];
  const withoutAdapter = new Set<string>();

  const record = (event: Omit<StoredEvent, "seq" | "at">): void => {
    events.push({ ...event, seq: events.length + 1, at: new Date().toISOString() } as StoredEvent);
  };

  const runById = (id: string): StoredRun | undefined =>
    runs.find((held) => held.id === id);

  const simulationsIn = (runId: string): StoredSimulation[] =>
    simulations.filter((held) => held.runId === runId);

  /**
   * The header, finalized by whichever terminal transition lands last: the
   * three counts and the finish arrive together, once, exactly as the real
   * trigger insists.
   */
  const settle = (run: StoredRun): void => {
    const held = simulationsIn(run.id);
    if (run.status === "pending" && held.some((one) => one.status !== "queued")) {
      run.status = "running";
      record({ kind: "run", runId: run.id, status: "running" });
    }
    if (run.finishedAt !== null) return;
    if (!held.every((one) => TERMINAL.includes(one.status))) return;

    run.completedCount = held.filter((one) => one.status === "completed").length;
    run.failedCount = held.filter((one) => one.status === "failed").length;
    run.canceledCount = held.filter((one) => one.status === "canceled").length;
    run.finishedAt = new Date().toISOString();
    run.status = run.canceledCount === held.length ? "canceled" : "completed";
    record({ kind: "run", runId: run.id, status: run.status });
  };

  const move = (
    simulation: StoredSimulation,
    to: SimulationStatus,
    verdict: Verdict | undefined,
    reason: string | undefined,
  ): void => {
    if (TERMINAL.includes(simulation.status)) {
      throw new Error(
        `simulation ${simulation.id} is ${simulation.status}, and a terminal simulation is written once`,
      );
    }
    if (!NEXT[simulation.status].includes(to)) {
      throw new Error(
        `simulation ${simulation.id} may not move from ${simulation.status} to ${to}`,
      );
    }

    const allowed = VERDICTS_FOR[to];
    if (allowed.length === 0) {
      if (verdict !== undefined) {
        throw new Error(`a ${to} simulation has no verdict yet, and one was given`);
      }
    } else if (verdict === undefined) {
      throw new Error(
        `a ${to} simulation carries a verdict: one of ${allowed.join(", ")}`,
      );
    } else if (!allowed.includes(verdict)) {
      throw new Error(
        `a ${to} simulation is ${allowed.join(" or ")}, never ${verdict}`,
      );
    }

    simulation.status = to;
    simulation.verdict = verdict ?? null;
    simulation.reason = reason ?? null;
    record({
      kind: "simulation",
      runId: simulation.runId,
      simulationId: simulation.id,
      testName: simulation.testName,
      personaName: simulation.personaName,
      status: simulation.status,
      verdict: simulation.verdict,
      reason: simulation.reason,
    });
    settle(runById(simulation.runId) as StoredRun);
  };

  const simulationOut = (one: StoredSimulation): Record<string, unknown> => ({
    id: one.id,
    position: one.position,
    test_id: one.testId,
    test_name: one.testName,
    test_version_id: one.testVersionId,
    persona_id: one.personaId,
    persona_name: one.personaName,
    status: one.status,
    verdict: one.verdict,
    reason: one.reason,
  });

  const runOut = (run: StoredRun): Record<string, unknown> => ({
    id: run.id,
    status: run.status,
    agent_id: run.agentId,
    connection_id: run.connectionId,
    connection_type: run.connectionType,
    modality: run.modality,
    label: run.label,
    test_versions: [...run.testVersionIds],
    expected_simulation_count: run.expectedSimulationCount,
    completed_count: run.completedCount,
    failed_count: run.failedCount,
    canceled_count: run.canceledCount,
    // No token, no key, no query at all. A person opens it and the browser
    // they approved this machine in is already signed in.
    results_url: `${options.origin()}/runs/${run.id}`,
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  });

  const eventOut = (event: StoredEvent): Record<string, unknown> =>
    event.kind === "run"
      ? { seq: event.seq, at: event.at, kind: "run", status: event.status }
      : {
          seq: event.seq,
          at: event.at,
          kind: "simulation",
          simulation_id: event.simulationId,
          test_name: event.testName,
          persona_name: event.personaName,
          status: event.status,
          verdict: event.verdict,
          reason: event.reason,
        };

  const behindAKey = (request: FixtureRequest, answer: () => FixtureAnswer): FixtureAnswer => {
    const offered = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
    if (offered === "" || !options.holdsKey(offered)) {
      return refuse(401, "not_authenticated", "no key, or not one of ours");
    }
    return answer();
  };

  const create = (body: Record<string, unknown> | null): FixtureAnswer => {
    const said = body ?? {};

    const connection = options.connectionById(text(said.connection).trim());
    if (connection === null) {
      return refuse(404, "not_found", "no connection of yours has that id");
    }
    const agentId = text(said.agent).trim();
    if (agentId !== "" && agentId !== connection.agentId) {
      return refuse(404, "not_found", "that connection is not on that agent");
    }

    // Refused at creation, in the platform's own words, before a single
    // simulation is written: a run nothing can conduct must never be queued.
    if (withoutAdapter.has(connection.type)) {
      return refuse(422, "no_adapter", noAdapterMessage(connection.type));
    }

    const wanted = textList(said.test_versions).map((one) => one.trim());
    if (wanted.length === 0) {
      return refuse(
        422,
        "unprocessable",
        "a run needs at least one test version, because a run with no simulations checks nothing",
      );
    }

    const pinned: PinnedVersion[] = [];
    const seen = new Set<string>();
    for (const versionId of wanted) {
      if (seen.has(versionId)) {
        return refuse(422, "unprocessable", `test version ${versionId} is pinned twice on one run`);
      }
      seen.add(versionId);
      const version = options.versionById(versionId);
      if (version === null) {
        return refuse(422, "unprocessable", `there is no test version ${versionId} on this egma`);
      }
      pinned.push(version);
    }

    const run: StoredRun = {
      id: newId("run"),
      agentId: connection.agentId,
      connectionId: connection.id,
      connectionType: connection.type,
      modality: connection.modality,
      label: text(said.label).trim() || null,
      testVersionIds: pinned.map((one) => one.versionId),
      // One simulation per test per persona, counted before anything is
      // written and never moved afterwards.
      expectedSimulationCount: pinned.reduce((total, one) => total + one.personas.length, 0),
      status: "pending",
      completedCount: null,
      failedCount: null,
      canceledCount: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };

    let position = 0;
    const born: StoredSimulation[] = [];
    for (const version of pinned) {
      for (const persona of version.personas) {
        position += 1;
        born.push({
          id: newId("sim"),
          runId: run.id,
          position,
          testId: version.testId,
          testName: version.testName,
          testVersionId: version.versionId,
          personaId: persona.id,
          personaName: persona.name,
          status: "queued",
          verdict: null,
          reason: null,
        });
      }
    }

    runs.push(run);
    simulations.push(...born);

    return {
      status: 201,
      body: { ...runOut(run), simulations: born.map(simulationOut) },
    };
  };

  const group: RouteGroup = {
    name: "runs",
    routes: [
      {
        // Start a run: name the connection, pin the versions. Nothing is rooted
        // at a project and the organization is never in the address — both come
        // from the key, exactly as every other write here resolves them.
        method: "POST",
        path: "/api/runs",
        handle: (request) => behindAKey(request, () => create(request.body)),
      },
      {
        // The run as it now stands, with every simulation. What a follower
        // seeds itself from when it did not create the run itself.
        method: "GET",
        path: "/api/runs/:runId",
        handle: (request) =>
          behindAKey(request, () => {
            const run = runById(request.params.runId ?? "");
            if (run === undefined) {
              return refuse(404, "not_found", "no run of yours has that id");
            }
            return {
              status: 200,
              body: {
                ...runOut(run),
                simulations: simulationsIn(run.id).map(simulationOut),
              },
            };
          }),
      },
      {
        // Everything that has changed since a point, in order. A cursor rather
        // than a socket: a follower that loses its connection asks again from
        // where it was, so it never misses a change and never sees one twice.
        method: "GET",
        path: "/api/runs/:runId/events",
        handle: (request) =>
          behindAKey(request, () => {
            const run = runById(request.params.runId ?? "");
            if (run === undefined) {
              return refuse(404, "not_found", "no run of yours has that id");
            }
            const after = Number.parseInt(request.url.searchParams.get("after") ?? "0", 10);
            const from = Number.isFinite(after) && after > 0 ? after : 0;
            const mine = events.filter(
              (event) => event.runId === run.id && event.seq > from,
            );
            return {
              status: 200,
              body: {
                events: mine.map(eventOut),
                next: mine.at(-1)?.seq ?? from,
                done: run.finishedAt !== null,
              },
            };
          }),
      },
    ],
  };

  const find = (step: AdvanceStep): StoredSimulation => {
    const run =
      step.run === undefined
        ? runs.at(-1)
        : runById(step.run);
    if (run === undefined) throw new Error("no run has been created on this fixture");

    const held = simulationsIn(run.id);
    const wanted = step.simulation.trim();
    const found =
      held.find((one) => one.id === wanted) ??
      held.find((one) => one.testName === wanted) ??
      held.find((one) => String(one.position) === wanted);
    if (found === undefined) {
      throw new Error(`run ${run.id} has no simulation called "${wanted}"`);
    }
    return found;
  };

  const controls: RunControls = {
    get runs() {
      return runs.map((run) => ({
        id: run.id,
        status: run.status,
        expectedSimulationCount: run.expectedSimulationCount,
        testVersionIds: [...run.testVersionIds],
      }));
    },
    simulationsOf(runId) {
      const run = runId === undefined ? runs.at(-1) : runById(runId);
      if (run === undefined) return [];
      return simulationsIn(run.id).map((one) => ({
        id: one.id,
        position: one.position,
        testName: one.testName,
        personaName: one.personaName,
        status: one.status,
        verdict: one.verdict,
      }));
    },
    advance(step) {
      move(find(step), step.status, step.verdict, step.reason);
    },
    noAdapterFor(type) {
      withoutAdapter.add(type);
    },
    noAdapterMessage,
  };

  return { group, controls };
}

/**
 * The fixture's own controls for a run, over HTTP.
 *
 * The same separation the login controls keep: nothing the CLI does touches a
 * `/fixture` path, and they are reachable over HTTP because the thing being
 * checked is usually a subprocess — the built `egma` command, watched through
 * a terminal.
 */
export function runControlRoutes(controls: () => RunControls): RouteGroup {
  return {
    name: "fixture-run-controls",
    routes: [
      {
        method: "POST",
        path: "/fixture/runs/advance",
        handle: (request) => {
          const said = request.body ?? {};
          const step: AdvanceStep = {
            ...(typeof said.run === "string" ? { run: said.run } : {}),
            simulation: text(said.simulation),
            status: text(said.status) as SimulationStatus,
            ...(typeof said.verdict === "string" ? { verdict: said.verdict as Verdict } : {}),
            ...(typeof said.reason === "string" ? { reason: said.reason } : {}),
          };
          try {
            controls().advance(step);
          } catch (error) {
            return {
              status: 409,
              body: { done: false, message: error instanceof Error ? error.message : String(error) },
            };
          }
          return { status: 200, body: { done: true } };
        },
      },
      {
        method: "POST",
        path: "/fixture/runs/no-adapter",
        handle: (request) => {
          const type = text(request.body?.type).trim();
          if (type === "") {
            return { status: 400, body: { done: false, message: "name a connection type" } };
          }
          controls().noAdapterFor(type);
          return { status: 200, body: { done: true } };
        },
      },
      {
        method: "GET",
        path: "/fixture/runs",
        handle: () => ({
          status: 200,
          body: {
            runs: controls().runs.map((run) => ({
              id: run.id,
              status: run.status,
              expected_simulation_count: run.expectedSimulationCount,
              test_versions: [...run.testVersionIds],
            })),
          },
        }),
      },
    ],
  };
}
