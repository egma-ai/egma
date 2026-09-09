import {
  completeSimulation,
  failSimulation,
  markSimulationCanceled,
  recordOrphanedSimulationExecution,
  resolveSimulationStanding,
  registerSimulationProviderReference,
  startSimulation,
  type CompletedEndingReason,
  type FailedEndingReason,
  type Simulation,
  type SimulationStanding,
  type SimulationSummaryFacts,
} from "@egma/db";
import { reportComplaints } from "@egma/simulation-contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import {
  conflict,
  invalid,
  notFound,
  notTheService,
  unprocessable,
} from "../http/refusals.ts";
import {
  settleOwedMockCleanups,
  type MockedWorldReach,
} from "../mocked-world.ts";
import { platformEvent, safeExceptionType } from "../platform-log.ts";
import {
  pullRetellSimulationRecord,
  type RetellSimulationPullOptions,
  type RetellSimulationPullReach,
} from "../retell-simulation-ingestion.ts";

/**
 * Accept lifecycle reports under the deployment service token, outside
 * organization rate limits. Transcript spans arrive through OTLP separately.
 * Resolve scope and claimedBy from stored simulation state; this shared token
 * does not independently identify which simulator process sent the report.
 *
 * Apply events in order, committing each transition separately. Matching
 * replays succeed; incompatible history returns conflict. If a later event
 * fails, earlier transitions remain committed and can be replayed.
 */

export type ReportRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
  /**
   * What a run's mocked world is torn down through, when a landing was the last
   * one its run was waiting for. Absent leaves the teardown to the next run's
   * sweep, which is the same act.
   */
  readonly mockedWorldReach?: MockedWorldReach | undefined;
  /**
   * Where a Retell simulation's own call record is pulled from once its
   * conversation has ended. Absent leaves the Retell lane with no agent POV,
   * which the record then says — the same state a push that never arrived
   * leaves behind.
   */
  readonly simulationPullReach?: RetellSimulationPullReach | undefined;
  /**
   * How patient the pull is with a thin record. A deployment uses the module's
   * own bounded waits; a suite whose claim is not the waiting shortens them.
   */
  readonly simulationPullOptions?: RetellSimulationPullOptions | undefined;
  readonly pullSimulationRecord?: typeof pullRetellSimulationRecord | undefined;
};

export const REPORTS_PATH = "/v1/simulations/:simulationId/reports";

/** The path one simulation's reports land on — the client's side of the route. */
export function reportPathFor(simulationId: string): string {
  return `/v1/simulations/${simulationId}/reports`;
}

/** One status event, after the contract check has vouched for its shape. */
type StatusEvent = {
  readonly at: string;
  readonly status: "running" | "completed" | "failed" | "canceled";
  readonly reason: string | null;
  readonly facts?: {
    readonly ending: string;
    readonly started_at: string;
    readonly ended_at: string;
    readonly turn_count: number;
    readonly audio: {
      readonly recording: string;
    } | null;
    readonly provider_reference: string | null;
    readonly evidence_error?: "evidence_collection_error" | null;
  };
};

/** The part of an accepted report this route reads. */
type AcceptedReport = {
  readonly simulation_id: string;
  readonly events: readonly StatusEvent[];
};

/**
 * The wire's failed endings, as the row's own vocabulary. The two honest
 * absences keep their names; the wire's `error` is the row's
 * `simulator_error` — same fact, and the row's word for it predates the
 * contract's. Everything else — `orphaned` the sweep's word,
 * `dispatch_failed` the claim path's, and the rest of the platform's own
 * landings — never validates as a document, so it cannot reach this map.
 */
const FAILED_ENDING_OF: Record<
  string,
  Exclude<FailedEndingReason, "orphaned" | "dispatch_failed">
> = {
  agent_never_joined: "agent_never_joined",
  not_answered: "not_answered",
  error: "simulator_error",
  provider_key_unavailable: "provider_key_unavailable",
};

/**
 * Use reported execution times only when coherent. A reversed interval
 * returns undefined so storage can close the lifecycle without inventing
 * measured execution time or discarding the other report facts.
 */
function reportedMoments(facts: {
  readonly started_at: string;
  readonly ended_at: string;
}): { readonly startedAt: Date; readonly endedAt: Date } | undefined {
  const startedAt = new Date(facts.started_at);
  const endedAt = new Date(facts.ended_at);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || endedAt < startedAt) return undefined;
  return { startedAt, endedAt };
}

/** The terminal facts, as the landings take them. */
function summaryFactsOf(event: StatusEvent): SimulationSummaryFacts {
  const facts = event.facts;
  if (facts === undefined) return {};
  return {
    turnCount: facts.turn_count,
    ...(facts.provider_reference === null
      ? {}
      : { providerReference: facts.provider_reference }),
    ...(facts.audio === null
      ? {}
      : { recordingReference: facts.audio.recording }),
    // Incoherent times leave measured execution unknown.
    ...(reportedMoments(facts) ?? {}),
  };
}

/**
 * What the row's terminal state would have to be for this event to be a
 * resend of it: the same status, and the same ending reason — which for a
 * canceled row is no reason at all, because the cancel intent is its own
 * record.
 */
function matchesTerminalRow(
  event: StatusEvent,
  standing: SimulationStanding,
): boolean {
  if (standing.status !== event.status) return false;
  if (event.status === "canceled") return true;
  const ending = event.facts?.ending ?? "";
  const reported =
    event.status === "failed"
      ? FAILED_ENDING_OF[ending]
      : (ending as CompletedEndingReason);
  if (standing.endingReason !== reported) return false;
  // A retained failure sentence is part of the terminal fact. Older rows have
  // none and keep the earlier idempotency rule: same status and ending.
  return event.status !== "failed" ||
    standing.executionFailure === null ||
    standing.executionFailure === event.reason?.trim();
}

/** Where the row stands, said plainly for a refusal that has to name it. */
function standingSentence(standing: SimulationStanding): string {
  return standing.endingReason === null
    ? standing.status
    : `${standing.status} (${standing.endingReason})`;
}

/** The one shape every applied event answers with. */
function landedOn(
  reply: FastifyReply,
  simulationId: string,
  status: string,
): FastifyReply {
  return reply.code(200).send({ simulation_id: simulationId, status });
}

export async function reportRoutes(
  app: FastifyInstance,
  options: ReportRoutesOptions,
): Promise<void> {
  // The gate, as a hook on this scope rather than a line in the route, for
  // the reason the claim door's is one: a route inside this group cannot run
  // unguarded, and an unauthenticated request never has its body read.
  app.addHook("onRequest", async (request, reply) => {
    if (!acceptsServiceToken(request.headers.authorization, options.serviceToken)) {
      return notTheService(reply);
    }
    return undefined;
  });

  // Acknowledged before the simulator creates or dispatches the room. The
  // service token authenticates the sender; the active claim authorizes the
  // row, and the stored reference remains the project-key ingest lookup key.
  app.post("/v1/simulations/:simulationId/provider-reference", async (request, reply) => {
    const { simulationId } = request.params as { simulationId: string };
    const body = request.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "claimant" && key !== "provider_reference") ||
      typeof body.claimant !== "string" || body.claimant.trim() === "" || body.claimant.length > 200 ||
      typeof body.provider_reference !== "string" || body.provider_reference.length > 512 ||
      !/^egma-sim-(?:chat-)?[A-Za-z0-9_-]+$/.test(body.provider_reference)) {
      return invalid(reply, "Room registration requires a claimant and a non-empty Egma LiveKit room name.");
    }
    const standing = await resolveSimulationStanding(simulationId);
    if (standing === undefined) {
      return conflict(reply, "This active LiveKit claim cannot register that room reference.");
    }
    const registered = await registerSimulationProviderReference(standing.auth, {
      simulationId,
      claimant: body.claimant.trim(),
      providerReference: body.provider_reference,
    });
    if (!registered) {
      return conflict(reply, "This active LiveKit claim cannot register that room reference.");
    }
    return reply.send({ simulation_id: simulationId, provider_reference: body.provider_reference });
  });

  /**
   * One report document about one simulation: `status` events apply as
   * lifecycle transitions, in order, and the answer names where the row
   * stands after the last of them.
   */
  app.post(REPORTS_PATH, async (request, reply) => {
    const { simulationId } = request.params as { simulationId: string };
    const document: unknown = request.body ?? {};

    // The contract check first, before a byte of the document is believed —
    // the same schema the simulator compiled before sending, so the
    // complaints going back are the ones its own check would have raised.
    // This is also where the reportable vocabulary is held: an ending that
    // is the platform's own word (`orphaned` is the sweep's, and the claim
    // path lands its own failures) is not in the schema's enums and refuses
    // here as a document, never reasoned about as a state.
    const complaints = reportComplaints(document);
    if (complaints.length > 0) {
      return invalid(
        reply,
        `this is not a simulation report the contract accepts: ` +
          `${complaints.join("; ")}. Fix the document against the report ` +
          `schema, contract version 1; resending the same bytes cannot help.`,
      );
    }

    // SAFETY: reportComplaints accepted this value against the closed report
    // schema, which requires simulation_id and permits only status events.
    const report = document as AcceptedReport;

    // A document about another simulation is refused, not rerouted: the URL
    // and the document each name the simulation, and when they disagree
    // there is no honest way to pick one.
    if (report.simulation_id !== simulationId) {
      return invalid(
        reply,
        `this document says it is about ${report.simulation_id}, ` +
          `but it was posted to ${simulationId}. Post each report to the ` +
          `simulation its own simulation_id names.`,
      );
    }

    const standing = await resolveSimulationStanding(simulationId);
    if (standing === undefined) {
      return notFound(
        reply,
        `there is no simulation ${simulationId} on this Egma instance. Reports land ` +
          `on the simulation a claimed spec named in its simulation_id; ` +
          `nothing about this document can be retried.`,
      );
    }

    let lastKnownStatus: string = standing.status;

    // Every event here is a lifecycle transition, because the contract check
    // above has already refused anything else: a conversation's turns, tool
    // calls and measurements arrive as spans at the OTLP door, and a report
    // claiming to carry one does not validate.
    // Pull once for a new terminal transition, including a call whose media
    // failed. An absorbed resend must not fetch and file the call again.
    let endedNow = false;
    for (const event of report.events) {
      const applied = await applyStatusEvent(reply, simulationId, event);
      if (!("status" in applied)) return applied;
      lastKnownStatus = applied.status;
      endedNow ||=
        applied.moved &&
        (applied.status === "completed" ||
          applied.status === "failed" ||
          applied.status === "canceled");
    }

    /*
     * Pull Retell agent evidence when a report moves the simulation to completed,
     * failed, or canceled. Replays must not fetch changed evidence under the same
     * span IDs. Await the first attempt; incomplete documents retry in the
     * background. Log pull failures without failing report acceptance.
     */
    if (options.simulationPullReach !== undefined && endedNow) {
      await (options.pullSimulationRecord ?? pullRetellSimulationRecord)(
        standing.auth,
        simulationId,
        options.simulationPullReach,
        request.log,
        options.simulationPullOptions ?? {},
      ).catch((cause: unknown) => {
        request.log.warn(
          platformEvent(
            "egma.simulation.retell.pull.failed",
            "A Retell simulation's record was not filed after its landing",
            {
              simulation_id: simulationId,
              exception_type: safeExceptionType(cause),
            },
          ),
        );
      });
    }

    // Attempt owed mock cleanup after terminal reports. The shared sweep skips
    // active runs and can retry unfinished cleanup before a later build.
    // Cleanup failure does not change the simulation report response.
    if (
      options.mockedWorldReach !== undefined &&
      (lastKnownStatus === "completed" ||
        lastKnownStatus === "failed" ||
        lastKnownStatus === "canceled")
    ) {
      await settleOwedMockCleanups(
        standing.auth,
        standing.agentId,
        options.mockedWorldReach,
        request.log,
      ).catch(() => undefined);
    }

    return landedOn(reply, simulationId, lastKnownStatus);
  });
}

/**
 * Apply one event against freshly read state and distinguish a transition
 * from an absorbed replay. Reread per event because earlier events commit
 * independently.
 */
/**
 * What one status event did to the row: where it stands afterwards, and
 * whether **this** document is what moved it there.
 *
 * The second half exists because an at-least-once reporter resends, and an
 * absorbed resend answers the same status as the transition it repeats. Every
 * effect that must happen once per conversation — the Retell pull below is the
 * first — has to tell the two apart, and reading the status alone cannot.
 */
type Applied = {
  readonly status: string;
  /** True only where a guarded transition in this request moved the row. */
  readonly moved: boolean;
};

/** This document moved the row. */
function moved(status: string): Applied {
  return { status, moved: true };
}

/** The row already said this; the resend is absorbed. */
function absorbed(status: string): Applied {
  return { status, moved: false };
}

async function applyStatusEvent(
  reply: FastifyReply,
  simulationId: string,
  event: StatusEvent,
): Promise<FastifyReply | Applied> {
  const standing = await resolveSimulationStanding(simulationId);
  if (standing === undefined) {
    // It answered moments ago and is gone: the run was deleted mid-request.
    return notFound(
      reply,
        `simulation ${simulationId} is gone from this Egma instance; there is nothing ` +
        `left to report against.`,
    );
  }

  return event.status === "running"
    ? applyRunning(reply, standing, event)
    : applyTerminal(reply, standing, event);
}

/**
 * `running` — the conversation is underway. The claimant argument on the
 * transition is the row's own `claimed_by`: the token gated the door, and
 * the row names its conductor, so there is nothing in the request a caller
 * could use to speak for somebody else's conversation.
 */
async function applyRunning(
  reply: FastifyReply,
  standing: SimulationStanding,
  event: StatusEvent,
): Promise<FastifyReply | Applied> {
  // The duplicate the at-least-once client is owed: already running is what
  // this event says, so it is absorbed rather than refused.
  if (standing.status === "running") return absorbed("running");
  if (standing.status === "failed" && standing.endingReason === "orphaned") {
    return recoverOrphanedStart(reply, standing, event);
  }

  if (standing.status === "claimed" && standing.claimedBy !== null) {
    const started = await startSimulation(
      standing.auth,
      standing.id,
      standing.claimedBy,
    );
    if (started !== undefined) return moved(started.status);
    // The guarded update matched nothing, so the row moved between the read
    // and the write — a duplicate racing this one, or the sweep. Read again
    // and answer as the first read would have, one race later.
    const since = await resolveSimulationStanding(standing.id);
    if (since?.status === "running") return absorbed("running");
    if (since?.status === "failed" && since.endingReason === "orphaned") return recoverOrphanedStart(reply, since, event);
    return refusedByTheRecord(reply, since ?? standing, "running");
  }

  return refusedByTheRecord(reply, standing, "running");
}

/**
 * The terminal three — the landing, with the facts mapped in. A resend
 * matching the row's terminal state is absorbed; a document that would
 * rewrite a terminal row is refused; a `canceled` nobody asked for fails
 * the landing's own guard and is refused honestly rather than recorded —
 * and a `canceled` whose intent landed between the attempt and the answer
 * is retried once rather than refused for being early.
 */
async function applyTerminal(
  reply: FastifyReply,
  standing: SimulationStanding,
  event: StatusEvent,
): Promise<FastifyReply | Applied> {
  if (standing.status === "failed" && standing.endingReason === "orphaned") {
    return recoverOrphanedFacts(reply, standing, event);
  }
  // A terminal row answers from what it already says: the matching resend
  // is absorbed, anything else is a document trying to rewrite the record.
  if (
    standing.status === "completed" ||
    standing.status === "failed" ||
    standing.status === "canceled"
  ) {
    if (matchesTerminalRow(event, standing)) return absorbed(standing.status);
    return refusedByTheRecord(reply, standing, event.status);
  }

  const facts = event.facts;
  if (facts === undefined || standing.claimedBy === null) {
    // No facts cannot happen on a validated document; unclaimed means the
    // conversation was never anybody's to land.
    return refusedByTheRecord(reply, standing, event.status);
  }

  // The row knows its modality and refuses audio on a chat — said here in a
  // sentence rather than surfacing as the database constraint it would trip.
  if (facts.audio !== null && standing.modality === "chat") {
    return unprocessable(
      reply,
      `simulation ${standing.id} is a chat conversation, and a chat has no ` +
        `audio to measure. Send audio: null, the way the chat fixtures do.`,
    );
  }

  // Lifecycle closure can be recorded even when measured time is unknown.
  if (reportedMoments(facts) === undefined) {
    reply.log.warn(
      {
        simulationId: standing.id,
        reportedStartedAt: facts.started_at,
        reportedEndedAt: facts.ended_at,
      },
      `simulation ${standing.id} reported ended_at before started_at; ` +
        `recording lifecycle closure without measured execution time`,
    );
  }

  const landed = await applyLanding(standing, event, facts.ending);
  if (landed !== undefined) return moved(landed.status);

  // The guarded landing matched nothing. Either a duplicate raced this
  // request and the row now says what this document says — absorbed — or
  // the record genuinely disagrees, and the freshest reading names how.
  const since = await resolveSimulationStanding(standing.id);
  if (since?.status === "failed" && since.endingReason === "orphaned") {
    return recoverOrphanedFacts(reply, since, event);
  }
  if (since !== undefined && matchesTerminalRow(event, since)) {
    return absorbed(since.status);
  }
  // A cancel that raced this document: at the attempt the intent was not
  // yet stamped, and by this read it is — the guard's refusal is stale, not
  // final. One bounded retry lands the transition that is valid at the
  // moment this request answers; a second failure means the row moved
  // again, and the freshest reading below says where it went. The route
  // serves the contract here, not today's runtime — the shipped simulator
  // cancels only after a directive, which implies the intent was already
  // stamped, but nothing entitles this door to assume its caller.
  if (
    event.status === "canceled" &&
    since !== undefined &&
    (since.status === "claimed" || since.status === "running") &&
    since.cancelRequestedAt !== null
  ) {
    const relanded = await applyLanding(since, event, facts.ending);
    if (relanded !== undefined) return moved(relanded.status);
    const settled = await resolveSimulationStanding(standing.id);
    if (settled !== undefined && matchesTerminalRow(event, settled)) {
      return absorbed(settled.status);
    }
    return refusedByTheRecord(reply, settled ?? since, event.status);
  }
  if (event.status === "canceled" && since?.cancelRequestedAt === null) {
    return conflict(
      reply,
      `nobody asked to cancel simulation ${standing.id}: no cancellation ` +
        `was ever requested, so a canceled report would invent a stop order ` +
        `the record does not hold. If the conversation could not continue, ` +
        `report it failed with its honest reason.`,
    );
  }
  return refusedByTheRecord(reply, since ?? standing, event.status);
}

/** A separate late running document retains proof needed by its terminal report. */
async function recoverOrphanedStart(
  reply: FastifyReply,
  standing: SimulationStanding,
  event: StatusEvent,
): Promise<FastifyReply | Applied> {
  if (standing.claimedBy === null || standing.claimedAt === null) {
    return refusedByTheRecord(reply, standing, event.status);
  }
  await recordOrphanedSimulationExecution(
    standing.auth, standing.id, standing.claimedBy, standing.claimedAt,
    { startedAt: new Date(event.at) },
  );
  return absorbed("failed");
}

/** Late facts can establish measured usage, but cannot undo an orphan sweep. */
async function recoverOrphanedFacts(
  reply: FastifyReply,
  standing: SimulationStanding,
  event: StatusEvent,
): Promise<FastifyReply | Applied> {
  const facts = event.facts;
  if (facts === undefined || standing.claimedBy === null || standing.claimedAt === null) {
    return refusedByTheRecord(reply, standing, event.status);
  }
  if (facts.audio !== null && standing.modality === "chat") {
    return unprocessable(reply, "A chat has no recording. Send audio: null with its terminal facts.");
  }
  const moments = reportedMoments(facts);
  if (moments !== undefined) {
    await recordOrphanedSimulationExecution(
      standing.auth, standing.id, standing.claimedBy, standing.claimedAt,
      { ...summaryFactsOf(event), ...moments },
    );
  }
  return absorbed("failed");
}

/** The landing itself, chosen by the event's status. */
async function applyLanding(
  standing: SimulationStanding,
  event: StatusEvent,
  ending: string,
): Promise<Simulation | undefined> {
  const conductor = standing.claimedBy ?? "";
  const facts = summaryFactsOf(event);

  if (event.status === "completed") {
    return completeSimulation(standing.auth, standing.id, conductor, {
      endingReason: ending as CompletedEndingReason,
      ...(event.facts?.evidence_error === "evidence_collection_error"
        ? { evidenceError: event.facts.evidence_error }
        : {}),
      ...facts,
    });
  }
  if (event.status === "failed") {
    const reason = FAILED_ENDING_OF[ending];
    if (reason === undefined) {
      // Unreachable past the contract check; named rather than asserted so
      // a schema drift fails a request, never the process.
      throw new Error(`"${ending}" is not a failed ending the wire carries`);
    }
    if (event.reason === null) {
      // Unreachable after the closed report schema, but kept at the trust
      // boundary so a schema drift never writes a failure nobody can act on.
      throw new Error("a failed simulation report has no execution failure message");
    }
    return failSimulation(standing.auth, standing.id, conductor, {
      reason,
      message: event.reason,
      ...facts,
    });
  }
  return markSimulationCanceled(standing.auth, standing.id, conductor, facts);
}

/**
 * The record's answer when a document and the row disagree: where the row
 * stands, what the document claimed, and that resending cannot help — the
 * client treats this refusal as final and keeps its write-ahead log, which
 * is exactly the honest outcome for a disagreement about history. Three
 * standings disagree three different ways, and each is told its own way.
 */
function refusedByTheRecord(
  reply: FastifyReply,
  standing: SimulationStanding,
  said: string,
): FastifyReply {
  if (standing.status === "queued") {
    return conflict(
      reply,
      `simulation ${standing.id} is queued and nothing has claimed it, so ` +
        `there is no conductor this ${said} report could speak for. Work ` +
        `is claimed through POST /v1/claims before anything about it is ` +
        `reported.`,
    );
  }
  if (standing.status === "claimed" && said !== "running") {
    return conflict(
      reply,
      `simulation ${standing.id} is claimed and never reported running, so ` +
        `a ${said} landing has no conversation under it. Report running ` +
        `first; a conversation lands from the state the record says it was in.`,
    );
  }
  return conflict(
    reply,
    `simulation ${standing.id} is ${standingSentence(standing)}, and this ` +
      `document says ${said} — the record is not rewritten by a later ` +
      `report. Resending the same document cannot help; the write-ahead log ` +
      `is the simulator's own record of what it saw.`,
  );
}
