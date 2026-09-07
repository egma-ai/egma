import { resolveRetellSimulationPull, type AuthContext } from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

import { IngestionUnavailableError } from "@egma/ingestion";
import { fileSimulationEvidence } from "./ingestion/simulation-ingestion.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";
import { getRetellCall, type RetellReach } from "./retell/api.ts";
import {
  normaliseRetellCall,
  retellCallDocumentIsComplete,
  type RetellCall,
} from "./retell/normalise.ts";

/**
 * Fetch the agent POV of a completed Retell simulation using its connection
 * credential. Reuse production normalization, then file with simulation
 * attribution and the simulation trace ID.
 *
 * Await the first fetch. Retry missing or incomplete documents in the
 * background with bounded, unreferenced timers. Do not wait for call_analysis.
 * File once per invocation, using the latest fetched document after retries;
 * filing thin and then fuller evidence would conflict under stable span IDs.
 * Log fetch and filing failures without failing the simulation report.
 * Background retries are not durable across process shutdown.
 */

/** Where the pull asks, and what does the asking — the deployment's own reach. */
export type RetellSimulationPullReach = RetellReach;

/**
 * How long the pull waits before each retry of a thin record, in order.
 *
 * Three attempts over about twenty seconds, which sits inside the thirty-second
 * bound ADR-0024 §6 puts on how long grading waits for an agent's POV. Past that
 * bound the record says the POV is incomplete and Regrade is what a late arrival
 * is picked up by, so a fourth attempt would be spending a request on a record
 * nothing is waiting for any more.
 */
const RETRY_WAITS_MILLISECONDS = [5_000, 15_000] as const;

/** Everything about the pull a test needs to move rather than wait out. */
export type RetellSimulationPullOptions = {
  readonly now?: number | undefined;
  /** The waits between attempts. Empty makes the one immediate attempt final. */
  readonly retryWaitsMilliseconds?: readonly number[] | undefined;
  /** How the wait itself happens. The default is an `unref`'d timer. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
};

/** A wait that never holds the process open on its own account. */
function waiting(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
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
  const waits = options.retryWaitsMilliseconds ?? RETRY_WAITS_MILLISECONDS;
  const sleep = options.sleep ?? waiting;

  let pull;
  try {
    pull = await resolveRetellSimulationPull(auth, simulationId);
  } catch (cause) {
    return said(log, simulationId, "the simulation could not be read", cause);
  }
  if (pull === undefined) return;

  const ask = async (): Promise<RetellCall | undefined> => {
    const answered = await getRetellCall(pull.apiKey, pull.providerReference, {
      ...reach,
      ...(pull.baseUrl === null ? {} : { url: pull.baseUrl }),
    });
    if (answered.kind === "call") return answered.call;
    log.warn(
      platformEvent(
        "egma.simulation.retell.pull.unavailable",
        "Retell did not answer with the call record of a simulation that ended",
        { simulation_id: simulationId, outcome: answered.kind },
      ),
    );
    return undefined;
  };

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

  let held: RetellCall | undefined;
  try {
    held = await ask();
  } catch (cause) {
    // **A throw here is the transport, not Retell's answer.** A blip on the
    // first attempt is the exact thing the retries below exist for, so it is
    // said and then carried past — returning here would spend the whole
    // bound on one bad socket, and a terminal report resend deliberately starts no
    // second pull, so this simulation would lose its agent POV for good.
    said(log, simulationId, "the first attempt failed", cause);
  }

  if (held !== undefined && retellCallDocumentIsComplete(held)) {
    // Complete on the first ask: filed once, and never asked again. Evidence
    // is filed once and it is the fetch that retries (ADR-0014's identity
    // rule), so a filing that fails is reported rather than re-attempted.
    try {
      await file(held);
    } catch (cause) {
      said(log, simulationId, "the record could not be filed", cause);
    }
    return;
  }

  if (waits.length === 0) {
    // Nothing more to try. Whatever the one attempt held is what there is, and
    // a document that is merely thin is still evidence.
    if (held === undefined) return;
    try {
      await file(held);
    } catch (cause) {
      said(log, simulationId, "the record could not be filed", cause);
    }
    return;
  }

  // The record was thin, or Retell did not answer. Everything from here runs
  // after the door has answered, and nothing after this point can reach it.
  void (async () => {
    for (const wait of waits) {
      await sleep(wait);
      try {
        const again = await ask();
        if (again !== undefined) held = again;
        if (again !== undefined && retellCallDocumentIsComplete(again)) break;
      } catch (cause) {
        said(log, simulationId, "a retry failed", cause);
      }
    }
    if (held === undefined) {
      log.warn(
        platformEvent(
          "egma.simulation.retell.pull.incomplete",
          "Retell never answered with this simulation's call record; the agent POV is incomplete",
          { simulation_id: simulationId },
        ),
      );
      return;
    }
    try {
      await file(held);
    } catch (cause) {
      said(log, simulationId, "the record could not be filed", cause);
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
