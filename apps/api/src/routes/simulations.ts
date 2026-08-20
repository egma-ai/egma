import {
  foldSimulation,
  getAgent,
  getConnection,
  getGradingPlan,
  getPersona,
  getPersonaVersion,
  getRun,
  getSimulation,
  getSimulationTestVersion,
  listGradingJobsForSimulation,
  NotPermittedError,
  readTrace,
  readAssertionShelf,
  readVerdicts,
  regrade,
  type AssertionWords,
  type GradingPlan,
  type MockToolCoverage,
  type RecordedVerdict,
  type Simulation,
  type TraceDetail,
  type TraceSpan,
} from "@egma/db";
import { isId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { describedMockTool } from "../http/mock-tools.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, projectNamed, text } from "../http/reading.ts";
import {
  describedOutcome,
  describedVerdict,
  onlyReporting,
} from "../http/verdicts.ts";
import {
  invalid,
  narrowerGradingInFlight,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";

/**
 * One simulation, whole: what happened, how it happened, how egma judged it, and
 * what a person said about that judgment afterwards.
 *
 * ## One read, and it is bounded by construction
 *
 * `GET /api/simulations/:simulationId` is the **whole page-load contract** for a
 * conversation's evidence. It is deliberately one request rather than the seven
 * a page would otherwise make, and every one of the reads behind it is bounded
 * before it is issued:
 *
 * - the conversation, its run, its agent and its connection are single rows;
 * - the pinned test version and the pinned persona version are single rows, and
 *   they are the versions this conversation *executed* rather than whatever
 *   those things say today;
 * - the frozen grading plan is one row of JSON, narrowed here to the group that
 *   judged this conversation's own test version;
 * - the verdicts are filed under the conversation, which is the third column of
 *   that table's sorting key, so naming it is the pruning;
 * - and the transcript is read inside **the conversation's own window**, worked
 *   out on this side from the row's stamps rather than asked of the caller.
 *
 * That last one is the reason this endpoint exists at all. The public trace read
 * makes a caller name the window because the span store is filed by time and a
 * read that named none would be a read of everything — and the honest answer for
 * a *simulation* is that egma already knows when it happened. A page that had to
 * guess would either guess narrow and lose turns or guess wide and scan
 * partitions for nothing.
 *
 * The one thing deliberately **not** in the answer is the recording. A recording
 * link is signed, short-lived and bound to one object, so baking one in would
 * put a credential in an address somebody pastes into a ticket and make the page
 * stale a quarter of an hour after it loaded. `has_recording` says whether there
 * is anything to hear; `GET /api/simulations/:id/recording` is where it becomes
 * audible, and it is asked for only when somebody is looking.
 *
 * ## Judging it again, and disagreeing with it
 *
 * Two writes, both `revisit_verdicts`, which is the one row of the permission
 * table that covers both — a viewer is refused here rather than merely shown no
 * button, and the button's absence is the page agreeing with the server rather
 * than the page being the check.
 *
 * - `POST /api/simulations/:id/regrade` reopens this conversation's grading job.
 *   With no grader named it resolves the whole applicable set again; naming one
 *   narrows to that grader at its **current** version, which is what somebody
 *   who has just fixed one rubric is asking for. The built-in expected-behaviors
 *   grader is never a row in any table, so it has no identity to name and cannot
 *   be asked for alone — asking for the conversation is how its behaviors are
 *   judged again. Run and window re-grades stay where they were, on their own
 *   surfaces, because a conversation is not the only grain anybody re-scores.
 * **There is no corrections endpoint, and there was one.** It wrote a person's
 * disagreement as a whole verdict row beside the machine's. ADR-0009 takes
 * corrections and their calibration data out of v0: the capability returns as
 * the reserved `human` grader type, which writes its own rows under its own
 * grader id and therefore needs no `judged_by` column and no second author on
 * one judgment. Nothing here is a smaller version of it.
 */

export type SimulationRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const SIMULATION_PATH = "/api/simulations/:simulationId";
export const SIMULATION_REGRADE_PATH = "/api/simulations/:simulationId/regrade";

/**
 * A conversation nobody may see reads exactly like a conversation nobody
 * conducted — the recording route's own sentence, kept in step with it because
 * the two answer the same question about the same id.
 */
const NO_SUCH_SIMULATION =
  "no simulation of yours has that id. Check the id, or open the run it " +
  "belongs to with GET /api/runs/{run_id}.";

/**
 * How far either side of the conversation the transcript is read.
 *
 * A simulation's spans are stamped by the simulator's clock and the row's
 * moments by the platform's, so the two never agree exactly; and a conversation
 * that failed mid-flight has spans after the last moment anybody wrote down. A
 * minute is wide enough that no turn of a real conversation falls outside it and
 * narrow enough that the store still prunes to a handful of minutes — which is
 * the whole reason the window is required in the first place.
 */
const AROUND_THE_CONVERSATION_MS = 60_000;

/**
 * The window one conversation's transcript is read inside, in microseconds.
 *
 * Anchored on what the row actually knows. A conversation that never started has
 * no stamps of its own, so the run's creation is the anchor — and a conversation
 * still in flight is read up to now rather than up to an ending that has not
 * happened.
 */
function windowOf(
  one: Simulation,
  runCreatedAt: Date,
): {
  readonly from: bigint;
  readonly to: bigint;
} {
  const opened = one.startedAt ?? one.createdAt ?? runCreatedAt;
  const closed = one.endedAt ?? new Date();
  const from = opened.getTime() - AROUND_THE_CONVERSATION_MS;
  const to =
    Math.max(closed.getTime(), opened.getTime()) + AROUND_THE_CONVERSATION_MS;
  return { from: BigInt(from) * 1000n, to: BigInt(to) * 1000n };
}

/** One span, in the shape the trace read already answers the public API with. */
function describedSpan(span: TraceSpan): Record<string, unknown> {
  return {
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    started_at: span.startedAt,
    duration_ns: span.durationNanoseconds,
    text: span.text,
    audio_url: span.audioUrl,
    tool_name: span.toolName,
    tool_arguments: span.toolArguments,
    tool_result: span.toolResult,
    spans: span.spans.map(describedSpan),
  };
}

/**
 * What was said and what happened while it was said, or the honest absence.
 *
 * A conversation with no spans filed is not a fault: a run that was skipped
 * conducted nothing, a dispatch that failed said nothing, and a simulator that
 * died before its first export left nothing behind. So the transcript is `null`
 * rather than an empty tree, and the page says *there is no transcript* instead
 * of drawing an empty one that reads as a silent conversation.
 */
function describedTranscript(
  detail: TraceDetail | undefined,
): Record<string, unknown> | null {
  if (detail === undefined) return null;
  return {
    trace_id: detail.traceId,
    started_at: detail.startedAt,
    ended_at: detail.endedAt,
    duration_ns: detail.durationNanoseconds,
    span_count: detail.spanCount,
    turn_counts: { human: detail.humanTurnCount, agent: detail.agentTurnCount },
    tool_span_count: detail.toolSpanCount,
    errored_span_count: detail.erroredSpanCount,
    turns: detail.turns.map(describedSpan),
    spans: detail.spans.map(describedSpan),
    // The tree is a prefix and the counts are the whole conversation. A page
    // that did not say so would present a cut-off transcript as a short one.
    spans_truncated: detail.truncated,
  };
}

/** The coverage stamp, key by key, or null where nothing was ever claimed. */
function describedMockToolCoverage(
  coverage: MockToolCoverage | null,
): Record<string, unknown> | null {
  if (coverage === null) return null;
  return {
    discovered: [...coverage.discovered],
    covered: [...coverage.covered],
    uncovered: [...coverage.uncovered],
  };
}

/**
 * The part of the run's frozen plan that judged **this** conversation, and the
 * state that says how much of it can be believed.
 *
 * Narrowed to this conversation's own test version rather than carried whole:
 * the other groups judged other conversations, and putting them on this page
 * would invite somebody to read a grader that never touched this one as
 * something that did.
 *
 * The state travels whatever the groups come to, because it is the first thing a
 * reader needs. `migration_snapshot` was captured during an upgrade rather than
 * when the run began, and `not_recorded` is a run that has no plan at all —
 * neither is reconstructed from today's graders here or anywhere, because a
 * reconstructed plan is a claim about an old run that nobody can check.
 */
function describedPlanForThisConversation(
  plan: GradingPlan | undefined,
  testVersionId: string | null,
): Record<string, unknown> | null {
  if (plan === undefined) return null;

  const mine = plan.groups.filter((group) =>
    group.tag === "version"
      ? group.testVersionId === testVersionId
      : testVersionId === null,
  );

  return {
    state: plan.state,
    captured_at: plan.capturedAt?.toISOString() ?? null,
    items: mine.flatMap((group) =>
      group.items.map((item) =>
        ({
          kind: "authored",
          grader_id: item.graderId,
          grader_version_id: item.graderVersionId,
          name: item.graderName,
          library_id: item.libraryId,
          required: item.required,
          scope: item.scope,
        }),
      ),
    ),
  };
}

/**
 * What was **measured** about this conversation, and never what was judged.
 *
 * Only what is actually known: a measure nobody emitted is absent from this
 * object rather than present as null, because a page that drew a slot for every
 * measure the catalog names would report zeros for things nothing counted. A
 * conversation that never connected has no duration; latency, interruption
 * counts and cost are not stored on this path yet and are simply not here.
 */
function describedMeasures(
  one: Simulation,
  detail: TraceDetail | undefined,
): Record<string, unknown> {
  const measures: Record<string, unknown> = {};
  if (one.startedAt !== null && one.endedAt !== null) {
    measures.duration_ms = one.endedAt.getTime() - one.startedAt.getTime();
  }
  if (one.turnCount !== null) measures.turn_count = one.turnCount;
  if (detail !== undefined) {
    measures.tool_call_count = detail.toolSpanCount;
    measures.errored_step_count = detail.erroredSpanCount;
    measures.human_turn_count = detail.humanTurnCount;
    measures.agent_turn_count = detail.agentTurnCount;
  }
  return measures;
}

export async function simulationRoutes(
  app: FastifyInstance,
  options: SimulationRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Everything one conversation's evidence page shows, in one answer.
   *
   * The order below is the order of dependency and nothing more: the
   * conversation decides whether there is anything to answer at all, and every
   * read after it is issued against ids that conversation already carries. The
   * ones that can go together do — the pins, the identities, the plan, the
   * verdicts and the transcript are independent of each other.
   *
   * **Every one of them degrades rather than fails.** The verdict store and the
   * span store are separate stores from the control plane and can be down while
   * the conversation reads perfectly well; a page that answered 500 because
   * ClickHouse was restarting would present a storage outage as a missing
   * conversation. So an unreachable verdict store is *no verdicts yet*, which is
   * the shape an unjudged conversation already has, and an unreachable span
   * store is *no transcript*, which is the shape a conversation that emitted
   * nothing already has. Both correct themselves on the next read.
   */
  app.get(SIMULATION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { simulationId } = request.params as { simulationId: string };

    /*
      `reachingIn`, because the conversation's own id says which one, and a
      credential naming no project reads across the whole customer.

      This route and the recording beside it are the two doors one evidence page
      opens. The recording was moved when the four run routes were; this one was
      not, so an organization-wide key in a customer holding two projects got
      the transcript refused and the audio served — the same page answering the
      same question two ways.
    */
    const acting = await reachingIn(auth, projectNamed(query, {}));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const who = acting.auth;

    const one = await getSimulation(who, simulationId);
    if (one === undefined) return notFound(reply, NO_SUCH_SIMULATION);

    const run = await getRun(who, one.runId);
    if (run === undefined) return notFound(reply, NO_SUCH_SIMULATION);

    const [
      testVersion,
      persona,
      personaVersion,
      agent,
      connection,
      plan,
      jobs,
    ] = await Promise.all([
      getSimulationTestVersion(who, one.id),
      getPersona(who, one.personaId),
      getPersonaVersion(who, one.personaVersionId),
      // Both come back as they now stand, archived or not. That is what keeps
      // a conversation readable after somebody archives what it went over:
      // archiving stops new work, and it must never make old evidence
      // unnameable.
      getAgent(who, one.agentId),
      getConnection(who, one.agentId, one.connectionId),
      getGradingPlan(who, one.runId),
      listGradingJobsForSimulation(who, one.id),
    ]);

    const judged = await readVerdicts(who, one.id).catch(() => undefined);

    const filedUnder = traceIdOfSimulation(one.id);
    const window = windowOf(one, run.createdAt);
    const detail =
      filedUnder === undefined
        ? undefined
        : await readTrace(who, filedUnder, { window }).catch(() => undefined);

    /*
     * **A conversation with no rows is unjudged, not judged to nothing.**
     * `readVerdicts` always answers with a fold, and the fold over an empty set
     * is a perfectly well-formed outcome — so handing it straight to
     * `foldSimulation` would report `graded` for a conversation the engine has
     * not looked at yet, and a page would stop waiting for a verdict that is
     * still coming. The run's own read draws the same line, from the other side:
     * a conversation with no rows is simply absent from `readRunVerdicts`.
     */
    const outcome =
      judged === undefined || judged.verdicts.length === 0
        ? undefined
        : judged.outcome;
    const fold = foldSimulation(one.status, outcome);

    // Which of the copies that judged this conversation only report, off the
    // read's own per-grader fold rather than asked a second time — so a card's
    // marking and the outcome above it cannot disagree.
    const diagnostic = onlyReporting(judged?.byGrader);

    // The words behind the assertion keys these rows carry, resolved from the
    // version this conversation was pinned to. A key nothing can place is sent
    // as itself; a page shows the key rather than a guess.
    const words: AssertionWords | undefined = await readAssertionShelf(
      who,
      (judged?.byGrader ?? []).map((its) => its.graderId),
    )
      .then((shelf) => shelf.forSimulation(one.id))
      .catch(() => undefined);

    return reply.send({
      id: one.id,
      project_id: one.projectId,
      run_id: one.runId,
      run_label: run.label,
      position: one.position,
      // The four facts, kept apart exactly as a run's own page keeps them: the
      // machinery, where the judging stands, what was decided, and null where
      // nobody has decided yet. A pending verdict is not a failing one.
      status: one.status,
      grading: fold.grading,
      verdict: fold.verdict,
      score: fold.score ?? null,
      counts: fold.counts,
      reason: one.endingReason,
      skip_reason: one.skipReason,
      skipped_capabilities:
        one.skippedCapabilities === null ? null : [...one.skippedCapabilities],
      modality: one.modality,
      created_at: one.createdAt.toISOString(),
      started_at: one.startedAt?.toISOString() ?? null,
      ended_at: one.endedAt?.toISOString() ?? null,
      // The platform's own identifier for the exchange — the one join between
      // this record and the agent's own telemetry, and the thing somebody takes
      // to their provider's dashboard when they doubt what egma says happened.
      provider_reference: one.providerReference,
      has_recording: one.recordingReference !== null,
      // What is measured, apart from anything judged, and only where measured.
      measures: describedMeasures(one, detail),
      test: {
        id: one.testId,
        // The pin: what actually executed, which never moves.
        version_id: one.testVersionId,
        // And the name as it stands today, which is how somebody finds it.
        name: testVersion?.testName ?? null,
        // Null where the pin is unreachable — an upgraded instance's history has
        // conversations that pinned no test, and they executed no stored test
        // rather than an unnamed one.
        scenario: testVersion?.scenario ?? null,
        expected_behaviors:
          testVersion === undefined ? null : [...testVersion.expectedBehaviors],
        required_capabilities:
          testVersion === undefined
            ? null
            : [...testVersion.requiredCapabilities],
      },
      persona: {
        id: one.personaId,
        // The name as it stands today, which is how somebody finds them; the
        // version below is exactly who called.
        name: persona?.name ?? null,
        version_id: one.personaVersionId,
        // Every authored human fact from the exact version that called. The
        // technical voice is not among these traits; it has one owner in the
        // persona version's model selection.
        traits: personaVersion?.traits ?? null,
      },
      agent:
        agent === undefined
          ? { id: one.agentId, name: null, archived: null }
          : {
              id: agent.id,
              name: agent.name,
              archived: agent.archivedAt !== null,
            },
      connection:
        connection === undefined
          ? { id: one.connectionId, name: null, archived: null }
          : {
              id: connection.id,
              name: connection.name,
              archived: connection.archivedAt !== null,
            },
      // The connection exactly as this run went over it, frozen at start. There
      // is no field here a credential could ride in: the secret lives in its own
      // sealed column and was never copied into the snapshot.
      connection_snapshot: {
        type: run.connectionSnapshot.type,
        modality: run.connectionSnapshot.modality,
        topology: run.connectionSnapshot.topology,
        environment: run.connectionSnapshot.environment,
        config: run.connectionSnapshot.config,
      },
      // Which of the agent's tools egma stood in the path of, and which ran for
      // real. Null says nobody ever asked the agent what tools it has, which is
      // a different fact from three empty lists.
      mock_tool_coverage: describedMockToolCoverage(one.mockToolCoverage),
      // The mocked answers this conversation's own test version was frozen with,
      // over the run's project defaults. Read here rather than merged, for the
      // reason the run's own read gives: an override replaces a default by tool
      // name, and both halves have to be visible for the merge to be checkable.
      mock_tools: {
        defaults: run.mockToolSnapshot.defaults.map((its) => ({
          ...describedMockTool(its),
          mock_tool_id: its.mockToolId,
        })),
        overrides: (
          run.mockToolSnapshot.overrides[one.testVersionId ?? ""] ?? []
        ).map(describedMockTool),
      },
      grading_plan: describedPlanForThisConversation(plan, one.testVersionId),
      // Whether anything is still queued for this conversation, and what it was
      // narrowed to. This is what lets a page say "grading is running" without
      // turning a pending verdict into a failure.
      grading_jobs: jobs.map((job) => ({
        status: job.status,
        regrade_grader_id: job.regradeGraderId,
        attempts: job.attempts,
        last_error: job.lastError,
        finished_at: job.finishedAt?.toISOString() ?? null,
      })),
      // Every row, superseded ones included and in a stable order: an older
      // grading stays underneath the one that replaced it, and the reader
      // folds — which is the whole reason the earlier row survives.
      verdicts: (judged?.verdicts ?? []).map((its) =>
        describedVerdict(its, words, diagnostic),
      ),
      // The conversation's own answer, over the required copies alone, with the
      // diagnostic lane beside it and never in it.
      outcome: describedOutcome(judged?.outcome),
      diagnostics: describedOutcome(judged?.diagnostics),
      by_grader: (judged?.byGrader ?? []).map((its) => ({
        grader_id: its.graderId,
        // `false` marks a diagnostic: judged, shown, never able to fail
        // anything. Without it a red card would read the same either way.
        required: its.required,
        verdict: its.outcome.verdict,
        score: its.outcome.score ?? null,
        counts: its.outcome.counts,
      })),
      transcript: describedTranscript(detail),
    });
  });

  /**
   * Judge this conversation again.
   *
   * Whole by default, or narrowed to one authored grader at its current version.
   * A grader that has been archived is unreachable and answers as absent, which
   * is right: an archived grader judges nothing from now on and a re-grade is
   * from now on.
   *
   * It answers as soon as the work is queued rather than when it is done, on the
   * same terms as starting a run — the engine claims the reopened job and the
   * verdicts land through the ordinary path. A conversation that was already
   * waiting is left exactly alone and counted, because it was already going to
   * be judged at today's versions, which is everything a re-grade asks for.
   *
   * **Except when what is already running is narrower than what was asked**, and
   * then this refuses. A job somebody has claimed is judged under the
   * instruction it was claimed with, so one claimed for a single grader answers
   * an ask about a different grader — or about the whole conversation — by
   * judging neither, with nothing queued behind it. Counting that as "already
   * waiting" is the same sentence as the covered case for the opposite fact, so
   * the two are told apart here and answered apart: `narrower_grading_in_flight`
   * says nothing happened and says when to ask again.
   */
  app.post(SIMULATION_REGRADE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { simulationId } = request.params as { simulationId: string };

    const acting = await actingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const who = acting.auth;

    const named = given(text(body.grader_id));
    if (named !== undefined && !isId("grd", named)) {
      return invalid(
        reply,
        `"${named}" is not a grader id. Send grader_id as the grd_ id of an ` +
          `active grader to judge with that one alone, or leave it out to ` +
          `judge this conversation with everything that applies. The ` +
          `expected-behaviors built-in is never a row and has no id, so it ` +
          `cannot be asked for on its own.`,
      );
    }

    const asked = await regrade(who, {
      simulationId,
      ...(named === undefined ? {} : { graderId: named }),
    });

    // One answer for three absences, on purpose: a conversation of somebody
    // else's, one nobody conducted, and a grader that is archived or was never
    // there. Telling them apart would answer a question the caller was not
    // entitled to ask.
    if (asked === undefined) {
      return notFound(
        reply,
        named === undefined
          ? NO_SUCH_SIMULATION
          : `${NO_SUCH_SIMULATION} If the id is right, check the grader: an ` +
              `archived grader judges nothing from now on, and a re-grade is ` +
              `from now on.`,
      );
    }

    if (asked.reopened.length === 0 && asked.alreadyWaiting === 0) {
      return unprocessable(
        reply,
        `simulation ${simulationId} has no grading to ask for again. Egma ` +
          `never conducted it, or it never finished, so nothing was ever ` +
          `judged and there is nothing to judge a second time.`,
      );
    }

    // A conversation has exactly one grading job, so this is the whole answer
    // rather than part of one: the job is being judged this moment for a grader
    // that is not the one asked about, nothing was queued behind it, and no
    // verdict for this ask is coming. Saying `already_waiting: 1` here would be
    // the answer below telling somebody to wait for nothing.
    if (asked.beingJudgedNarrower > 0) {
      return narrowerGradingInFlight(
        reply,
        `simulation ${simulationId} is being judged right now, for one grader ` +
          `that does not cover what you asked for, and Egma will not ` +
          `interrupt a judgment that is already running. Nothing was queued ` +
          `and no verdict for this ask is coming. Ask again once those ` +
          `verdicts land.`,
      );
    }

    return reply.send({
      simulation_id: simulationId,
      // What the reopened job actually carries, echoed back rather than what was
      // typed — so a caller sees the ask that was made.
      grader_id: asked.graderId,
      reopened: asked.reopened.length,
      already_waiting: asked.alreadyWaiting,
    });
  });

  /*
   * **There is no corrections endpoint here, and there was one.** See this
   * module's own note: corrections leave v0 with ADR-0009 and return as the
   * reserved `human` grader type, writing rows under a grader id of its own.
   */

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
