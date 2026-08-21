/** Start runs, read their snapshots, and follow their ordered events. */

import { randomUUID } from "node:crypto";

import {
  createRun,
  getRun as getRunRequest,
  listRunEvents,
  type CreateRunResponse,
  type GetRunResponse,
  type ListRunEventsResponse,
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

export type SimulationStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped";

export type Verdict = "passed" | "failed" | "skipped" | "errored";
export type RunStatus = "pending" | "running" | "completed" | "canceled";

export type PlatformSimulation = {
  readonly id: string;
  readonly position: number;
  readonly testName: string;
  readonly testVersionId: string;
  readonly personaName: string;
  readonly status: SimulationStatus;
  readonly verdict: Verdict | null;
  readonly reason: string | null;
};

export type PlatformRun = {
  readonly id: string;
  readonly status: RunStatus;
  readonly agentId: string;
  readonly connectionId: string;
  readonly productLabel: string;
  readonly modality: string;
  readonly testVersionIds: readonly string[];
  readonly expectedSimulationCount: number;
  readonly resultsUrl: string;
  readonly simulations: readonly PlatformSimulation[];
};

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

export type RunEvents = {
  readonly events: readonly RunEvent[];
  readonly next: number;
  readonly done: boolean;
};

export type StartRunAnswer =
  | { readonly kind: "started"; readonly run: PlatformRun }
  | { readonly kind: "refused"; readonly reason: string };

export type NewRun = {
  readonly agentId: string;
  readonly connectionId: string;
  readonly testVersionIds: readonly string[];
  readonly label?: string;
  readonly idempotencyKey?: string;
};

type RunBody = CreateRunResponse | GetRunResponse;

function simulationFrom(
  simulation: RunBody["simulations"][number],
): PlatformSimulation {
  return {
    id: platformText(simulation.id),
    position: simulation.position,
    testName: simulation.testName === null ? "" : platformText(simulation.testName),
    testVersionId:
      simulation.testVersionId === null ? "" : platformText(simulation.testVersionId),
    personaName: platformText(simulation.personaName),
    status: simulation.status,
    verdict: simulation.verdict,
    reason: simulation.reason === null ? null : platformText(simulation.reason),
  };
}

function runFrom(body: RunBody): PlatformRun {
  return {
    id: platformText(body.id),
    status: body.status,
    agentId: platformText(body.agentId),
    connectionId: platformText(body.connectionId),
    productLabel: platformText(body.productLabel),
    modality: body.modality,
    testVersionIds: body.testVersions
      .map(platformText)
      .filter((id) => id !== ""),
    expectedSimulationCount: body.expectedSimulationCount,
    resultsUrl: platformText(body.resultsUrl),
    simulations: body.simulations.map(simulationFrom),
  };
}

function eventFrom(
  event: ListRunEventsResponse["events"][number],
): RunEvent {
  if (event.kind === "run") {
    return { kind: "run", seq: event.seq, status: event.status };
  }
  return {
    kind: "simulation",
    seq: event.seq,
    simulationId: platformText(event.simulationId),
    testName: event.testName === null ? "" : platformText(event.testName),
    personaName: event.personaName === null ? "" : platformText(event.personaName),
    status: event.status,
    verdict: event.verdict,
    reason: event.reason === null ? null : platformText(event.reason),
  };
}

/** Start a run and pin the exact test versions it executes. */
export async function startRun(
  signedIn: SignedIn,
  input: NewRun,
  fetchImpl?: Fetch,
): Promise<StartRunAnswer> {
  const answer = await createRun(
    {
      agentId: input.agentId,
      connectionId: input.connectionId,
      testVersionIds: [...input.testVersionIds],
      idempotencyKey: input.idempotencyKey ?? `run_${randomUUID()}`,
      ...(input.label === undefined ? {} : { label: input.label }),
    },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const response = platformResponse(answer, signedIn.url);
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
  return { kind: "started", run: runFrom(answer.data) };
}

/** One run as it now stands, or null when it does not exist. */
export async function getRun(
  signedIn: SignedIn,
  runId: string,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<PlatformRun | null> {
  const answer = await getRunRequest(
    { runId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 404) return null;
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  return runFrom(answer.data);
}

/** Everything that changed after one event sequence number. */
export async function runEvents(
  signedIn: SignedIn,
  runId: string,
  after: number,
  options: { readonly fetchImpl?: Fetch; readonly signal?: AbortSignal } = {},
): Promise<RunEvents> {
  const answer = await listRunEvents(
    { runId, after },
    {
      client: platformClient(signedIn, options.fetchImpl),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  return {
    events: answer.data.events.map(eventFrom),
    next: answer.data.next === 0 ? after : answer.data.next,
    done: answer.data.done,
  };
}
