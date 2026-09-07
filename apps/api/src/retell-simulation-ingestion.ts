import { resolveRetellSimulationPull, type AuthContext } from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

import { IngestionUnavailableError } from "./ingestion/accept.ts";
import { fileSimulationEvidence } from "./ingestion/simulation-ingestion.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";
import { getRetellCall, type RetellReach } from "./retell/api.ts";
import {
  normaliseRetellCall,
  retellCallDocumentIsComplete,
  type RetellCall,
} from "./retell/normalise.ts";

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
 * ## One immediate attempt, then bounded retries — and never a second filing
 *
 * A record can be *thin*: Retell answered, and the document has no call id, no
 * usable extent, or a transcript that could not be read whole. The spec's answer
 * is one immediate attempt and then bounded retries inside the grading bound.
 *
 * **The retries are of the fetch, never of the filing**, and that is not a
 * preference. A span's identity is `(organization, project, trace, span)` and
 * the Retell normaliser derives its span ids deterministically, so filing a thin
 * document and then filing a fuller one would put *different* normalised
 * evidence under one immutable identity — which ADR-0014 names an integrity
 * error rather than an update. So the fetch is repeated until the document is
 * whole or the attempts run out, and whatever the last attempt held is filed
 * once.
 *
 * **Only the first attempt is awaited.** The caller is the report door, and a
 * simulator is on the other end of it waiting to be told its landing was
 * accepted; a record that arrives whole the first time — every ordinary call —
 * is filed inside that request, and a thin one goes to a background wait that
 * the door never sees. The timer is `unref`'d, so a deployment shutting down
 * loses at most a thin record's improvement rather than holding the process
 * open, and a POV that never landed is a state ADR-0015 §6 already defines.
 *
 * **Nothing here throws at its caller.** Retell being slow, unreachable or thin,
 * and this side being unable to make evidence durable, are all logged through
 * the platform log with the simulation and the reason, and dropped. What Retell
 * owes egma is not the landing's problem.
 */

/** Where the pull asks, and what does the asking — the deployment's own reach. */
export type RetellSimulationPullReach = RetellReach;

/**
 * How long the pull waits before each retry of a thin record, in order.
 *
 * Three attempts over about twenty seconds, which sits inside the thirty-second
 * bound ADR-0015 §6 puts on how long grading waits for an agent's POV. Past that
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
 * Pull one ended Retell simulation's call record and file it under that
 * simulation.
 *
 * `auth` is the conducting context the report door already resolved — the row's
 * own tenancy, built by the claim — because unsealing a connection's credential
 * is a thing only egma's simulator may ask for.
 *
 * Does nothing at all, quietly, for a simulation that is not on the Retell lane
 * or never reported a call id: a lane with no pull is the ordinary case and
 * saying so would be noise on every LiveKit landing.
 *
 * Answers once the first attempt has been made and, where that attempt was
 * enough, once its record is durable. A thin record's retries continue after
 * this resolves.
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
    // bound on one bad socket, and a completion resend deliberately starts no
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
 * One failure, said out loud and dropped.
 *
 * Every path out of the pull comes through here, because the promise this
 * module hands back is one nobody can act on: the report door has already
 * answered, or is about to, and a simulator waiting on a landing is owed
 * nothing about Retell. What an operator needs is the simulation, what was
 * being attempted, and the exception's own class — never its message, which can
 * carry a URL or a local path into a log an operator of somebody else's
 * deployment reads.
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
