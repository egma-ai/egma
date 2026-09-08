import { resolveRetellSimulationPull, type AuthContext } from "@egma/db";
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
};

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
  let pull;
  try {
    pull = await resolveRetellSimulationPull(auth, simulationId);
  } catch (cause) {
    return said(log, simulationId, "the simulation could not be read", cause);
  }
  if (pull === undefined) return;

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
    await fileSimulationEvidence([
      { standing: pull.standing, emitter: "agent", spans: normalised.spans },
    ]);
  };

  const accept = async (answer: RetrievedCall): Promise<boolean> => {
    if (answer.kind === "call" && retellCallHasFinalTranscript(answer.call)) {
      try {
        await file(answer.call);
      } catch (cause) {
        said(log, simulationId, "the record could not be filed", cause);
      }
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
      return;
    }
  } catch (cause) {
    return said(log, simulationId, "the first attempt failed", cause);
  }

  void (async () => {
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
    }
  })();
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
