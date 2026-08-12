/**
 * The runs on the platform, over egma's public HTTP API.
 *
 * The same seam the tests and the agents sit behind, and it is a seam rather
 * than a convenience: pointing this at a real instance is one address and one
 * key, and nothing in this file, in the follower above it, or in the screen
 * above that knows which egma answered.
 *
 * Three things happen here. A run is started, and the request **pins the
 * versions it will execute** — the whole reason a result from last week still
 * says what it ran. The run is read back, header and simulations together.
 * And the changes since a point are fetched, in order, which is how a terminal
 * follows a run without holding a socket open: a cursor can be asked again
 * from where it was, so a follower never misses a change and never sees one
 * twice.
 *
 * One shape of answer is a value rather than an exception, because it is an
 * ordinary thing that happens: **the platform refusing to start the run**. A
 * connection type whose adapter has not shipped is the case that matters, and
 * the platform's own sentence is carried up untouched — a terminal that
 * paraphrased it would be inventing an explanation for a decision it did not
 * make.
 */

import type { Fetch } from "./device-flow.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";
import { ask, saidBy, text, textList } from "./wire.ts";

/**
 * How far one simulation got.
 *
 * Not a verdict. This says whether there was anything to judge at all; the
 * verdict says what the graders made of it.
 */
export type SimulationStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/**
 * What the graders made of a simulation.
 *
 * Four, and never three: `skipped` and `errored` are their own answers, and a
 * test that could not run is not a test that failed. Nothing in egma folds
 * either of them into `failed`, on a screen or on a line.
 */
export type Verdict = "passed" | "failed" | "skipped" | "errored";

export type RunStatus = "pending" | "running" | "completed" | "canceled";

const SIMULATION_STATUSES: readonly string[] = [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "canceled",
];

const VERDICTS: readonly string[] = ["passed", "failed", "skipped", "errored"];

const RUN_STATUSES: readonly string[] = ["pending", "running", "completed", "canceled"];

/** One test executed once, inside a run. */
export type PlatformSimulation = {
  readonly id: string;
  readonly position: number;
  readonly testName: string;
  readonly testVersionId: string;
  readonly personaName: string;
  readonly status: SimulationStatus;
  readonly verdict: Verdict | null;
  /** What the platform said about how it ended, or `null`. */
  readonly reason: string | null;
};

export type PlatformRun = {
  readonly id: string;
  readonly status: RunStatus;
  readonly agentId: string;
  readonly connectionId: string;
  readonly connectionType: string;
  readonly modality: string;
  /** The versions this run executed against, exactly as they were pinned. */
  readonly testVersionIds: readonly string[];
  readonly expectedSimulationCount: number;
  /** Where a person opens what happened. No token ever rides it. */
  readonly resultsUrl: string;
  readonly simulations: readonly PlatformSimulation[];
};

/** One change to a run, in the order it happened. */
export type RunEvent =
  | {
      readonly kind: "simulation";
      readonly seq: number;
      readonly simulationId: string;
      readonly testName: string;
      readonly personaName: string;
      readonly status: SimulationStatus;
      readonly verdict: Verdict | null;
      readonly reason: string | null;
    }
  | { readonly kind: "run"; readonly seq: number; readonly status: RunStatus };

/** A page of changes, and where to ask from next. */
export type RunEvents = {
  readonly events: readonly RunEvent[];
  readonly next: number;
  /** True once the run itself has finished; there will be no more. */
  readonly done: boolean;
};

/** What starting a run came back with. */
export type StartRunAnswer =
  | { readonly kind: "started"; readonly run: PlatformRun }
  /**
   * The platform would not start it, and said why in its own words. Carried up
   * exactly as it arrived and printed exactly as it is carried.
   */
  | { readonly kind: "refused"; readonly reason: string };

/** What a run is asked for. */
export type NewRun = {
  readonly agentId: string;
  readonly connectionId: string;
  /** The versions to execute, pinned — never "whatever is current then". */
  readonly testVersionIds: readonly string[];
  /** Something to recognise this run by in a list. */
  readonly label?: string;
};

/** A whole number off the wire, or zero for anything that is not one. */
function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * A word off the wire, or the honest fallback for one egma has never heard of.
 *
 * A status this build does not know is not a status it may act on, and
 * guessing at it would be the one thing worse than saying so — so an unknown
 * simulation status reads as `queued` (nothing has happened that this build
 * can describe) and an unknown verdict reads as none at all.
 */
function statusOf(value: unknown): SimulationStatus {
  const said = text(value);
  return (SIMULATION_STATUSES.includes(said) ? said : "queued") as SimulationStatus;
}

function verdictOf(value: unknown): Verdict | null {
  const said = text(value);
  return VERDICTS.includes(said) ? (said as Verdict) : null;
}

function runStatusOf(value: unknown): RunStatus {
  const said = text(value);
  return (RUN_STATUSES.includes(said) ? said : "pending") as RunStatus;
}

function simulationFrom(body: Record<string, unknown>): PlatformSimulation {
  return {
    id: text(body.id),
    position: whole(body.position),
    testName: text(body.test_name),
    testVersionId: text(body.test_version_id),
    personaName: text(body.persona_name),
    status: statusOf(body.status),
    verdict: verdictOf(body.verdict),
    reason: text(body.reason) === "" ? null : text(body.reason),
  };
}

function runFrom(body: Record<string, unknown>): PlatformRun {
  const simulations = Array.isArray(body.simulations) ? body.simulations : [];
  return {
    id: text(body.id),
    status: runStatusOf(body.status),
    agentId: text(body.agent_id),
    connectionId: text(body.connection_id),
    connectionType: text(body.connection_type),
    modality: text(body.modality),
    testVersionIds: textList(body.test_versions),
    expectedSimulationCount: whole(body.expected_simulation_count),
    resultsUrl: text(body.results_url),
    simulations: simulations.flatMap((entry) =>
      typeof entry === "object" && entry !== null
        ? [simulationFrom(entry as Record<string, unknown>)]
        : [],
    ),
  };
}

function eventFrom(body: Record<string, unknown>): RunEvent | null {
  const seq = whole(body.seq);
  if (text(body.kind) === "run") {
    return { kind: "run", seq, status: runStatusOf(body.status) };
  }
  if (text(body.kind) !== "simulation") return null;
  return {
    kind: "simulation",
    seq,
    simulationId: text(body.simulation_id),
    testName: text(body.test_name),
    personaName: text(body.persona_name),
    status: statusOf(body.status),
    verdict: verdictOf(body.verdict),
    reason: text(body.reason) === "" ? null : text(body.reason),
  };
}

/**
 * Start a run, pinning the versions it will execute.
 *
 * A refusal is an answer and not an exception. The one that matters is a
 * connection type egma has no adapter for: it can never be conducted, so it is
 * refused here at creation rather than left queued, and the sentence comes back
 * whole for the terminal to print as it stands.
 */
export async function startRun(
  signedIn: SignedIn,
  input: NewRun,
  fetchImpl?: Fetch,
): Promise<StartRunAnswer> {
  const { response, body } = await ask({
    signedIn,
    path: "/api/runs",
    method: "POST",
    body: {
      agent: input.agentId,
      connection: input.connectionId,
      test_versions: [...input.testVersionIds],
      ...(input.label === undefined ? {} : { label: input.label }),
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  // Everything the platform decided about this run rather than about this
  // request: it will not conduct it, and it said why.
  if (response.status === 422 || response.status === 409) {
    return { kind: "refused", reason: saidBy(body, response.status) };
  }
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

  return { kind: "started", run: runFrom(body) };
}

/** One run as it now stands, header and simulations, or `null`. */
export async function getRun(
  signedIn: SignedIn,
  runId: string,
  fetchImpl?: Fetch,
): Promise<PlatformRun | null> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/runs/${encodeURIComponent(runId)}`,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return runFrom(body);
}

/**
 * One run exactly as the platform describes it, whole and unnarrowed.
 *
 * Everything above reads a run into the handful of fields a terminal draws.
 * This reads the same answer and keeps all of it — the judgments with their
 * rationales, the graders each verdict is attributed to, the mocked world the
 * run was frozen into — because what gets written into the developer's
 * repository is the platform's account of the run and not egma's summary of it.
 * A field this build has never heard of survives the trip for the same reason:
 * dropping it here would mean a repository that silently holds less than the
 * platform said.
 *
 * `null` for a run this key cannot see, which reads the same as one that was
 * never started.
 */
export async function readRunDocument(
  signedIn: SignedIn,
  runId: string,
  options: { readonly fetchImpl?: Fetch; readonly signal?: AbortSignal } = {},
): Promise<Record<string, unknown> | null> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/runs/${encodeURIComponent(runId)}`,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));
  return body;
}

/** Everything that has changed since `after`, in the order it happened. */
export async function runEvents(
  signedIn: SignedIn,
  runId: string,
  after: number,
  options: { readonly fetchImpl?: Fetch; readonly signal?: AbortSignal } = {},
): Promise<RunEvents> {
  const { response, body } = await ask({
    signedIn,
    path: `/api/runs/${encodeURIComponent(runId)}/events?after=${String(after)}`,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) throw new PlatformRefusedError(response.status, saidBy(body, response.status));

  const events = (Array.isArray(body.events) ? body.events : []).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const event = eventFrom(entry as Record<string, unknown>);
    return event === null ? [] : [event];
  });

  return {
    events,
    next: whole(body.next) === 0 ? after : whole(body.next),
    done: body.done === true,
  };
}
