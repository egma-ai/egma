import { resolveRetellSimulationPull } from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

import { IngestionUnavailableError } from "./ingestion/accept.ts";
import { fileSimulationEvidence } from "./ingestion/simulation-ingestion.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";
import { getRetellCall } from "./retell/api.ts";
import { normaliseRetellCall, type RetellCall } from "./retell/normalise.ts";

/**
 * **The Retell lane's simulation ingestion: a pull, not a push.**
 *
 * LiveKit's agent runs the egma SDK and exports its own spans while the
 * conversation happens. Retell's does not — nothing of egma's runs inside a
 * Retell agent, and there is nothing to install one into. So the agent's POV of
 * a Retell simulation is fetched by egma the moment the conversation ends, with
 * the connection's own stored credential, and filed through the same step every
 * other source goes through (ADR-0015 §2).
 *
 * **Normalised by the normaliser production ingestion already uses.** A Retell
 * call document means the same thing whether the conversation was a simulation
 * or somebody's real traffic, so reading it twice two ways would be two answers
 * to one question. What differs is only where it is filed, and that is the
 * filing step's business: under the simulation's own trace, `emitter = agent`,
 * with the run and version pins off egma's own row.
 *
 * **`call_analysis` is not waited for.** Retell writes its own post-call
 * analysis some seconds after the call ends, and the transcript and the tool
 * calls — the whole of what a transcript reads — are there the moment it does.
 * Waiting for the analysis would hold a simulation's grading open for a block
 * nothing in the product reads yet.
 *
 * **One attempt, and a failure is never the conversation's problem.** The
 * caller is the report door, and a simulator is on the other end of it waiting
 * to be told its landing was accepted. Retell being slow, unreachable or thin
 * is logged and dropped: the record simply says the agent's POV is incomplete,
 * which is the state ADR-0015 §6 already defines for a POV that did not arrive
 * inside the bound, and Regrade is what a late one is picked up by.
 */

/** Where the pull asks, and what does the asking. Substituted in tests. */
export type RetellSimulationPullReach = {
  readonly retellFetch?: typeof fetch | undefined;
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
 * Pull one ended Retell simulation's call record and file it under that
 * simulation.
 *
 * Does nothing at all, quietly, for a simulation that is not on the Retell lane
 * or never reported a call id: a lane with no pull is the ordinary case and
 * saying so would be noise on every LiveKit landing.
 */
export async function pullRetellSimulationRecord(
  simulationId: string,
  reach: RetellSimulationPullReach,
  log: FastifyBaseLogger,
  now: number = Date.now(),
): Promise<void> {
  const pull = await resolveRetellSimulationPull(simulationId);
  if (pull === undefined) return;

  const answered = await getRetellCall(pull.apiKey, pull.providerReference, {
    ...(reach.retellFetch === undefined ? {} : { fetchImpl: reach.retellFetch }),
    ...(pull.baseUrl === null ? {} : { url: pull.baseUrl }),
  });

  if (answered.kind !== "call") {
    log.warn(
      platformEvent(
        "egma.simulation.retell.pull.unavailable",
        "Retell did not answer with the call record of a simulation that ended",
        { simulation_id: simulationId, outcome: answered.kind },
      ),
    );
    return;
  }

  const projectId = pull.standing.auth.projectId;
  if (projectId === undefined) {
    // A conducting context is built from the row's own organization and
    // project, so this cannot happen; named rather than asserted away, so a
    // change over there fails one landing's pull instead of the process.
    throw new Error("a simulation's conducting context names no project");
  }

  const normalised = normaliseRetellCall(
    answered.call,
    {
      projectId,
      // A simulation is not production traffic and belongs to no customer
      // environment. The store's own sentinel is what the normaliser writes for
      // evidence that named none.
      environment: null,
      ...platformAgentOf(answered.call),
    },
    now,
  );

  try {
    await fileSimulationEvidence([
      { standing: pull.standing, emitter: "agent", spans: normalised.spans },
    ]);
  } catch (cause) {
    if (!(cause instanceof IngestionUnavailableError)) throw cause;
    log.warn(
      platformEvent(
        "egma.simulation.retell.pull.ingestion.unavailable",
        "A Retell simulation's record could not be made durable and was not filed",
        {
          simulation_id: simulationId,
          exception_type: safeExceptionType(cause),
        },
      ),
    );
  }
}
