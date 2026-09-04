/**
 * The runs on the platform, over egma's public HTTP API.
 *
 * A complete-suite Run is created with an optional exact current-set
 * precondition, or canceled by ID. Simulation pages remain available to other
 * repository contract checks, but the CLI does not follow a Run in the
 * terminal. The web product owns progress.
 *
 * One shape of answer is a value rather than an exception, because it is an
 * ordinary thing that happens: **the platform refusing to start the run**. A
 * connection type whose adapter has not shipped is the case that matters, and
 * the platform's own sentence is carried up untouched — a terminal that
 * paraphrased it would be inventing an explanation for a decision it did not
 * make.
 */

import { randomUUID } from "node:crypto";

import {
  cancelRun as cancelRunRequest,
  createRun as createRunRequest,
  listRunSimulations as listRunSimulationsRequest,
  type CancelRunResponse,
  type CreateRunResponse,
  type ListRunSimulationsResponse,
} from "@egma/platform-api/client";

import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "./client.ts";
import type { Fetch } from "./device-flow.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";

/**
 * How far one simulation got.
 *
 * This says how far execution got. Grading starts only after a completed trace.
 */
export type SimulationStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** Operational state of all grading work for one completed trace. */
export type GradingState =
  | "not_requested"
  | "pending"
  | "running"
  | "complete"
  | "error";

export type RunStatus = "pending" | "running" | "completed" | "canceled";

const SIMULATION_STATUSES: readonly string[] = [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "canceled",
];

const GRADING_STATES: readonly string[] = [
  "not_requested",
  "pending",
  "running",
  "complete",
  "error",
];

const RUN_STATUSES: readonly string[] = ["pending", "running", "completed", "canceled"];

/** One test executed once, inside a run. */
export type PlatformSimulation = {
  readonly id: string;
  readonly position: number;
  readonly testName: string;
  readonly testVersionId: string;
  readonly personaName: string;
  readonly status: SimulationStatus;
  /** Null until a completed trace has grading work to report. */
  readonly gradingState: GradingState | null;
  /** What the platform said about how it ended, or `null`. */
  readonly reason: string | null;
};

export type PlatformRun = {
  readonly id: string;
  readonly status: RunStatus;
  readonly agentId: string;
  readonly connectionId: string;
  /**
   * The lane this run is over, in the record's own word for it.
   *
   * On the answer to the start itself, so a terminal can say what a run reaches
   * without asking anything else: the committed folder names a connection by id
   * and name only, and a name is what a person chose to call it, not what it
   * does.
   */
  readonly connectionType: string;
  readonly productLabel: string;
  readonly modality: string;
  readonly expectedSimulationCount: number;
  /** Where a person opens what happened. No token ever rides it. */
  readonly resultsUrl: string;
  readonly simulations: readonly PlatformSimulation[];
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
  readonly projectId: string;
  readonly suiteId: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** Optimistic precondition for every test in the selected suite. */
  readonly expectedTestVersions: readonly {
    readonly testId: string;
    readonly versionId: string;
  }[];
  /** Optional run display name. */
  readonly name?: string;
  /**
   * The word this attempt is remembered by, so a retried request starts one
   * run.
   *
   * Left out, one is minted for this call. A terminal that dials a real agent
   * and loses the answer on the way back must never produce a second
   * conversation, and the platform can only prevent that if the client names
   * the attempt — nothing on the server can tell a repeat from a new request.
   * A caller that retries the same start itself passes the same word twice.
   */
  readonly idempotencyKey?: string;
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
 * can describe) and an unknown grading state reads as none at all.
 */
function statusOf(value: unknown): SimulationStatus {
  const said = platformText(value);
  return (SIMULATION_STATUSES.includes(said) ? said : "queued") as SimulationStatus;
}

function gradingStateOf(value: unknown): GradingState | null {
  const said = platformText(value);
  return GRADING_STATES.includes(said) ? (said as GradingState) : null;
}

function runStatusOf(value: unknown): RunStatus {
  const said = platformText(value);
  return (RUN_STATUSES.includes(said) ? said : "pending") as RunStatus;
}

function confirmsStartedRun(body: RunWire, input: NewRun): boolean {
  return (
    platformText(body.id) !== "" &&
    platformText(body.projectId) === input.projectId &&
    platformText(body.suiteId) === input.suiteId &&
    platformText(body.agentId) === input.agentId &&
    platformText(body.connectionId) === input.connectionId &&
    RUN_STATUSES.includes(platformText(body.status))
  );
}

function confirmsCanceledRun(body: RunWire, runId: string): boolean {
  return platformText(body.id) === runId && platformText(body.status) === "canceled";
}

type SimulationWire = ListRunSimulationsResponse["simulations"][number];
type RunWire = CancelRunResponse | CreateRunResponse;

function simulationFrom(body: SimulationWire): PlatformSimulation {
  return {
    id: platformText(body.id),
    position: whole(body.position),
    testName: platformText(body.testName),
    testVersionId: platformText(body.testVersionId),
    personaName: platformText(body.personaName),
    status: statusOf(body.status),
    gradingState: gradingStateOf(body.gradingState),
    reason:
      platformText(body.reason) === "" ? null : platformText(body.reason),
  };
}

function runFrom(body: RunWire): PlatformRun {
  return {
    id: platformText(body.id),
    status: runStatusOf(body.status),
    agentId: platformText(body.agentId),
    connectionId: platformText(body.connectionId),
    connectionType: platformText(body.connectionType),
    productLabel: platformText(body.productLabel),
    modality: platformText(body.modality),
    expectedSimulationCount: whole(body.expectedSimulationCount),
    resultsUrl: platformText(body.resultsUrl),
    // Run start/detail is deliberately bounded. Simulations have their own
    // paged resource and callers hydrate them explicitly.
    simulations: [],
  };
}

/** Read the run's simulations through the separate bounded page contract. */
export async function listRunSimulations(
  signedIn: SignedIn,
  runId: string,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<readonly PlatformSimulation[]> {
  const simulations: PlatformSimulation[] = [];
  const client = platformClient(signedIn, fetchImpl);
  let pageToken: string | undefined;
  for (;;) {
    const answer = await listRunSimulationsRequest(
      {
        runId,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      {
        client,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const response = platformResponse(answer, signedIn.url);
    if (!response.ok) {
      throw new PlatformRefusedError(
        response.status,
        platformRefusalMessage(answer.error, response.status),
      );
    }
    for (const value of answer.data?.simulations ?? []) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformRefusedError(
          response.status,
          "Egma answered with a simulation this CLI cannot read.",
        );
      }
      simulations.push(simulationFrom(value));
    }
    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") return simulations;
    pageToken = next;
  }
}

/**
 * Start one complete-suite run with an optional exact-set precondition.
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
  signal?: AbortSignal,
): Promise<StartRunAnswer> {
  const answer = await createRunRequest(
    {
      suiteId: input.suiteId,
      projectId: input.projectId,
      agentId: input.agentId,
      connectionId: input.connectionId,
      expectedTestVersions: input.expectedTestVersions.map((version) => ({
        testId: version.testId,
        versionId: version.versionId,
      })),
      // Node's own, deliberately, and not `newId` from `@egma/ids`. That
      // package is private and never published, so an import of it survives
      // into `dist/` — which this package ships unbundled — and `egma`
      // would fail to resolve it at the moment somebody started a run. The
      // build caught it here only because nothing built the package first; the
      // published crash would have had no such warning.
      //
      // Nothing wants an egma-shaped id anyway. A key has one job: to be
      // different from every other invocation's, so a retry of *this* start is
      // told apart from a new one.
      idempotencyKey: input.idempotencyKey ?? `run_${randomUUID()}`,
      ...(input.name === undefined ? {} : { name: input.name }),
    },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);

  // Everything the platform decided about this run rather than about this
  // request: it will not conduct it, and it said why.
  if (response.status === 422 || response.status === 409) {
    return {
      kind: "refused",
      reason: platformRefusalMessage(answer.error, response.status),
    };
  }
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }

  if (!confirmsStartedRun(answer.data, input)) {
    return {
      kind: "refused",
      reason:
        "Egma answered without confirming the Run it created. Check the Runs page before you try again.",
    };
  }

  return {
    kind: "started",
    run: runFrom(answer.data),
  };
}

/** What the platform answered when one Run cancellation was requested. */
export type CancelRunAnswer =
  | { readonly kind: "canceled"; readonly run: PlatformRun }
  | { readonly kind: "not-found"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Cancel one Run through the public Run resource endpoint. */
export async function cancelRun(
  signedIn: SignedIn,
  input: {
    readonly runId: string;
    readonly projectId: string;
  },
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<CancelRunAnswer> {
  const answer = await cancelRunRequest(
    { runId: input.runId, projectId: input.projectId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);

  if (response.status === 404) {
    return {
      kind: "not-found",
      reason: platformRefusalMessage(answer.error, 404),
    };
  }
  if (response.status === 409 || response.status === 422) {
    return {
      kind: "refused",
      reason: platformRefusalMessage(answer.error, response.status),
    };
  }
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }

  if (!confirmsCanceledRun(answer.data, input.runId)) {
    return {
      kind: "refused",
      reason: `Egma answered without confirming that it canceled Run ${input.runId}. Check the Runs page before you try again.`,
    };
  }

  return { kind: "canceled", run: runFrom(answer.data) };
}
