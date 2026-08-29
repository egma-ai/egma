import {
  completeSimulation,
  failSimulation,
  markSimulationCanceled,
  resolveSimulationStanding,
  startSimulation,
  type CompletedEndingReason,
  type FailedEndingReason,
  type MockToolCoverage,
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

/**
 * The report door: `POST /v1/simulations/:simulationId/reports`, where the
 * simulator says what happened — the lifecycle landing, and only that. What
 * was said in the conversation arrives at the OTLP ingest as spans and never
 * here, which the contract holds rather than this route: a document carrying
 * a turn does not validate, so there is no second record of one conversation
 * for two readers to disagree about.
 *
 * It sits with the claim door on the claim door's exact terms: the service
 * token is the whole gate and resolves to nothing, and the group is outside
 * the per-organization rate limit because the caller is egma's own service
 * standing behind every organization at once. What is different here is
 * where authority over each row comes from. **The token gates the door, and
 * the row names its conductor**: every write below is made under a context
 * derived from the row's own tenancy, in the name of the row's own
 * `claimed_by` — never in the name of anything the request said — so the one
 * secret a simulator holds decides only whether it may knock, and which
 * conversations it speaks for was decided when each row was claimed.
 *
 * **Idempotency without a ledger.** The client delivers at least once and
 * resends byte-identically, so this door must absorb what it has already
 * heard: a `running` for a row already running answers 200, a terminal event
 * matching the row's terminal state answers 200, and only a document that
 * would *rewrite* the record — a different ending, a different terminal
 * status, a running for a finished conversation — is refused with 409. No
 * table of seen event ids exists, on purpose: the row's own state says
 * everything a duplicate check needs, and a ledger would be a second record
 * to keep honest.
 *
 * The shipped simulator posts one event per document; the contract permits
 * several, and they apply in order. Each application commits by itself, so a
 * refusal partway leaves the earlier, valid transitions standing — exactly
 * what a resend of the same document then absorbs as duplicates.
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
};

export const REPORTS_PATH = "/v1/simulations/:simulationId/reports";

/** The path one simulation's reports land on — the client's side of the route. */
export function reportPathFor(simulationId: string): string {
  return `/v1/simulations/${simulationId}/reports`;
}

/** One status event, after the contract check has vouched for its shape. */
type StatusEvent = {
  readonly status: "running" | "completed" | "failed" | "canceled";
  readonly facts?: {
    readonly ending: string;
    readonly started_at: string;
    readonly ended_at: string;
    readonly turn_count: number;
    readonly audio: {
      readonly recording: string;
    } | null;
    readonly provider_reference: string | null;
    /**
     * The one terminal fact that may be omitted, and the only one whose
     * absence is itself a sentence: the agent was never asked what tools it
     * has, so nothing was learned and nothing is claimed.
     */
    readonly mock_tool_coverage?: {
      readonly discovered: readonly string[];
      readonly covered: readonly string[];
      readonly uncovered: readonly string[];
    };
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
};

/**
 * The reported moments, trusted exactly when they can be true.
 *
 * A landing given the conduction's own moments writes them over its server
 * stamps, so a retried report cannot stretch the record — but a document
 * whose `ended_at` precedes its `started_at` describes an interval that
 * never existed on any clock, and writing it verbatim would put an
 * impossible duration on the row forever. Refusing the document would be
 * worse: the reporter treats a final refusal as final, and punishing
 * delivery for a skewed clock would turn a truthful conversation into a
 * sweep's false orphan. So an incoherent pair is answered with `undefined`,
 * the landing falls back to its own server stamps for both moments, and the
 * caller logs the pair it declined to believe.
 */
function reportedMoments(facts: {
  readonly started_at: string;
  readonly ended_at: string;
}): { readonly startedAt: Date; readonly endedAt: Date } | undefined {
  const startedAt = new Date(facts.started_at);
  const endedAt = new Date(facts.ended_at);
  if (endedAt.getTime() < startedAt.getTime()) return undefined;
  return { startedAt, endedAt };
}

/**
 * The stamp this landing writes: what the conductor reported, and nothing
 * added to it.
 *
 * **One writer, deliberately.** A simulator that stands in the tool path — the
 * LiveKit in-room seam — reports the three lists, because there the agent
 * declares its tools per conversation and two simulations of one run can
 * honestly differ. Every other lane reports none, and the stamp is left off,
 * which is the report saying nobody was ever asked — a different sentence from
 * three empty lists. The Retell lanes decide what they answer for once per run
 * and mark each answered call on the transcript, so a per-simulation copy would
 * be a second version of a fact that cannot differ.
 */
function coverageOf(
  facts: NonNullable<StatusEvent["facts"]>,
): MockToolCoverage | undefined {
  return facts.mock_tool_coverage;
}

/** The terminal facts, as the landings take them. */
function summaryFactsOf(event: StatusEvent): SimulationSummaryFacts {
  const facts = event.facts;
  if (facts === undefined) return {};
  const coverage = coverageOf(facts);
  return {
    turnCount: facts.turn_count,
    ...(facts.provider_reference === null
      ? {}
      : { providerReference: facts.provider_reference }),
    ...(facts.audio === null
      ? {}
      : { recordingReference: facts.audio.recording }),
    ...(coverage === undefined ? {} : { mockToolCoverage: coverage }),
    // Absent when incoherent, so the landing's own stamps stand for both.
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
  return standing.endingReason === reported;
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
    for (const event of report.events) {
      const applied = await applyStatusEvent(reply, simulationId, event);
      if (typeof applied !== "string") return applied;
      lastKnownStatus = applied;
    }

    // The teardown, when this document may have been the last thing a mocked
    // run was waiting for.
    //
    // It settles only runs that have **finished**, so this is a cheap read for
    // every landing and a delete plus a restore exactly once per mocked run.
    // Nothing depends on it happening here: a run whose teardown never ran —
    // because this deployment restarted, or because the platform was away — is
    // finished by the next run's sweep, which is the same act in the same
    // order. That is why a failure here is logged rather than answered: the
    // simulator is waiting on a report about a conversation, and what Egma owes
    // somebody's Retell account is not that conversation's problem.
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
 * One status event against the row as it now stands: the transition when the
 * row is there to move, a 200-worthy nothing when the row already says what
 * the event says, and a refusal when the document and the record disagree
 * about history. Answers the row's status afterwards, or the refusal it sent.
 *
 * The row is re-read per event rather than once per document, because each
 * event's application moves it and the next event's duplicate check must see
 * where it landed. Each read is one indexed select; a document carries a
 * handful of events at most.
 */
async function applyStatusEvent(
  reply: FastifyReply,
  simulationId: string,
  event: StatusEvent,
): Promise<FastifyReply | string> {
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
    ? applyRunning(reply, standing)
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
): Promise<FastifyReply | string> {
  // The duplicate the at-least-once client is owed: already running is what
  // this event says, so it is absorbed rather than refused.
  if (standing.status === "running") return "running";

  if (standing.status === "claimed" && standing.claimedBy !== null) {
    const started = await startSimulation(
      standing.auth,
      standing.id,
      standing.claimedBy,
    );
    if (started !== undefined) return started.status;
    // The guarded update matched nothing, so the row moved between the read
    // and the write — a duplicate racing this one, or the sweep. Read again
    // and answer as the first read would have, one race later.
    const moved = await resolveSimulationStanding(standing.id);
    if (moved?.status === "running") return "running";
    return refusedByTheRecord(reply, moved ?? standing, "running");
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
): Promise<FastifyReply | string> {
  // A terminal row answers from what it already says: the matching resend
  // is absorbed, anything else is a document trying to rewrite the record.
  if (
    standing.status === "completed" ||
    standing.status === "failed" ||
    standing.status === "canceled"
  ) {
    if (matchesTerminalRow(event, standing)) return standing.status;
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

  // Said out loud when the reported pair cannot be believed: the landing
  // below will stand on its own stamps, and the record of why is this line.
  if (reportedMoments(facts) === undefined) {
    reply.log.warn(
      {
        simulationId: standing.id,
        reportedStartedAt: facts.started_at,
        reportedEndedAt: facts.ended_at,
      },
      `simulation ${standing.id} reported ended_at before started_at; ` +
        `landing with the server's own stamps for both moments`,
    );
  }

  const landed = await applyLanding(standing, event, facts.ending);
  if (landed !== undefined) return landed.status;

  // The guarded landing matched nothing. Either a duplicate raced this
  // request and the row now says what this document says — absorbed — or
  // the record genuinely disagrees, and the freshest reading names how.
  const moved = await resolveSimulationStanding(standing.id);
  if (moved !== undefined && matchesTerminalRow(event, moved)) {
    return moved.status;
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
    moved !== undefined &&
    (moved.status === "claimed" || moved.status === "running") &&
    moved.cancelRequestedAt !== null
  ) {
    const relanded = await applyLanding(moved, event, facts.ending);
    if (relanded !== undefined) return relanded.status;
    const settled = await resolveSimulationStanding(standing.id);
    if (settled !== undefined && matchesTerminalRow(event, settled)) {
      return settled.status;
    }
    return refusedByTheRecord(reply, settled ?? moved, event.status);
  }
  if (event.status === "canceled" && moved?.cancelRequestedAt === null) {
    return conflict(
      reply,
      `nobody asked to cancel simulation ${standing.id}: no cancellation ` +
        `was ever requested, so a canceled report would invent a stop order ` +
        `the record does not hold. If the conversation could not continue, ` +
        `report it failed with its honest reason.`,
    );
  }
  return refusedByTheRecord(reply, moved ?? standing, event.status);
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
    return failSimulation(standing.auth, standing.id, conductor, {
      reason,
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
