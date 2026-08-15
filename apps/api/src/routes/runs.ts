import {
  authorize,
  cancelRun,
  connectionTypeOf,
  getRun,
  IdempotencyConflictError,
  JudgeNotConfiguredError,
  planRun,
  listRunEvents,
  listSimulations,
  NotPermittedError,
  platformFacts,
  ProjectOutsideOrganizationError,
  readRunVerdicts,
  readVerdicts,
  RunWriteRefusedError,
  startRun,
  type AuthContext,
  type ConductedSimulation,
  type MockToolCoverage,
  type MockToolSnapshot,
  type Run,
  type RecordedVerdict,
  type RunEvent,
  type JudgeChoice,
  type RunPlan,
  type RunVerdicts,
  type SimulationVerdicts,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { describedMockTool } from "../http/mock-tools.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  conflict,
  invalid,
  REFUSALS,
  noAdapter,
  notFound,
  notPermitted,
  phoneSetupRequired,
  sendRefusal,
  unprocessable,
} from "../http/refusals.ts";
import {
  phoneReadiness,
  phoneSetupRequiredMessage,
} from "../phone-readiness.ts";

/**
 * Starting a run, reading it whole, following it while it happens, and
 * stopping it.
 *
 * Four things about this group are contract rather than convenience.
 *
 * **A run pins the exact versions it executes.** The request names test
 * version ids and never "whatever is current when this runs", because what
 * executed is the whole of what a green result means. Every id is resolved
 * before a single row is written, and one unknown or doubled id refuses the
 * whole creation — a run that quietly executed eleven of the twelve versions
 * somebody named would report green about a suite that did not run.
 *
 * **A type nothing can conduct is refused at the door**, with the platform's
 * own sentence and the code `no_adapter`. A run left queued for a conductor
 * that does not exist is a promise egma cannot keep, and it would be
 * discovered by a person waiting for a terminal that never moves.
 *
 * **A phone run is refused before it is written when this deployment has no
 * carrier**, with the code `phone_setup_required`. Two refusals in two layers,
 * on purpose: `no_adapter` is a fact about the build and lives in `@egma/db`
 * beside the registry that knows it, and this one is a fact about *this
 * installation's* configuration, which that package cannot see and should
 * never learn to. The order matters more than the split — the point of
 * refusing here is that no paid provider action has happened yet, and none
 * will.
 *
 * **The feed is a numbered cursor, and the split is written down.** This side
 * is stateless: it remembers nothing about who has read what, and the same
 * `after` twice answers the same page twice. The client's half is to apply
 * each sequence number at most once. Between them, a follower that crashes and
 * restarts from the last number it applied misses nothing and repeats nothing
 * — which is what makes following a run over a flaky connection honest rather
 * than hopeful. `done` says the run has finished and there will be no more.
 *
 * **Stopping early never masquerades as passing.** Cancel settles the three
 * counts together, and a conversation that never ran is counted as canceled
 * rather than quietly forgotten.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. A run may name a project in its body
 * and does not have to; in a single-project organization nothing ever does.
 */

export type RunRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /** Where this instance is, for the address a person opens results at. */
  readonly baseUrl: string;
};

/**
 * The connection types this deployment cannot dial over until its phone half
 * has been set up.
 *
 * One entry, and it is a list rather than an `=== "phone"` so that the next
 * carrier-backed type is a line here instead of a condition somebody has to
 * find. What makes a type belong is not that it is telephony-shaped: it is that
 * conducting it spends the platform's *own* carrier, which is the thing
 * `egma self-host setup` provides.
 */
const NEEDS_THE_PLATFORMS_CARRIER: readonly string[] = ["phone"];

export const RUNS_PATH = "/api/runs";
/**
 * What a run would freeze, read before anybody starts one.
 *
 * A read rather than a dry-run write, and it is deliberately not under
 * `/api/runs`: nothing is created and nothing is reserved. It answers the same
 * resolution `POST /api/runs` performs, so a review step and the run it starts
 * can never disagree about which tests would be skipped, which versions would
 * be pinned, or which graders would judge.
 */
export const RUN_PLAN_PATH = "/api/run-plan";
export const RUN_PATH = "/api/runs/:runId";
export const RUN_EVENTS_PATH = "/api/runs/:runId/events";
export const RUN_CANCEL_PATH = "/api/runs/:runId/cancel";

type Body = Record<string, unknown>;

/**
 * The versions a body pinned, in the order it pinned them.
 *
 * **Text, and every entry of it.** An entry that is not a version id is
 * refused rather than dropped, and that is the whole point: dropping one would
 * start a run over the rest, and the caller would read a green result about a
 * selection egma quietly shortened. The same reason one unknown id refuses the
 * whole creation further down.
 */
type PinnedVersions =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function pinnedVersions(value: unknown): PinnedVersions {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "test_versions is the list of frozen versions this run executes, by " +
        'id. Send it as a list of text, like ["tstv_..."], taking each ' +
        "version_id from the test it belongs to.",
    };
  }

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") {
      return {
        refusal:
          "a run pins each test version as text — the version_id a push or a " +
          "read answered with — and one entry in test_versions is neither. " +
          "Send them all, or none of them runs.",
      };
    }
    entries.push(named);
  }
  return { entries };
}

/**
 * A run nobody can see reads exactly like a run nobody started. Existence is
 * never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
const NO_SUCH_RUN =
  "no run of yours has that id. Check the id, or start a run with POST " +
  "/api/runs.";

/**
 * One conversation of a run, as every read of one describes it.
 *
 * The two pins are both here on purpose: `test_version_id` is what actually
 * executed and never moves, and `test_id` is what to go and edit.
 *
 * `verdict` is what the graders make of the conversation, folded over every
 * dimension judged against it. It is `null` for a conversation nobody has
 * judged **yet** — which is not the same as one judged and found wanting, and
 * the two must never read alike. `grading` carries that distinction: a
 * conversation with no rows says `pending`, and one with rows says `graded`
 * beside whatever the fold came to.
 *
 * Execution and grading are separate facts and are reported separately. A
 * conversation can be `completed` and ungraded, and a reader that collapsed the
 * two would call a run finished while its judgment was still being written.
 *
 * `mock_tool_coverage` is here because comparing two of these numbers is only
 * valid when both conversations were conducted in the same world. A simulation
 * whose tools were answered by mock tools and one whose tools ran for real are
 * different units, exactly as two audio bands are, and this is where a reader
 * finds that out — off the conversation itself, with nothing else to fetch and
 * nothing editable to ask. Null says the agent was never asked what tools it
 * has, so nothing was learned and nothing is claimed.
 */
function describedSimulation(
  one: ConductedSimulation,
  judged: SimulationVerdicts | undefined,
  rows: readonly RecordedVerdict[],
): Record<string, unknown> {
  return {
    id: one.id,
    position: one.position,
    test_id: one.testId,
    test_name: one.testName,
    test_version_id: one.testVersionId,
    persona_id: one.personaId,
    persona_name: one.personaName,
    status: one.status,
    grading: judged === undefined ? "pending" : "graded",
    verdict: judged?.outcome.verdict ?? null,
    score: judged?.outcome.score ?? null,
    // Skipped and errored are carried out whole rather than folded into the
    // other two: missing judgment is not a pass and a broken judge is not a
    // failing agent, and a summary that hid either would say the opposite of
    // what happened.
    counts: judged === undefined ? null : judged.outcome.counts,
    // Every judged behaviour, whole. The fold above says how many passed; this
    // says which ones and why, because "2 of 3 passed" without the rationale
    // sends somebody to read a transcript to work out what egma already knew.
    // The judge is named on every row: a verdict nobody can attribute is a
    // verdict nobody can argue with.
    verdicts: rows.map((its) => ({
      grader_id: its.graderId,
      dimension: its.dimension,
      verdict: its.verdict,
      score: its.score,
      priority: its.priority,
      rationale: its.rationale,
      cited_turns: [...its.citedSpanIds],
      judged_by: its.judgedBy,
      judged_at: its.judgedAt,
    })),
    reason: one.endingReason,
    // Why egma never conducted this conversation, and which capabilities
    // decided it. Null on every conversation that actually happened — the two
    // vocabularies are separate because `reason` is how a conversation ended
    // and this is why one never began.
    skip_reason: one.skipReason,
    skipped_capabilities: one.skippedCapabilities === null
      ? null
      : [...one.skippedCapabilities],
    mock_tool_coverage: describedMockToolCoverage(one.mockToolCoverage),
    // What this conversation was: the row's own modality rather than the run's,
    // because the row is what the database enforces the audio rule against.
    modality: one.modality,
    // Whether there is a recording to hear, and never where it is. The
    // reference is opaque and stays that way — resolving it into a link is one
    // route's job, and a page that carried a link would be a page whose address
    // could not be shared. This is only enough to know whether to offer a
    // player at all, which is the difference between an honest absence and a
    // disabled control that reads as a broken feature.
    has_recording: one.recordingReference !== null,
  };
}

/**
 * The coverage stamp as the wire carries it: the report's own three keys, in
 * the report's own words, or null where there is nothing claimed.
 *
 * The names are copied key by key rather than passed through, so the shape a
 * client reads is decided here and not by whatever a row happens to hold.
 */
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
 * The mocked world a run froze, as every read of the run describes it.
 *
 * Two halves rather than one resolved list per test version, because that is
 * how it is stored and for the same reason: an override replaces a default by
 * tool name, and answering the merge per version would repeat every default
 * once per test for nothing. A reader who wants the merge asks for the run's
 * simulations and applies the overrides of the version each one names — which
 * is what the simulator is handed when it claims one.
 *
 * Each entry is the one projection every group of mocked answers is described
 * by; only the `mock_tool_id` beside a default is this read's own.
 */
function describedMockTools(
  snapshot: MockToolSnapshot,
): Record<string, unknown> {
  return {
    // A default is one of those with the row it came from named beside it, so a
    // reader can go and look at the mock tool the run froze.
    defaults: snapshot.defaults.map((one) => ({
      ...describedMockTool(one),
      mock_tool_id: one.mockToolId,
    })),
    overrides: Object.fromEntries(
      Object.entries(snapshot.overrides).map(([versionId, entries]) => [
        versionId,
        entries.map(describedMockTool),
      ]),
    ),
  };
}

/**
 * What a run would freeze, as the review step reads it.
 *
 * Every version, its personas at the exact versions the run would pin, its
 * required capabilities and what this connection makes of them, and the plan
 * items that would judge it — grader by grader, at the version each would be
 * frozen at.
 *
 * **The judge is a state rather than a refusal here**, because a page has to
 * draw it. `needs_setup` is what a project with no judge reads as, and starting
 * from that state is what the run door refuses.
 *
 * **No secret travels.** A configured judge choice carries the provider, the
 * model and the *reference* — a `jcr_` credential of this organization, or the
 * `platform` sentinel — and there is no field here a key could ride in.
 */
function describedPlan(plan: RunPlan): Record<string, unknown> {
  return {
    agent_id: plan.agentId,
    connection_id: plan.connectionId,
    connection: {
      type: plan.connection.type,
      modality: plan.connection.modality,
      environment: plan.connection.environment,
      // Unknown and known-and-bare are different facts and read differently:
      // one is a Refresh away from an answer, the other is settled.
      capabilities:
        plan.connection.capabilities.state === "unknown"
          ? { state: "unknown" }
          : {
              state: "known",
              measured: [...plan.connection.capabilities.measured],
              supported: [...plan.connection.capabilities.supported],
              checked_at: plan.connection.capabilities.checkedAt.toISOString(),
              source: plan.connection.capabilities.source,
            },
    },
    judge:
      plan.judge.state === "needs_setup"
        ? { state: "needs_setup" }
        : {
            state: "configured",
            provider: plan.judge.provider,
            model: plan.judge.model,
            source: plan.judge.source,
          },
    runnable_simulation_count: plan.runnableSimulationCount,
    skipped_simulation_count: plan.skippedSimulationCount,
    tests: plan.groups.map((group) => ({
      test_id: group.testId,
      test_version_id: group.testVersionId,
      test_name: group.testName,
      personas: group.personas.map((one) => ({
        persona_id: one.personaId,
        persona_version_id: one.personaVersionId,
        name: one.name,
      })),
      required_capabilities: [...group.requiredCapabilities],
      // Runnable, or the structured reason and the keys that decided it. The
      // two skip reasons are never folded together: one means write a
      // different test, the other means measure this connection.
      skip: group.capability.runnable
        ? null
        : {
            reason: group.capability.reason,
            capabilities: [...group.capability.capabilities],
          },
      graders: group.items.map((item) =>
        item.kind === "built_in"
          ? {
              kind: "built_in",
              grader_key: item.graderKey,
              engine_version: item.engineVersion,
              reads: [...item.reads],
              modalities: [...item.modalities],
              judge: describedJudgeChoice(item.judge),
            }
          : {
              kind: "authored",
              grader_id: item.graderId,
              grader_version_id: item.graderVersionId,
              name: item.graderName,
              origin: item.origin,
              priority: item.priority,
              scope: item.scope,
              reads: [...item.reads],
              modalities: [...item.modalities],
              judge: describedJudgeChoice(item.judge),
            },
      ),
    })),
  };
}

/** A judge choice on the wire: tagged, and never carrying a secret. */
function describedJudgeChoice(
  choice: JudgeChoice,
): Record<string, unknown> {
  return choice.tag === "configured"
    ? {
        tag: "configured",
        provider: choice.provider,
        model: choice.model,
        source: choice.source,
      }
    : { tag: choice.tag };
}

/**
 * The run and its conversations — one shape for starting, reading and stopping.
 *
 * `judged` is absent wherever the caller could not or need not pay for a
 * verdict read: starting a run judges nothing, so that path passes nothing and
 * every conversation reads `pending`, which is exactly true a millisecond after
 * a run begins.
 */
function describedRun(
  one: Run,
  simulations: readonly ConductedSimulation[],
  baseUrl: string,
  judged?: RunVerdicts,
  rowsBySimulation?: ReadonlyMap<string, readonly RecordedVerdict[]>,
): Record<string, unknown> {
  const bySimulation = new Map(
    (judged?.simulations ?? []).map((its) => [its.simulationId, its] as const),
  );
  const gradedCount = simulations.filter((one) => bySimulation.has(one.id)).length;
  return {
    id: one.id,
    status: one.status,
    agent_id: one.agentId,
    connection_id: one.connectionId,
    connection_type: one.connectionSnapshot.type,
    modality: one.connectionSnapshot.modality,
    label: one.label,
    test_versions: [...one.pinnedTestVersionIds],
    // The world this run was frozen into. It never changes after creation,
    // whatever anybody edits, which is what a reader comparing two runs' numbers
    // has to be able to check for themselves.
    mock_tools: describedMockTools(one.mockToolSnapshot),
    expected_simulation_count: one.expectedSimulationCount,
    // Null until all three land together at the finish. A count that appeared
    // one at a time would let a reader do arithmetic on a half-settled run.
    completed_count: one.completedCount,
    failed_count: one.failedCount,
    canceled_count: one.canceledCount,
    // Its own number beside the three above, never folded into any of them.
    // A conversation egma declined to conduct is not a failure of the agent,
    // not something anybody canceled, and certainly not a pass.
    skipped_count: one.skippedCount,
    // No token, no key, no query at all. A person opens it and the browser
    // they signed in with is already signed in — so the address is safe to
    // paste into a message, a ticket or a terminal somebody else can read.
    results_url: `${baseUrl.replace(/\/+$/u, "")}/runs/${one.id}`,
    created_at: one.createdAt.toISOString(),
    finished_at: one.finishedAt?.toISOString() ?? null,
    // Grading progress, reported apart from execution progress. A run whose
    // conversations have all finished is not a run whose judgment is in: these
    // two counts settle at different moments and a reader has to be able to see
    // which one it is waiting on.
    graded_count: gradedCount,
    verdict: judged?.outcome.verdict ?? null,
    score: judged?.outcome.score ?? null,
    counts: judged?.outcome.counts ?? null,
    by_grader: (judged?.byGrader ?? []).map((its) => ({
      grader_id: its.graderId,
      verdict: its.outcome.verdict,
      score: its.outcome.score ?? null,
      counts: its.outcome.counts,
    })),
    simulations: simulations.map((its) =>
      describedSimulation(
        its,
        bySimulation.get(its.id),
        rowsBySimulation?.get(its.id) ?? [],
      ),
    ),
  };
}

/** One change, as the feed carries it. */
function describedEvent(event: RunEvent): Record<string, unknown> {
  return event.kind === "run"
    ? {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "run",
        status: event.status,
      }
    : {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "simulation",
        simulation_id: event.simulationId,
        test_name: event.testName,
        persona_name: event.personaName,
        status: event.status,
        verdict: event.verdict,
        reason: event.reason,
      };
}

/**
 * The run as it now stands, read back after whatever just happened to it.
 *
 * Both reads go through the module on the caller's own context, so a run this
 * credential cannot see is `undefined` here exactly as it is anywhere else.
 */
async function runAsItStands(
  auth: AuthContext,
  runId: string,
  baseUrl: string,
  /** Already read by the write that just moved it, when there was one. */
  known?: Run,
): Promise<Record<string, unknown> | undefined> {
  const header = known ?? (await getRun(auth, runId));
  if (header === undefined) return undefined;

  const simulations = (await listSimulations(auth, runId)) ?? [];
  // The verdict store is a separate store and can be down while the run itself
  // reads perfectly well. A run that answered 500 because nothing had judged it
  // yet would be a grading outage presented as a missing run, so an unreachable
  // verdict store degrades to "pending" — which is the same shape a genuinely
  // ungraded run has, and which the next read corrects on its own.
  const judged = await readRunVerdicts(auth, runId).catch(() => undefined);

  // The rows themselves, one conversation at a time. The run fold deliberately
  // does not carry them — a run of two hundred conversations would be a page
  // nobody asked for — so they are gathered only for the conversations this run
  // actually has, and only for the ones something has judged.
  const rowsBySimulation = new Map<string, readonly RecordedVerdict[]>();
  await Promise.all(
    (judged?.simulations ?? []).map(async (its) => {
      const read = await readVerdicts(auth, its.simulationId).catch(() => undefined);
      if (read !== undefined) rowsBySimulation.set(its.simulationId, read.verdicts);
    }),
  );

  return describedRun(header, simulations, baseUrl, judged, rowsBySimulation);
}

export async function runRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Start a run over one connection, pinning the versions it will execute.
   *
   * The body names the connection, and may name the agent it has to be on —
   * a client holding both checks both, and a mismatch is its own answer
   * rather than a quiet choice between the two ids.
   *
   * Unknown keys are read past rather than refused, which is the strictness
   * this verb has always had: a run's body is assembled by a terminal from a
   * folder and a selection, and the fields that matter each refuse for
   * themselves in words that say what to send instead.
   */
  /**
   * What a run would freeze, for whichever selection is on screen.
   *
   * **The same resolution the start does, and that is the whole point.** A
   * review step that worked out the pins, the skips and the judge for itself
   * would be a second opinion, and the moment the two disagreed a person would
   * have approved one run and started another. So this calls `planRun`, and so
   * does `startRun`.
   *
   * It answers rather than refuses wherever the answer is a state the page has
   * to draw — a project with no judge, a test that would be skipped — and
   * refuses only what could never be written at all.
   */
  app.get(RUN_PLAN_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, unknown>;

    const acting = await actingIn(auth, given(text(query.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const selected = given(text(query.test_versions));
    const pinned = pinnedVersions(
      selected === undefined ? [] : selected.split(","),
    );
    if ("refusal" in pinned) return unprocessable(reply, pinned.refusal);

    const onAgent = given(text(query.agent));
    // Every refusal `planRun` raises is one `startRun` raises for the same
    // reason, so this group's own error handler answers both identically —
    // which is what stops a review step and a start disagreeing about a
    // selection that could never be written.
    const plan = await planRun(acting.auth, {
      connectionId: text(query.connection),
      ...(onAgent === undefined ? {} : { agentId: onAgent }),
      testVersionIds: pinned.entries,
    });
    return reply.send(describedPlan(plan));
  });

  app.post(RUNS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    // The role is checked before anything is read, which is the stance the
    // factories take for the same reason: a viewer is refused for being a
    // viewer, rather than after a read that tells them what is there.
    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const pinned = pinnedVersions(body.test_versions ?? []);
    if ("refusal" in pinned) return unprocessable(reply, pinned.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    /**
     * Nothing is dialled from a platform that has no carrier, and the refusal
     * lands before the run exists.
     *
     * **Asked of the store on every run creation**, rather than of this
     * process's configuration once at start. The carrier is one of the
     * platform's own settings now, so an operator who finishes setup has their
     * next run accepted with no container restarted — and, the other way
     * round, a run started against a carrier somebody has since cleared is
     * refused rather than dispatched at a trunk that is gone. It is one small
     * select in front of an act that creates a whole run; the answer it used
     * to be was fast and could be a day out of date.
     *
     * A connection this caller cannot see reads as `undefined` and falls
     * through untouched: `startRun` owns that sentence, and answering it here
     * would confirm somebody else's connection exists by refusing about it.
     */
    const carrier = phoneReadiness(await platformFacts());
    if (carrier.state !== "ready") {
      const type = await connectionTypeOf(acting.auth, text(body.connection));
      if (type !== undefined && NEEDS_THE_PLATFORMS_CARRIER.includes(type)) {
        return phoneSetupRequired(reply, phoneSetupRequiredMessage(carrier));
      }
    }

    const onAgent = given(text(body.agent));
    const label = given(text(body.label));

    /**
     * **Required here, and optional one layer down.** A run dials real
     * telephony and spends a real judge, so an answer lost on the way back must
     * never become a second conversation with somebody's agent — and the only
     * thing that can prevent it is a word the *client* chose, because only the
     * client knows that its second request is its first one again.
     *
     * The seam beneath takes it optionally because egma's own fixtures start a
     * run once inside a process they control. Every path a person or a client
     * comes in on is this one.
     */
    const idempotencyKey = given(text(body.idempotency_key));
    if (idempotencyKey === undefined) {
      return unprocessable(reply, REFUSALS.idempotencyKeyRequired);
    }

    const started = await startRun(acting.auth, {
      ...(onAgent === undefined ? {} : { agentId: onAgent }),
      connectionId: text(body.connection),
      testVersionIds: pinned.entries,
      idempotencyKey,
      ...(label === undefined ? {} : { label }),
    });

    return reply
      .code(201)
      .send(describedRun(started, started.simulations, options.baseUrl));
  });

  /**
   * The run as it now stands, with every conversation in it. What a follower
   * seeds itself from when it did not start the run itself.
   */
  app.get(RUN_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };

    const described = await runAsItStands(auth, runId, options.baseUrl);
    if (described === undefined) return notFound(reply, NO_SUCH_RUN);
    return reply.send(described);
  });

  /**
   * Everything that has changed since a point, in the order it happened.
   *
   * A cursor rather than a socket: a follower that loses its connection asks
   * again from the last number it applied, so it never misses a change and
   * never acts on one twice. `after` is a sequence number this feed issued —
   * anything else is refused rather than read as zero, because silently
   * starting again from the beginning would replay a whole run into a screen
   * that had already drawn it.
   */
  app.get(RUN_EVENTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as { readonly after?: string };

    // Digits and nothing else. `Number` would take 0x10, 1e3, 5.0 and a
    // padded " 7 " and quietly answer about a page nobody asked for, while
    // the sentence below promised it would not — so the shape of a sequence
    // number is checked as written rather than as parsed. And digits alone
    // are still not enough: the sequence column is a Postgres integer, so a
    // number too big for it is refused here rather than surfacing as the
    // database's own error about a page that could never exist.
    const said = given(query.after);
    const after = said === undefined ? 0 : Number(said);
    if (
      said !== undefined &&
      (!/^\d+$/u.test(said) ||
        !Number.isSafeInteger(after) ||
        after > 2_147_483_647)
    ) {
      return invalid(
        reply,
        `"${said}" is not a sequence number this feed issued. Send back the ` +
          `next an earlier page answered with, or leave after out to start ` +
          `at the first change.`,
      );
    }

    const page = await listRunEvents(auth, runId, { after });
    if (page === undefined) return notFound(reply, NO_SUCH_RUN);

    return reply.send({
      events: page.events.map(describedEvent),
      next: page.next,
      done: page.done,
    });
  });

  /**
   * Stop a run.
   *
   * Conversations still queued end here and now; ones already with a simulator
   * are told to stop and land as canceled when they do. The reply is the run
   * as it stands, so a caller reads the counts as soon as they are honest —
   * and they are null until all three of them are.
   *
   * Canceling a canceled run is nothing to do and answers the run; canceling
   * one that already finished is refused out loud, because the caller missed
   * and should know it.
   */
  app.post(RUN_CANCEL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };

    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // The header comes back from the write itself rather than from a second
    // read: it is the run as the cancel left it, which is the thing a caller
    // asked about.
    const canceled = await cancelRun(auth, runId);
    if (canceled === undefined) return notFound(reply, NO_SUCH_RUN);

    const described = await runAsItStands(
      auth,
      runId,
      options.baseUrl,
      canceled,
    );
    if (described === undefined) return notFound(reply, NO_SUCH_RUN);
    return reply.send(described);
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault, and each carrying the sentence the layer below wrote.
   *
   * The sentences are relayed word for word on purpose. A client relays them
   * to a terminal a coding agent is reading, so the wording is the contract —
   * and paraphrasing here would put a second, quieter copy of it in a file
   * nobody would think to check.
   */
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof RunWriteRefusedError) {
      // A map from the reason to the answer, and nothing else. The sentence is
      // written whole where the refusal was decided and travels untouched:
      // finishing one off here would put half the contract in a second file,
      // and the wire text would exist nowhere as one string to check.
      switch (error.reason) {
        case "no_such_connection":
        case "connection_not_on_agent":
          return notFound(reply, error.message);
        case "no_adapter":
          return noAdapter(reply, error.message);
        case "test_not_applicable":
          return sendRefusal(reply, "test_not_applicable", error.message);
        case "already_finished":
          return conflict(reply, error.message);
        default:
          return unprocessable(reply, error.message);
      }
    }

    // A project with no judge, refused before any conversation is dialed. Its
    // own code and its own sentence, because the fix is one page away and
    // nothing about the selection is wrong.
    if (error instanceof JudgeNotConfiguredError) {
      return sendRefusal(
        reply,
        "judge_not_configured",
        REFUSALS.judgeNotConfigured(error.projectId),
      );
    }

    // A key reused over a different request. Answering the original run would
    // tell somebody their new selection had started when it had not, so this
    // is refused out loud and names both moves that fix it.
    if (error instanceof IdempotencyConflictError) {
      return sendRefusal(
        reply,
        "idempotency_conflict",
        REFUSALS.idempotencyConflict(error.idempotencyKey),
      );
    }

    // Reachable only in a race — the project was checked before the write, and
    // this is what a delete landing in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    throw error;
  });
}
