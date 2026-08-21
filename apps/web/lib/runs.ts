import type {
  CreateRunResponse,
  GetRunPlanResponse,
  GetRunResponse,
  ListRunEventsResponse,
  ListRunsResponse,
} from "@egma/platform-api/client";

/**
 * Planning a run and starting it, as the API answers and accepts them.
 *
 * A **run** is one execution of a selection of tests against one agent over one
 * connection. It holds one **simulation** per test per persona — one
 * conversation, start to finish — and each of those is judged by **graders**
 * into a **verdict**.
 *
 * The shapes are the API's own, field names included. Renaming its fields on
 * the way in would put a second vocabulary between the contract and the page,
 * and the two would drift the first time the API grew a field.
 *
 * **The whole point of this module is that the browser decides nothing.** Which
 * versions would be pinned, which conversations would be skipped and why, which
 * graders would judge and at which versions — every one of those is answered
 * by `GET /v1/run-plan`, which is the
 * same resolution `POST /v1/runs` performs. A page that worked any of it out
 * for itself would be a second opinion, and the moment the two disagreed
 * somebody would approve one run and start another.
 */

export type PlanCapabilities = GetRunPlanResponse["connection"]["capabilities"];

/**
 * One running copy a run would freeze, or has frozen.
 *
 * **One shape, where there used to be two.** The second was the
 * expected-behaviors built-in — a rowless sentinel with a reserved key and an
 * engine version instead of an identity. It is an ordinary running copy now,
 * seeded into every project, so it arrives here like everything else and there
 * is nothing left for a second arm to describe. `kind` stays on the wire
 * because that is what a reader already switches on.
 *
 * `required` is `false` for a diagnostic: judged and shown exactly like any
 * other, and never able to fail the run.
 */
export type PlanGrader =
  GetRunPlanResponse["tests"][number]["graders"][number];

/**
 * Why egma would not conduct a test's conversations at all.
 *
 * **Two reasons, never one.** `required_capability_unsupported` is a settled
 * fact about the target and the fix is to write a different test;
 * `required_capability_unknown` means nobody has measured this connection and a
 * Refresh may change the answer. A page that folded them would send somebody
 * the wrong way, and neither is ever a failure of the agent.
 */
export type PlanSkip = NonNullable<
  GetRunPlanResponse["tests"][number]["skip"]
>;
export type PlannedTest = GetRunPlanResponse["tests"][number];
export type RunPlan = GetRunPlanResponse;

/** A started run, as far as a builder needs to read one. */
export type StartedRun = CreateRunResponse;

/** Where the run builder lives inside one project. */
export const RUN_BUILDER_SECTION = "runs";
export const RUN_BUILDER_STEP = "new";

/**
 * The agent a builder should open with, taken from the address.
 *
 * **It preselects and never bypasses.** Arriving from an agent's page fills the
 * first step in; every later check — the connection is that agent's and the
 * test applies to it — still runs, on the server, exactly
 * as it does for somebody who chose the agent from the list.
 */
export function preselectedAgent(search: string): string | null {
  const named = new URLSearchParams(search).get("agent");
  return named === null || named.trim() === "" ? null : named.trim();
}

/**
 * How a page words one skip.
 *
 * Two sentences, because the two reasons have two different next moves, and
 * neither of them says anything about the agent. This is the browser's own
 * wording rather than a relayed refusal: nothing is being refused, and a run
 * that skips a test still starts.
 */
export function skipExplanation(skip: PlanSkip): string {
  const named = skip.capabilities.join(", ");
  return skip.reason === "required_capability_unsupported"
    ? `This connection was measured and does not support ${named}. Egma will not conduct these simulations, and will say nothing about the agent. Choose a connection that supports it, or a test that does not require it.`
    : `Nobody has measured whether this connection supports ${named}. Egma will not conduct these simulations, and will say nothing about the agent. Refresh the connection's capabilities, then create the run again.`;
}

/** How many conversations a plan would produce, conducted and skipped alike. */
export function plannedSimulationCount(plan: RunPlan): number {
  return plan.runnableSimulationCount + plan.skippedSimulationCount;
}

/**
 * Whether this plan could be started at all, and what to say when it could not.
 *
 * A plan in which every simulation would be skipped is a run with
 * nothing to conduct, completing immediately having judged nothing. Offering
 * Start for it would be offering somebody a green tick nobody earned.
 *
 * **A plan that would judge nothing is not a blocker**, and deliberately so.
 * A project whose graders have all been deleted still runs, still records every
 * transcript, outcome and metric, and comes back with nothing judged — which is
 * a decision the project took on the Graders screen, not a mistake for a run
 * builder to overrule.
 */
export function whyNotStartable(plan: RunPlan): string | null {
  if (plan.runnableSimulationCount === 0) {
    return "Every simulation in this selection would be skipped, so this run would conduct nothing. Choose a connection that supports what these tests require, or choose tests that require less.";
  }
  return null;
}

/**
 * Whether this plan would judge anything at all, said where Start is offered.
 *
 * Not a blocker and not a refusal — a run in a project with no running graders
 * is a run somebody may legitimately want, and it still produces every
 * transcript, outcome and metric. It is worth saying out loud all the same,
 * because "no verdicts" and "everything passed" look identical on a results
 * page that has nothing red on it.
 */
export function judgesNothing(plan: RunPlan): boolean {
  // A plan with no tests in it judges nothing in the same trivial sense that an
  // empty selection conducts nothing, and saying so would be answering a
  // different question badly. The page happens to block that plan for another
  // reason first, which is exactly the kind of correctness that stops being
  // true when somebody reorders two lines.
  if (plan.tests.length === 0) return false;
  return plan.tests.every((test) => test.graders.length === 0);
}

/* ------------------------------------------------------------------------ *
 * Run history: reading runs, following one, and the two controls on it.
 * ------------------------------------------------------------------------ */

/**
 * The four verdict words. Four, and never three: `skipped` and `errored` are
 * answers in their own right, and a page that folded either into `failed` would
 * mark a suite red on the strength of egma's own outage.
 */
export type RunRow = ListRunsResponse["runs"][number];
export type RunHistoryPage = ListRunsResponse;
export type RunDetail = GetRunResponse;
export type RunSimulation = RunDetail["simulations"][number];
export type VerdictWord = NonNullable<RunRow["verdict"]>;

export const VERDICT_WORDS: readonly VerdictWord[] = [
  "passed",
  "failed",
  "skipped",
  "errored",
];

/** A run's machinery, and never a judgement of what it found. */
export type RunStatusWord = RunRow["status"];

export const RUN_STATUS_WORDS: readonly RunStatusWord[] = [
  "pending",
  "running",
  "completed",
  "canceled",
];

/** One conversation's machinery. `skipped` is born terminal and never claimed. */
export type SimulationStatusWord = RunSimulation["status"];

/**
 * Where the judging of one conversation stands — never what it decided.
 *
 * `not_required` is the one worth reading twice: a conversation egma never
 * conducted, or one somebody stopped, has no grading job and never will. Drawing
 * it as `pending` would leave a progress line waiting forever on work nobody
 * filed.
 */
export type GradingWord = RunSimulation["grading"];
export type VerdictCounts = RunRow["verdictCounts"];

/**
 * One run as a list draws it — the four facts, each as itself.
 *
 * `verdict` is `null` until every conversation has one, which is *nobody has
 * finished looking* and is not a verdict. `simulationCounts` is the machinery,
 * counted by state, with `skipped` its own number for the reason it is its own
 * column: egma declining to conduct a conversation says nothing about the agent.
 */
/** One item of a frozen plan. See `PlanGrader` for why there is one shape. */
export type FrozenPlan = NonNullable<RunDetail["gradingPlan"]>;
export type FrozenPlanGroup = FrozenPlan["groups"][number];
export type FrozenPlanItem = FrozenPlanGroup["items"][number];

/**
 * When a run's grading plan was decided, and whether one was decided at all.
 *
 * The state has to be shown, because it decides how much of the rest can be
 * believed. `migration_snapshot` was captured during an upgrade rather than when
 * the run began, and `not_recorded` has no plan at all — a page must say so
 * rather than presenting today's graders as something that was pinned.
 */
export type ConnectionSnapshot = RunDetail["connectionSnapshot"];

/** One mocked answer a run froze, as the snapshot carries it. */
export type FrozenMockTool = RunDetail["mockTools"]["defaults"][number];
export type MockToolSnapshot = RunDetail["mockTools"];

/**
 * One run, whole — what its own page reads.
 *
 * The agent and the connection come back **as they now stand, archived or not**.
 * That is what keeps a run readable after somebody archives what it went over:
 * archiving stops new work, and it must never make old evidence unnameable.
 */
/** One numbered change, as the feed carries it. */
export type RunEventFeed = ListRunEventsResponse;
export type RunEventRow = RunEventFeed["events"][number];

/**
 * The word this Retry attempt is remembered by.
 *
 * One key per run retried, so a lost answer becomes the run that already exists
 * rather than a second conversation with a real agent. It is derived from the
 * run rather than minted fresh on every click for exactly that reason: two
 * clicks are one attempt.
 */
export function retryKeyFor(runId: string): string {
  return `retry:${runId}`;
}

/**
 * What a run's page says about the plan it froze, given the state.
 *
 * Three states and three different sentences, because the state decides how much
 * of the plan can be believed. Nothing here reconstructs a plan from today's
 * graders — an old run that recorded none says so.
 */
export function planExplanation(state: FrozenPlan["state"]): string {
  if (state === "run_start") {
    return "Frozen when this run started. These are the exact grader versions it was judged against.";
  }
  if (state === "migration_snapshot") {
    return "Captured while Egma was upgraded, not when this run started. This run predates frozen plans and still had work outstanding, so the plan as it stood at the upgrade is what its grading used.";
  }
  return "This run predates frozen grading plans and had nothing outstanding when Egma was upgraded, so no plan was recorded. Egma will not reconstruct one from today's graders.";
}

/**
 * The sentence a run's page shows above Retry.
 *
 * **It is never described as a replay, and the wording is the reason.** Retry
 * copies the earlier selection and then resolves everything else as it stands
 * now — persona and grader versions, the project's running graders, the
 * connection's configuration, and the mocked world. Somebody who
 * read "run it again" and got different results would think egma was
 * inconsistent, when what actually changed is what they changed.
 */
export const RETRY_IS_NOT_A_REPLAY =
  "Retry starts a new run with this run's agent, connection and exact test versions. Everything else is resolved as it stands now — current persona and grader versions, the project's running graders, the connection, and Mock Tools. It is not an exact replay of the original conditions, and this run is not changed.";
