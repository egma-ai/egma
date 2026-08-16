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
import { CONDUCTABLE_TYPES } from "./agents.ts";
import { given, isId, newId, NOT_AUTHENTICATED, text, textList } from "./reading.ts";
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

/**
 * What one change is about: one simulation moving, or the run itself.
 *
 * Named on its own rather than written inline, because the two things the
 * fixture does with an event want different halves of it. `Omit` over a union
 * keeps only the keys every member shares, so an event this file was about to
 * write would have been checked against `{ runId, kind }` and nothing else —
 * a misspelt `simulationId` would have gone in unnoticed.
 */
type EventBody =
  | {
      readonly kind: "simulation";
      readonly simulationId: string;
      readonly testName: string;
      readonly personaName: string;
      readonly status: SimulationStatus;
      readonly verdict: Verdict | null;
      readonly reason: string | null;
    }
  | { readonly kind: "run"; readonly status: RunStatus };

/** One change, as it is about to be written: which run, and what happened. */
type NewEvent = { readonly runId: string } & EventBody;

/** One change, in the order it happened. The feed a follower reads. */
type StoredEvent = {
  readonly seq: number;
  readonly at: string;
} & NewEvent;

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
   *
   * The registry already answers this for every type it ships — `phone` has no
   * adapter and never has — so this is for taking away one that does.
   */
  noAdapterFor(type: string): void;
  /**
   * The words that refusal is made of, so a check can assert on the same ones.
   *
   * It is a control rather than a bare function because the sentence ends on
   * the list of types this instance can conduct over, and that list is the
   * registry's answer minus whatever a check has taken away.
   */
  noAdapterMessage(type: string): string;
};

function refuse(status: number, error: string, message: string): FixtureAnswer {
  return { status, body: { error, message } };
}

/**
 * A run nobody can see reads exactly like a run nobody started. Existence is
 * never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
const NO_SUCH_RUN =
  "no run of yours has that id. Check the id, or start a run with POST " +
  "/api/runs.";

/**
 * The platform's own words for a connection type it cannot conduct a run over.
 *
 * A connection type lands in egma one adapter at a time, and a run over a type
 * whose adapter has not shipped can never happen — so it is refused at
 * creation, loudly, rather than left queued forever. The wording is the
 * platform's; egma's terminal repeats it and never paraphrases it.
 *
 * It says all of it in one place: what is missing, why egma would rather refuse
 * now than queue something forever, and the move that works today. The list of
 * types that work comes off the registry rather than out of the sentence, so it
 * can never name an adapter that has not shipped or miss one that has.
 */
export function noAdapterMessage(type: string, conductable: readonly string[]): string {
  return (
    `Egma has no simulator adapter for a ${type} connection yet, ` +
    `so it will not start a run it cannot conduct. Run these tests over a ` +
    `connection Egma conducts today: ${conductable.join(", ")}.`
  );
}

/** How many simulations one run may hold, as the run machinery's ceiling does. */
const MOST_SIMULATIONS_PER_RUN = 200;

/** What a caller does instead, when a run named the wrong agent. */
const NAME_THE_RIGHT_AGENT =
  "Name the agent that connection is on, or leave the agent out and Egma " +
  "takes the connection's own.";

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
  // Seeded from the registry, which is where "nothing conducts this yet" is
  // actually written down. A check may take one more away.
  const withoutAdapter = new Set<string>();

  /** The types this instance can conduct a run over, right now. */
  const conductable = (): readonly string[] =>
    CONDUCTABLE_TYPES.filter((type) => !withoutAdapter.has(type));

  const record = (event: NewEvent): void => {
    events.push({ ...event, seq: events.length + 1, at: new Date().toISOString() });
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
      return { status: 401, body: NOT_AUTHENTICATED };
    }
    return answer();
  };

  /**
   * Start a run, in the order the platform decides it.
   *
   * Everything answerable without reading anything is answered first — the two
   * ids and the shape of the selection — so a body that could never be written
   * is refused before it learns whether the connection it names is there. Then
   * the connection, then the adapter, then every version, and only then is a
   * single row written: one unknown or doubled id refuses the whole creation,
   * because a run that quietly executed eleven of the twelve versions somebody
   * named would report green about a suite that did not run.
   */
  const create = (body: Record<string, unknown> | null): FixtureAnswer => {
    const said = body ?? {};

    // The route reads the shape of the selection before anything else, because
    // a body that could never start a run is refused before it can learn
    // whether the connection it names is even there. Text, and every entry of
    // it: an entry that is not a version id is refused rather than dropped,
    // because dropping one would start a run over the rest and the caller would
    // read green about a selection egma quietly shortened.
    const pinnedIn = said.test_versions ?? [];
    if (!Array.isArray(pinnedIn)) {
      return refuse(
        422,
        "unprocessable",
        "test_versions is the list of frozen versions this run executes, by " +
          'id. Send it as a list of text, like ["tstv_..."], taking each ' +
          "version_id from the test it belongs to.",
      );
    }
    for (const entry of pinnedIn) {
      if (typeof entry !== "string" || entry.trim() === "") {
        return refuse(
          422,
          "unprocessable",
          "a run pins each test version as text — the version_id a push or a " +
            "read answered with — and one entry in test_versions is neither. " +
            "Send them all, or none of them runs.",
        );
      }
    }

    const agentId = text(said.agent).trim();
    if (agentId !== "" && !isId("agt", agentId)) {
      return refuse(
        404,
        "not_found",
        `"${agentId}" is not an agent id, so no connection is on it. ${NAME_THE_RIGHT_AGENT}`,
      );
    }

    // Named nothing at all is its own answer: "no connection of yours has that
    // id" would be a sentence about an id the request never sent, and a coding
    // agent reading it would go looking for a connection nobody named.
    const connectionId = text(said.connection).trim();
    if (connectionId === "") {
      return refuse(
        422,
        "unprocessable",
        "a run is conducted over a connection, and this request named none. " +
          "Send connection with the con_ id of the way Egma should reach the " +
          "agent — registering the agent answered with one.",
      );
    }
    if (!isId("con", connectionId)) {
      return refuse(
        404,
        "not_found",
        `"${connectionId}" is not a connection id. Send the con_ id ` +
          `registering the agent answered with.`,
      );
    }

    const wanted = textList(pinnedIn).map((one) => one.trim());
    if (wanted.length === 0) {
      return refuse(
        422,
        "unprocessable",
        "a run needs at least one test version, because a run with no " +
          "simulations checks nothing. Pin the version_id of each test this " +
          "run should execute.",
      );
    }
    const seen = new Set<string>();
    for (const versionId of wanted) {
      if (seen.has(versionId)) {
        return refuse(
          422,
          "unprocessable",
          `test version ${versionId} is pinned twice on one run. Pin each ` +
            `version once; a run already conducts one simulation per test per ` +
            `persona.`,
        );
      }
      seen.add(versionId);
    }

    const connection = options.connectionById(connectionId);
    if (connection === null) {
      return refuse(
        404,
        "not_found",
        `there is no connection ${connectionId} in this project. Check the id, ` +
          `or read your agents to see how each one is reached.`,
      );
    }
    if (agentId !== "" && agentId !== connection.agentId) {
      return refuse(
        404,
        "not_found",
        `connection ${connectionId} is not on agent ${agentId}. ${NAME_THE_RIGHT_AGENT}`,
      );
    }

    // Refused at creation, in the platform's own words, before a single
    // simulation is written: a run nothing can conduct must never be queued.
    if (!conductable().includes(connection.type)) {
      return refuse(422, "no_adapter", noAdapterMessage(connection.type, conductable()));
    }

    const pinned: PinnedVersion[] = [];
    for (const versionId of wanted) {
      const version = options.versionById(versionId);
      if (version === null) {
        return refuse(
          422,
          "unprocessable",
          `there is no test version ${versionId} on this Egma. Push the test ` +
            `first, or read the test and pin the version_id it names now.`,
        );
      }
      pinned.push(version);
    }

    const asksFor = pinned.reduce((total, one) => total + one.personas.length, 0);
    if (asksFor > MOST_SIMULATIONS_PER_RUN) {
      return refuse(
        422,
        "unprocessable",
        `a run conducts at most ${MOST_SIMULATIONS_PER_RUN} simulations, and ` +
          `these ${pinned.length} versions ask for ${asksFor}. Split the ` +
          `selection across runs.`,
      );
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
            if (run === undefined) return refuse(404, "not_found", NO_SUCH_RUN);
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
        /**
         * Everything that has changed since a point, in order. A cursor rather
         * than a socket: a follower that loses its connection asks again from
         * where it was, so it never misses a change and never sees one twice.
         *
         * `after` is a sequence number this feed issued, and anything else is
         * refused rather than read as zero — silently starting again from the
         * beginning would replay a whole run into a screen that had already
         * drawn it.
         */
        method: "GET",
        path: "/api/runs/:runId/events",
        handle: (request) =>
          behindAKey(request, () => {
            // Digits and nothing else, and answered before the run is looked
            // up: what the query says is answerable without knowing anything,
            // so it is answered first. A follower that crashed is holding a
            // cursor it half-remembers and a run id it may have lost, and
            // telling it the run is gone when the real problem is its cursor
            // sends it to start a fresh run over one that is still going.
            //
            // `Number` would take 0x10, 1e3, 5.0 and a padded " 7 " and quietly
            // answer about a page nobody asked for, while the sentence below
            // promises it would not — so the shape of a sequence number is
            // checked as written rather than as parsed. A parameter that
            // arrived empty is a parameter nobody set.
            const said = given(request.url.searchParams.get("after"));
            const from = said === undefined ? 0 : Number(said);
            if (
              said !== undefined &&
              (!/^\d+$/u.test(said) ||
                !Number.isSafeInteger(from) ||
                from > 2_147_483_647)
            ) {
              return refuse(
                400,
                "invalid_request",
                `"${said}" is not a sequence number this feed issued. Send back ` +
                  `the next an earlier page answered with, or leave after out to ` +
                  `start at the first change.`,
              );
            }

            const run = runById(request.params.runId ?? "");
            if (run === undefined) return refuse(404, "not_found", NO_SUCH_RUN);

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
    noAdapterMessage: (type) => noAdapterMessage(type, conductable()),
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
