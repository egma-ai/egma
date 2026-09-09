import {
  AGENT_POV_BOUND_SECONDS,
  resolveRetellSimulationPull,
  type AuthContext,
} from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

import { IngestionUnavailableError } from "@egma/ingestion";
import { fileSimulationEvidence } from "./ingestion/simulation-ingestion.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";
import type { RetellReach, RetrievedCall } from "./retell/api.ts";
import {
  pollRetellSimulationCall,
  type RetellSimulationPollOptions,
} from "./retell/poll.ts";
import {
  normaliseRetellCall,
  retellCallHasFinalTranscript,
  type RetellCall,
} from "./retell/normalise.ts";

/**
 * Fetch a completed simulation's Retell transcript through its connection key.
 * Await the first request, then poll in the background for up to four minutes.
 * File only the final usable record, once; incomplete records would prevent a
 * later recovery from using the same stable span IDs. Do not wait for analysis.
 * Background retries are not durable across process shutdown.
 */

export type RetellSimulationPullReach = RetellReach;

export type RetellSimulationPullOptions = Omit<
  RetellSimulationPollOptions,
  "completionReceivedAtMilliseconds"
> & {
  readonly now?: number | undefined;
  readonly fileEvidence?: typeof fileSimulationEvidence | undefined;
  /** Server-owned cross-replica lease release, called after every retry ends. */
  readonly onCollectionFinished?: (() => Promise<void>) | undefined;
};

type CollectorState = {
  readonly collecting: Set<string>;
  readonly active: Set<Promise<void>>;
  readonly accepted: Set<string>;
  closing: boolean;
};

function collectorState(): CollectorState {
  return { collecting: new Set(), active: new Set(), accepted: new Set(), closing: false };
}

/** One default collector for direct callers; servers create a lifecycle-owned one. */
const defaultCollector = collectorState();
/** Records this process already made durable but the trace-store drain may not
 * expose yet. Keep them only through the original evidence deadline. */
function rememberAccepted(state: CollectorState, simulationId: string, until: number): void {
  state.accepted.add(simulationId);
  const timer = setTimeout(
    () => state.accepted.delete(simulationId),
    Math.max(0, until - Date.now()),
  );
  timer.unref();
}

function providerText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

/**
 * The platform agent reference, off the call document itself.
 *
 * Production ingestion reads it off the polling target, because a poll is
 * *about* one selected Retell agent. A simulation has no such target — it has a
 * connection — so the reference comes from the one place that certainly knows
 * it: the record of the conversation that just happened. Each part is preserved
 * where Retell supplied it and left empty where it did not; none is required.
 */
function platformAgentOf(call: RetellCall): {
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
} {
  return {
    platformAgentId: providerText(call["agent_id"]),
    platformAgentName: providerText(call["agent_name"]),
    platformAgentVersion: providerText(call["agent_version"]),
  };
}

/**
 * Pull eligible completed Retell simulations using the report's simulator
 * context. No-op when the resolver finds no pull. Await the first attempt
 * and any immediate filing; incomplete-document retries continue afterward.
 */
export async function pullRetellSimulationRecord(
  auth: AuthContext,
  simulationId: string,
  reach: RetellSimulationPullReach,
  log: FastifyBaseLogger,
  options: RetellSimulationPullOptions = {},
): Promise<void> {
  return trackedPull(defaultCollector, auth, simulationId, reach, log, options);
}

function trackedPull(
  state: CollectorState,
  auth: AuthContext,
  simulationId: string,
  reach: RetellSimulationPullReach,
  log: FastifyBaseLogger,
  options: RetellSimulationPullOptions = {},
): Promise<void> {
  if (state.closing) return Promise.resolve();
  const work = pullWith(state, auth, simulationId, reach, log, options);
  state.active.add(work);
  void work.finally(() => state.active.delete(work));
  return work;
}

async function pullWith(
  state: CollectorState,
  auth: AuthContext,
  simulationId: string,
  reach: RetellSimulationPullReach,
  log: FastifyBaseLogger,
  options: RetellSimulationPullOptions = {},
): Promise<void> {
  const finished = options.onCollectionFinished ?? (async () => undefined);
  if (state.collecting.has(simulationId) || state.accepted.has(simulationId)) {
    await finished();
    return;
  }
  state.collecting.add(simulationId);
  let pull;
  try {
    pull = await resolveRetellSimulationPull(auth, simulationId);
  } catch (cause) {
    state.collecting.delete(simulationId);
    await finished();
    return said(log, simulationId, "the simulation could not be read", cause);
  }
  if (pull === undefined) {
    state.collecting.delete(simulationId);
    await finished();
    return;
  }

  const calls = pollRetellSimulationCall(
    pull.apiKey,
    pull.providerReference,
    {
      ...reach,
      ...(pull.baseUrl === null ? {} : { url: pull.baseUrl }),
    },
    {
      ...options,
      completionReceivedAtMilliseconds: pull.completionReceivedAt.getTime(),
    },
  );

  const file = async (call: RetellCall): Promise<void> => {
    reach.signal?.throwIfAborted();
    const projectId = pull.standing.auth.projectId;
    if (projectId === undefined) {
      // A conducting context is built from the row's own organization and
      // project, so this cannot happen; named rather than asserted away, so a
      // change over there fails one landing's pull instead of the process.
      throw new Error("a simulation's conducting context names no project");
    }
    const normalised = normaliseRetellCall(
      call,
      {
        projectId,
        // A simulation is not production traffic and belongs to no customer
        // environment. The store's own sentinel is what the normaliser writes
        // for evidence that named none.
        environment: null,
        ...platformAgentOf(call),
      },
      options.now ?? Date.now(),
    );
    const fileEvidence = options.fileEvidence ?? fileSimulationEvidence;
    const roots = normalised.spans.filter(
      (span) => span.kind === "conversation" && span.parentSpanId === "",
    );
    const children = normalised.spans.filter((span) => !roots.includes(span));
    reach.signal?.throwIfAborted();
    const acceptedChildren = await fileEvidence([
      { standing: pull.standing, emitter: "agent", spans: children },
    ]);
    if (
      acceptedChildren.accepted !== children.length ||
      acceptedChildren.refused.length > 0
    ) {
      throw new Error("the complete Retell record was refused by evidence ingestion");
    }
    reach.signal?.throwIfAborted();
    const acceptedRoots = await fileEvidence([
      { standing: pull.standing, emitter: "agent", spans: roots },
    ]);
    if (
      acceptedRoots.accepted !== roots.length ||
      acceptedRoots.refused.length > 0
    ) throw new Error("the Retell completion record was refused by evidence ingestion");
  };

  const accept = async (answer: RetrievedCall): Promise<boolean> => {
    if (answer.kind === "call" && retellCallHasFinalTranscript(answer.call)) {
      try {
        await file(answer.call);
      } catch (cause) {
        said(log, simulationId, "the record could not be filed", cause);
        return false;
      }
      rememberAccepted(
        state,
        simulationId,
        pull.completionReceivedAt.getTime() + AGENT_POV_BOUND_SECONDS * 1_000,
      );
      return true;
    }
    if (answer.kind !== "call") {
      log.warn(
        platformEvent(
          "egma.simulation.retell.pull.unavailable",
          "Retell did not answer with the call record of a simulation that ended",
          { simulation_id: simulationId, outcome: answer.kind },
        ),
      );
    }
    return false;
  };

  try {
    const first = await calls.next();
    if (!first.done && await accept(first.value)) {
      await calls.return();
      state.collecting.delete(simulationId);
      await finished();
      return;
    }
  } catch (cause) {
    state.collecting.delete(simulationId);
    await finished();
    return said(log, simulationId, "the first attempt failed", cause);
  }

  const retrying = (async () => {
    try {
      for await (const answer of calls) {
        if (await accept(answer)) return;
      }
      log.warn(
        platformEvent(
          "egma.simulation.retell.pull.incomplete",
          "Retell's final transcript is not available yet; the agent POV is incomplete",
          { simulation_id: simulationId },
        ),
      );
    } catch (cause) {
      said(log, simulationId, "a retry failed", cause);
    } finally {
      state.collecting.delete(simulationId);
      await finished();
    }
  })();
  state.active.add(retrying);
  void retrying.finally(() => state.active.delete(retrying));
}

export type RetellSimulationCollector = {
  readonly pull: typeof pullRetellSimulationRecord;
  settle(): Promise<void>;
};

/** One collector shared by a server's report route and recovery sweep. */
export function createRetellSimulationCollector(): RetellSimulationCollector {
  const state = collectorState();
  return {
    pull: (auth, id, reach, log, options) =>
      trackedPull(state, auth, id, reach, log, options),
    settle: async () => {
      state.closing = true;
      while (state.active.size > 0) {
        await Promise.allSettled([...state.active]);
      }
      state.collecting.clear();
      state.accepted.clear();
    },
  };
}

/**
 * Log the simulation, operation, and exception type. Do not log exception
 * messages, which can contain provider URLs, paths, or other private data.
 */
function said(
  log: FastifyBaseLogger,
  simulationId: string,
  attempting: string,
  cause: unknown,
): void {
  log.warn(
    platformEvent(
      cause instanceof IngestionUnavailableError
        ? "egma.simulation.retell.pull.ingestion.unavailable"
        : "egma.simulation.retell.pull.failed",
      `A Retell simulation's record was not filed: ${attempting}`,
      {
        simulation_id: simulationId,
        exception_type: safeExceptionType(cause),
      },
    ),
  );
}
