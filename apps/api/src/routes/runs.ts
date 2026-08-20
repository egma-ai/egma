import {
  authorize,
  cancelRun,
  connectionTypeOf,
  foldRun,
  foldSimulation,
  getAgent,
  getConnection,
  getGradingPlan,
  getRun,
  getSimulation,
  IdempotencyConflictError,
  listRunHistory,
  planRun,
  listRunEvents,
  listSimulations,
  NotPermittedError,
  platformFacts,
  ProjectOutsideOrganizationError,
  readAssertionShelf,
  readRunVerdicts,
  readVerdicts,
  rerunSimulation,
  simulationRerunAlreadyStarted,
  retryRun,
  RUN_STATUSES,
  RunRetryRefusedError,
  SimulationRerunRefusedError,
  RunWriteRefusedError,
  startRun,
  VERDICTS,
  type AssertionWords,
  type AuthContext,
  type ConductedSimulation,
  type GradingPlan,
  type MockToolCoverage,
  type MockToolSnapshot,
  type Run,
  type RunFold,
  type RunHistoryEntry,
  type RunHistoryRequest,
  type RecordedVerdict,
  type RunEvent,
  type RunStatus,
  type RunPlan,
  type RunVerdicts,
  type SimulationFold,
  type SimulationVerdicts,
  type Verdict,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import {
  actingIn,
  cannotActIn,
  reachingIn,
  refuseActing,
} from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { describedMockTool } from "../http/mock-tools.ts";
import {
  describedOutcome,
  describedVerdict,
  onlyReporting,
} from "../http/verdicts.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, projectNamed, text } from "../http/reading.ts";
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
/**
 * Run it again, under today's conditions.
 *
 * **A verb on the earlier run, and deliberately not a field on the create
 * body.** Everything it uses — the agent, the connection, the exact frozen test
 * versions — comes off the run in the address, so a run that says it retries
 * another one really does execute what that one executed. There is no key in the
 * create body that could set `retry_of_run_id`, and there never will be.
 */
export const RUN_RETRY_PATH = "/api/runs/:runId/retry";
/** Run one terminal simulation again as one new run. */
export const SIMULATION_RERUN_PATH =
  "/api/simulations/:simulationId/rerun";

type Body = Record<string, unknown>;

/**
 * The largest page of history this list will serve.
 *
 * The same cap the data-access layer enforces, named here because a refusal has
 * to say what it is — and a cap said in two places is a cap that will one day
 * disagree with itself, so this is the only copy above that layer.
 */
const LARGEST_RUN_PAGE = 200;

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
 * **Four facts, kept apart, and `foldSimulation` is what keeps them apart.**
 * `status` is the machinery; `grading` is where the judging stands; `verdict` is
 * what was decided; and `null` on the verdict means nobody has decided yet,
 * which is not a verdict and must never read as one. The fold's rules are the
 * governing ones and live in `@egma/db`: a `failed` execution reads `errored`
 * because it is egma's own failure rather than the agent's, a `skipped` or
 * `canceled` one reads `skipped` because there was no conversation to judge, and
 * only a `completed` one takes its verdict from grader rows.
 *
 * `grading` gained two words in this build — `not_required` for a conversation
 * that will never be judged because it never happened, and `waiting` for one
 * that has not finished. Both used to read `pending`, which left a page waiting
 * forever on work nobody filed.
 *
 * **The verdict is folded over the required lane alone**, which is what the read
 * hands over: a copy somebody made `required: false` is judged exactly like any
 * other and writes exactly the same rows — its fraction is the whole reason it
 * was switched on — and it can never fail this conversation. `diagnostics` is
 * that other lane, reported apart and never added in. Folding the two together
 * would make a diagnostic a blocker; leaving the second lane out would make it
 * judge in silence.
 *
 * Execution and grading are separate facts and are reported separately. A
 * conversation can be `completed` and ungraded, and a reader that collapsed the
 * two would call a run finished while its judgment was still being written.
 *
 * `mock_tool_coverage` is here because comparing two of these numbers is only
 * valid when both conversations were conducted in the same world. A simulation
 * whose tools were answered by mock tools and one whose tools ran for real met
 * different worlds, and this is where a reader finds that out — off the
 * conversation itself, with nothing else to fetch and nothing editable to ask.
 * Null says the agent was never asked what tools it has, so nothing was learned
 * and nothing is claimed.
 */
function describedSimulation(
  one: ConductedSimulation,
  judged: SimulationVerdicts | undefined,
  rows: readonly RecordedVerdict[],
  words: AssertionWords | undefined,
  diagnostic: ReadonlySet<string>,
): Record<string, unknown> {
  const fold = foldSimulation(one.status, judged?.outcome);
  return {
    id: one.id,
    position: one.position,
    test_id: one.testId,
    test_name: one.testName,
    test_version_id: one.testVersionId,
    persona_id: one.personaId,
    persona_name: one.personaName,
    // The pin beside the identity, on the test pin's own terms: the name reads
    // as it stands today, and this is exactly who called on the day.
    persona_version_id: one.personaVersionId,
    status: one.status,
    grading: fold.grading,
    verdict: fold.verdict,
    score: fold.score ?? null,
    // Skipped and errored are carried out whole rather than folded into the
    // other two: missing judgment is not a pass and a broken judge is not a
    // failing agent, and a summary that hid either would say the opposite of
    // what happened.
    counts: fold.counts,
    // What only reported, beside what decided. Null where nothing diagnostic
    // judged this conversation — an empty lane described anyway would be
    // furniture about a feature nobody switched on.
    diagnostics: describedOutcome(judged?.diagnostics),
    // Every judged assertion, whole. The fold above says how many passed; this
    // says which ones and why, because "2 of 3 passed" without the rationale
    // sends somebody to read a transcript to work out what egma already knew.
    // What each row carries is the one shape both surfaces that draw a judgment
    // send, decided in `http/verdicts.ts` rather than here and again there.
    verdicts: rows.map((its) => describedVerdict(its, words, diagnostic)),
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
 * The immutable grader version id is the only model-execution pin. The model
 * is not copied into this response or durable plan, and deployment credentials
 * never enter either one.
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
      graders: group.items.map(describedPlanItem),
    })),
  };
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
  wordsBySimulation?: ReadonlyMap<string, AssertionWords>,
): Record<string, unknown> {
  const bySimulation = new Map(
    (judged?.simulations ?? []).map((its) => [its.simulationId, its] as const),
  );
  const gradedCount = simulations.filter((one) => bySimulation.has(one.id)).length;
  // Every conversation's own answer is the required lane's — `readRunVerdicts`
  // split the lanes before it folded — so this run-level fold votes once per
  // conversation over decisions that could actually fail one.
  const fold = foldRun(
    one.status,
    one.expectedSimulationCount,
    simulations.map((its) =>
      foldSimulation(its.status, bySimulation.get(its.id)?.outcome),
    ),
  );
  // Which graders only report, off the run's own per-grader fold rather than
  // read a second time: one answer about `required`, taken where the lanes were
  // split, so a row's marking and the header's arithmetic cannot disagree. A
  // grader absent from it is required — see `onlyReporting`.
  const diagnostic = onlyReporting(judged?.byGrader);
  return {
    id: one.id,
    // Which project this run happened in. A run is reached by an address with no
    // project in it — the one a terminal prints — so a page that wants to open
    // the project's own view of it has no other way to learn where it belongs.
    project_id: one.projectId,
    status: one.status,
    agent_id: one.agentId,
    connection_id: one.connectionId,
    connection_type: one.connectionSnapshot.type,
    modality: one.connectionSnapshot.modality,
    // The connection's non-secret shape as this run executed over it, frozen at
    // start. Connections are unversioned, so this is the only record of what the
    // run actually reached — and there is no field here a credential could ride
    // in: the secret lives in its own sealed column and was never copied.
    connection_snapshot: {
      type: one.connectionSnapshot.type,
      modality: one.connectionSnapshot.modality,
      topology: one.connectionSnapshot.topology,
      environment: one.connectionSnapshot.environment,
      config: one.connectionSnapshot.config,
    },
    label: one.label,
    // The run this one retries, and null on every run that retries nothing.
    // Only the server-derived Retry can ever set it.
    retry_of_run_id: one.retryOfRunId,
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
    // How many conversations have landed terminal, and how many of those left
    // something to judge. Machinery, reported as machinery: a run whose every
    // conversation was skipped has finished all of them and made none gradable.
    finished_count: fold.finished,
    gradable_count: fold.gradable,
    // Where every conversation of this run stands, counted by machinery state.
    // `skipped` has its own number here for the reason it has its own column:
    // egma declining to conduct a conversation says nothing about the agent.
    simulation_counts: fold.simulations,
    /*
     * The run's verdict, folded over its conversations' verdicts — one vote
     * each, so a test with forty expected behaviors cannot outvote a test with
     * two. Over the required copies alone, since that is what each
     * conversation's own answer was folded from: a run fails when a grader that
     * can fail one did, and what a diagnostic said is beside it and never in
     * it.
     *
     * **Null means nobody has finished looking**, and it stays null until every
     * conversation has a verdict. The two available alternatives are both lies:
     * the fold so far reads as a finished result, and `passed` because nothing
     * has failed yet reads as a clean sweep nobody earned. A completed run may
     * perfectly well read `failed` — the machinery finished and what it found
     * was bad — and a run whose every conversation was skipped reads `skipped`
     * rather than sitting on "awaiting grading" for a judgment nobody will make.
     */
    verdict: fold.verdict,
    // Score and counts stay at the grader's grain and answer a different
    // question: how many judged *checks* passed, across the whole run. Both are
    // the fold over the verdict rows, which is what `by_grader` beneath them
    // breaks down — they are deliberately not the simulation-level counts above.
    score: judged?.outcome.score ?? null,
    counts: judged?.outcome.counts ?? null,
    diagnostics: describedOutcome(judged?.diagnostics),
    // Every grader that judged, both lanes, each saying which it is in. A
    // diagnostic's fraction is exactly what somebody switched it on to read, so
    // leaving it off this list would make it judge in silence — and folding it
    // into the headline above would make it a blocker.
    by_grader: (judged?.byGrader ?? []).map((its) => ({
      grader_id: its.graderId,
      required: its.required,
      verdict: its.outcome.verdict,
      score: its.outcome.score ?? null,
      counts: its.outcome.counts,
    })),
    simulations: simulations.map((its) =>
      describedSimulation(
        its,
        bySimulation.get(its.id),
        rowsBySimulation?.get(its.id) ?? [],
        wordsBySimulation?.get(its.id),
        diagnostic,
      ),
    ),
  };
}

/**
 * The plan a run froze, as a reader of one meets it.
 *
 * **The state is the first thing, because it decides how much of the rest can be
 * believed.** `run_start` is a pin made in the transaction that created the run.
 * `migration_snapshot` was captured during an upgrade, and a page must say so
 * rather than presenting it as something decided when the run began.
 * `not_recorded` has no plan at all, and the honest answer is an empty list — a
 * plan reconstructed from today's graders would be a claim about an old run that
 * nobody can check.
 *
 * The groups keep their tagged shape whole. An authored item has a grader
 * identity and a pinned grader version; the built-in has a reserved key and an
 * engine version and takes its priority one behavior at a time. Folding the two
 * into one shape of mostly-null fields would make every reader guess which half
 * applied.
 */
function describedGradingPlan(plan: GradingPlan): Record<string, unknown> {
  return {
    state: plan.state,
    captured_at: plan.capturedAt?.toISOString() ?? null,
    groups: plan.groups.map((group) =>
      group.tag === "version"
        ? {
            tag: "version",
            test_id: group.testId,
            test_version_id: group.testVersionId,
            test_name: group.testName,
            items: group.items.map(describedPlanItem),
          }
        : { tag: "legacy_testless", items: group.items.map(describedPlanItem) },
    ),
  };
}

/**
 * One plan item, as every read of a plan describes it — the review step's
 * answer and a frozen plan's, through one function so the two cannot drift.
 *
 * `kind` stays on the wire and stays `authored`, though there is only one kind
 * left: the field is what a client already switches on, and taking it away to
 * save a word would break every reader for no gain. `required` is here so a
 * page can mark a diagnostic apart from the checks that can fail the run.
 */
function describedPlanItem(
  item: GradingPlan["groups"][number]["items"][number],
): Record<string, unknown> {
  return {
      kind: "authored",
      grader_id: item.graderId,
      grader_version_id: item.graderVersionId,
      name: item.graderName,
      library_id: item.libraryId,
      required: item.required,
      scope: item.scope,
  };
}

/**
 * One run of a history, as a list draws it.
 *
 * Deliberately not the whole run: a list of fifty runs each carrying two hundred
 * conversations would be a page nobody asked for. What a row shows is the four
 * facts kept apart — the run's machinery, how its conversations are distributed
 * across theirs, where grading stands, and the folded verdict — plus enough
 * identity to link at the agent and the connection it used.
 */
function describedHistoryEntry(
  entry: RunHistoryEntry,
  fold: RunFold,
): Record<string, unknown> {
  const { run } = entry;
  return {
    id: run.id,
    project_id: run.projectId,
    status: run.status,
    label: run.label,
    agent_id: run.agentId,
    connection_id: run.connectionId,
    connection_type: run.connectionSnapshot.type,
    modality: run.connectionSnapshot.modality,
    environment: run.connectionSnapshot.environment,
    retry_of_run_id: run.retryOfRunId,
    expected_simulation_count: run.expectedSimulationCount,
    completed_count: run.completedCount,
    failed_count: run.failedCount,
    canceled_count: run.canceledCount,
    skipped_count: run.skippedCount,
    simulation_counts: fold.simulations,
    finished_count: fold.finished,
    gradable_count: fold.gradable,
    graded_count: fold.graded,
    // Null until every conversation has a verdict. A row that guessed early
    // would put a red mark on a run nobody has finished judging.
    verdict: fold.verdict,
    score: fold.score ?? null,
    verdict_counts: fold.counts,
    created_at: run.createdAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The filters on a history read, checked one at a time and refused by name.
 *
 * Every id is checked for its own prefix rather than passed through: a query
 * naming `agent=tst_1` would otherwise match nothing and read as *this agent has
 * never been run*, which is a different and false sentence. The same reasoning
 * for the status and the verdict — an unknown word is refused with the list
 * rather than quietly ignored, because a filter that was dropped leaves somebody
 * reading an answer as though it had applied.
 */
type Narrowing =
  | { readonly filter: RunHistoryRequest }
  | { readonly refusal: string };

function readNarrowing(query: Record<string, unknown>): Narrowing {
  const filter: {
    agentId?: string;
    connectionId?: string;
    testId?: string;
    status?: RunStatus;
    verdict?: Verdict;
    since?: Date;
    until?: Date;
  } = {};

  const ids: readonly [string, "agt" | "con" | "tst", "agentId" | "connectionId" | "testId", string][] = [
    ["agent", "agt", "agentId", "agt_ id of the agent whose runs you want"],
    [
      "connection",
      "con",
      "connectionId",
      "con_ id of the connection whose runs you want",
    ],
    ["test", "tst", "testId", "tst_ id of the test whose runs you want"],
  ];

  for (const [name, prefix, field, instead] of ids) {
    const said = given(text(query[name]));
    if (said === undefined) continue;
    if (!isId(prefix, said)) {
      return {
        refusal:
          `"${said}" is not a ${name} id. Send the ${instead}, or leave it ` +
          `out for every run in the project.`,
      };
    }
    filter[field] = said;
  }

  const status = given(text(query.status));
  if (status !== undefined) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      return {
        refusal:
          `"${status}" is not a run status. Send one of ` +
          `${RUN_STATUSES.join(", ")}, or leave status out for every run.`,
      };
    }
    filter.status = status as RunStatus;
  }

  const verdict = given(text(query.verdict));
  if (verdict !== undefined) {
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      return {
        refusal:
          `"${verdict}" is not a verdict. Send one of ${VERDICTS.join(", ")}, ` +
          `or leave verdict out for every run. A run still being judged has no ` +
          `verdict yet and matches none of them.`,
      };
    }
    filter.verdict = verdict as Verdict;
  }

  const moments: readonly [string, "since" | "until", string][] = [
    ["since", "since", "at or after"],
    ["until", "until", "before"],
  ];
  for (const [name, field, meaning] of moments) {
    const said = given(text(query[name]));
    if (said === undefined) continue;
    const moment = new Date(said);
    if (Number.isNaN(moment.getTime())) {
      return {
        refusal:
          `"${said}" is not a moment this list can read. Send ${name} as an ` +
          `RFC 3339 timestamp — runs started ${meaning} it — or leave it out.`,
      };
    }
    filter[field] = moment;
  }

  return { filter };
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

  // Everything about the graders that judged anywhere in this run, read once.
  // Which entry a copy points at cannot be edited at all and what that entry is
  // called is one row on the shelf, so these are facts about the run rather than
  // about any conversation in it — and reading them per conversation would be
  // two hundred copies of one answer. The run's own per-grader fold already
  // names every copy that wrote a row, which is exactly the set.
  const shelf = await readAssertionShelf(
    auth,
    (judged?.byGrader ?? []).map((its) => its.graderId),
  ).catch(() => undefined);

  // The rows themselves, one conversation at a time. The run fold deliberately
  // does not carry them — a run of two hundred conversations would be a page
  // nobody asked for — so they are gathered only for the conversations this run
  // actually has, and only for the ones something has judged.
  //
  // The words behind their assertion keys come with them, off the shelf above
  // plus the one thing that genuinely varies: the version each conversation was
  // pinned to. It is the same trip, because a conversation with rows is a
  // conversation whose keys are about to be shown.
  //
  // **A few at a time, never all at once.** A run holds as many conversations as
  // somebody selected tests and callers, and firing a query per conversation the
  // moment the page is asked for would put a burst the size of the run on a pool
  // sized for a request. The work is the same either way; only how much of it is
  // in flight changes.
  const rowsBySimulation = new Map<string, readonly RecordedVerdict[]>();
  const wordsBySimulation = new Map<string, AssertionWords>();
  await aFewAtATime(judged?.simulations ?? [], async (its) => {
    const read = await readVerdicts(auth, its.simulationId).catch(() => undefined);
    if (read === undefined) return;
    rowsBySimulation.set(its.simulationId, read.verdicts);

    // The pinned version is in Postgres and the rows are in the verdict store,
    // so this failing is a different outage from that one — and the page is
    // still worth sending with the keys unresolved, which is exactly what a
    // caller saw before anything resolved them at all.
    const words = await shelf
      ?.forSimulation(its.simulationId)
      .catch(() => undefined);
    if (words !== undefined) wordsBySimulation.set(its.simulationId, words);
  });

  return describedRun(
    header,
    simulations,
    baseUrl,
    judged,
    rowsBySimulation,
    wordsBySimulation,
  );
}

/**
 * How many conversations of a run are read at once.
 *
 * Small enough that one request cannot exhaust a connection pool sized for
 * many, large enough that a run of a dozen is still one round of waiting. It is
 * a ceiling on concurrency rather than a budget on work: every conversation is
 * read either way.
 */
const CONVERSATIONS_READ_AT_ONCE = 8;

async function aFewAtATime<Item>(
  items: readonly Item[],
  read: (item: Item) => Promise<void>,
): Promise<void> {
  for (let at = 0; at < items.length; at += CONVERSATIONS_READ_AT_ONCE) {
    await Promise.all(
      items.slice(at, at + CONVERSATIONS_READ_AT_ONCE).map(read),
    );
  }
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
    const query = (request.query ?? {}) as Body;

    // The role is checked before anything is read, which is the stance the
    // factories take for the same reason: a viewer is refused for being a
    // viewer, rather than after a read that tells them what is there.
    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const pinned = pinnedVersions(body.test_versions ?? []);
    if ("refusal" in pinned) return unprocessable(reply, pinned.refusal);

    // The query and the body, `projectNamed`'s one rule — the same one Cancel
    // and Retry beside this keep. A page starting a run names its project in
    // the address; a terminal posts it in the body.
    const acting = await actingIn(auth, projectNamed(query, body));
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
   * One page of this project's run history, newest first.
   *
   * **Every filter here is a narrowing and none of them is a predicate.** Agent,
   * connection, test, machinery status and a date window are all facts of the
   * run table; the verdict is the one that is not, and it is applied to the fold
   * rather than to the query, because a verdict is computed at read time from
   * rows in another store and there is nothing stored anywhere for a `where` to
   * name.
   *
   * **A verdict-filtered page may come back short and still carry a cursor.**
   * That is not a bug and the sentence is worth keeping: `next_cursor` promises
   * there is more to *look at*, never that there is more to show. Asking again
   * with it continues from exactly where the sweep stopped.
   */
  app.get(RUNS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Record<string, unknown>;

    const acting = await actingIn(auth, given(text(query.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(text(query.cursor));
    if (cursor !== undefined && !isId("run", cursor)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(cursor),
      );
    }

    const narrowing = readNarrowing(query);
    if ("refusal" in narrowing) {
      return invalid(reply, narrowing.refusal);
    }

    // A page size a client asked for, checked here rather than left to the
    // layer beneath — which raises rather than answers, because a bad limit at
    // that seam is a caller of egma's own that has lost track of itself.
    const said = given(text(query.limit));
    const limit = said === undefined ? undefined : Number(said);
    if (
      said !== undefined &&
      (!/^\d+$/u.test(said) ||
        limit === undefined ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > LARGEST_RUN_PAGE)
    ) {
      return invalid(
        reply,
        `"${said}" is not a page size this list can serve. Send limit as a ` +
          `whole number between 1 and ${String(LARGEST_RUN_PAGE)}, or leave ` +
          `it out for the default.`,
      );
    }

    const page = await listRunHistory(acting.auth, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
      ...narrowing.filter,
    });

    return reply.send({
      items: page.items.map((entry) =>
        describedHistoryEntry(entry, entry.fold),
      ),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * The run as it now stands, with every conversation in it, what it froze to
   * judge itself by, and the two identities it executed against.
   *
   * The agent and the connection are read **as they now stand, archived or
   * not**, and that is the whole of what "past runs remain readable" means: a
   * connection somebody archived last week is still what this run went over, and
   * a page that could not name it would leave the evidence uninterpretable. What
   * archiving takes away is entry into new work, which is enforced where new
   * work is created.
   */
  app.get(RUN_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as Record<string, unknown>;

    /**
     * **The project the caller named, exactly as the list beside it reads
     * one.**
     *
     * This route read none, and every read under it narrows by the acting
     * project — so a browser could list a project's runs, follow a row into
     * one, and be told *no run of yours has that id* about the run it had just
     * been shown. A session's acting project is the organization's **first**,
     * so the whole of run detail worked in exactly one project and in no other,
     * and every test in the repository passed: they authenticate with keys, and
     * a key's own project is the project its runs are in.
     *
     * **`reachingIn` rather than `actingIn`, and the difference is a route this
     * one already has.** A run id is unique inside the organization, so naming
     * no project here is a filter left off rather than a destination left
     * unsaid. `actingIn` would answer a credential that names none — a key for
     * the whole organization — with *name the project*, which is a 400 to a
     * terminal following the `results_url` egma printed for it. A session names
     * none only on that same address, and carries a project of its own either
     * way.
     */
    const acting = await reachingIn(auth, given(text(query.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const who = acting.auth;

    const header = await getRun(who, runId);
    if (header === undefined) return notFound(reply, NO_SUCH_RUN);

    const described = await runAsItStands(
      who,
      runId,
      options.baseUrl,
      header,
    );
    if (described === undefined) return notFound(reply, NO_SUCH_RUN);

    const plan = await getGradingPlan(who, runId);
    const ranAgainst = await getAgent(who, header.agentId);
    const ranOver = await getConnection(
      who,
      header.agentId,
      header.connectionId,
    );

    return reply.send({
      ...described,
      // Absent only where the run itself is not this caller's, which cannot
      // happen here — but a plan row can be missing on an instance whose
      // upgrade has not run, and `null` says so rather than inventing a state.
      grading_plan: plan === undefined ? null : describedGradingPlan(plan),
      agent:
        ranAgainst === undefined
          ? null
          : {
              id: ranAgainst.id,
              name: ranAgainst.name,
              archived: ranAgainst.archivedAt !== null,
            },
      connection:
        ranOver === undefined
          ? null
          : {
              id: ranOver.id,
              name: ranOver.name,
              type: ranOver.type,
              archived: ranOver.archivedAt !== null,
            },
    });
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
    const query = (request.query ?? {}) as {
      readonly after?: string;
      readonly project?: string;
    };

    // The project the caller named, for the reason the run's own read beside
    // this one gives: `listRunEvents` narrows by the acting project, so a feed
    // that read no project followed a run in the organization's first project
    // and answered "no such run" about every other one. `reachingIn` for the
    // reason that read gives too — a feed a caller can open and cannot follow
    // is the same fault as a run it can find and cannot read.
    const acting = await reachingIn(auth, given(text(query.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

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

    const page = await listRunEvents(acting.auth, runId, { after });
    if (page === undefined) return notFound(reply, NO_SUCH_RUN);

    return reply.send({
      events: page.events.map(describedEvent),
      next: page.next,
      done: page.done,
    });
  });

  /**
   * Run it again, under today's conditions.
   *
   * **Server-derived, and that is what makes the link trustworthy.** The agent,
   * the connection and the exact frozen test versions come off the run in the
   * address; the body carries an idempotency key and nothing else. There is no
   * field on `POST /api/runs` that can set `retry_of_run_id`, so a run that says
   * it retries another one really does execute what that one executed.
   *
   * **It refuses rather than substituting.** Every resource the earlier run used
   * is rechecked as it stands now, and one that is archived or no longer
   * applicable refuses the whole Retry by name. Quietly swapping in a live
   * replacement would answer "we ran it again" about a different run, and the
   * two results would then be compared as though they were about the same thing.
   *
   * **It is honestly not a replay, and the answer says so by what it resolves.**
   * Persona and grader versions, project-default graders, the judge setting, the
   * connection's current configuration, and the project's mock tools are all
   * resolved fresh — because a retry under current conditions is what this is.
   */
  app.post(RUN_RETRY_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;

    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const acting = await actingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);

    // Required here for the reason it is required on a start: a retry dials a
    // real agent and spends a real judge, and an answer lost on the way back
    // must never become a second conversation.
    const idempotencyKey = given(text(body.idempotency_key));
    if (idempotencyKey === undefined) {
      return unprocessable(reply, REFUSALS.idempotencyKeyRequired);
    }

    const started = await retryRun(acting.auth, runId, { idempotencyKey });
    if (started === undefined) return notFound(reply, NO_SUCH_RUN);

    return reply
      .code(201)
      .send(describedRun(started, started.simulations, options.baseUrl));
  });

  /**
   * Run one terminal simulation again under today's conditions.
   *
   * The source in the address supplies the agent, connection, exact test
   * version, and persona identity. The body can only name the new run and the
   * client's attempt, so it cannot turn this action into a different
   * simulation while claiming lineage to the source.
   */
  app.post(SIMULATION_RERUN_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { simulationId } = request.params as { simulationId: string };
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;

    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const acting = await actingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const label = given(text(body.label));
    if (label === undefined) {
      return unprocessable(
        reply,
        "Running a simulation again requires a run name. Send label with a " +
          "name that will identify the new run, then try again.",
      );
    }
    const idempotencyKey = given(text(body.idempotency_key));
    if (idempotencyKey === undefined) {
      return unprocessable(reply, REFUSALS.idempotencyKeyRequired);
    }

    // The first attempt already passed deployment readiness and may already be
    // dialing. Answer it before mutable readiness is asked again; only a key
    // with no remembered run reaches the carrier check below.
    const remembered = await simulationRerunAlreadyStarted(
      acting.auth,
      simulationId,
      { label, idempotencyKey },
    );
    if (remembered !== undefined) {
      return reply
        .code(201)
        .send(describedRun(remembered, remembered.simulations, options.baseUrl));
    }

    const source = await getSimulation(acting.auth, simulationId);
    if (source === undefined) {
      return notFound(
        reply,
        `There is no simulation at this address. Check the link, or open the ` +
          `run that contains it.`,
      );
    }

    // A one-simulation re-run is still a run start. It must pass the same
    // deployment readiness check as POST /api/runs before it can spend the
    // platform's carrier.
    const carrier = phoneReadiness(await platformFacts());
    if (carrier.state !== "ready") {
      const type = await connectionTypeOf(acting.auth, source.connectionId);
      if (type !== undefined && NEEDS_THE_PLATFORMS_CARRIER.includes(type)) {
        return phoneSetupRequired(reply, phoneSetupRequiredMessage(carrier));
      }
    }

    const started = await rerunSimulation(acting.auth, simulationId, {
      label,
      idempotencyKey,
    });
    if (started === undefined) {
      return notFound(
        reply,
        `There is no simulation at this address. Check the link, or open the ` +
          `run that contains it.`,
      );
    }

    return reply
      .code(201)
      .send(describedRun(started, started.simulations, options.baseUrl));
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
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;

    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    /**
     * **The project the caller named, exactly as Retry beside it reads one.**
     *
     * This route used to read none, and `cancelRun` narrows by the acting
     * project — so a session, whose acting project is the organization's
     * *first*, could not cancel a run in any other one. The page was looking
     * straight at the run and egma answered that there is no such run.
     *
     * **A key naming nothing still lands where it always did** — its own
     * project, or the whole organization for a key minted for the whole
     * organization. That is `reachingIn`'s absent case, and it is the one this
     * route answered before it read any project at all: a run id is unique in
     * the organization, so Cancel does not need a project to know which run it
     * was handed.
     */
    const acting = await reachingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);

    // The header comes back from the write itself rather than from a second
    // read: it is the run as the cancel left it, which is the thing a caller
    // asked about.
    const canceled = await cancelRun(acting.auth, runId);
    if (canceled === undefined) return notFound(reply, NO_SUCH_RUN);

    const described = await runAsItStands(
      acting.auth,
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
    // A Retry that could not be derived. Its own code and its own sentence,
    // relayed word for word from where the resource was decided: the refusal
    // names what stopped it, points at the builder, and promises the earlier run
    // was not touched.
    if (error instanceof RunRetryRefusedError) {
      return sendRefusal(reply, "retry_unavailable", error.message);
    }

    if (error instanceof SimulationRerunRefusedError) {
      return error.reason === "not_terminal"
        ? sendRefusal(reply, "simulation_rerun_unavailable", error.message)
        : unprocessable(reply, error.message);
    }

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
