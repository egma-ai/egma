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
 * graders would judge and at which versions, and whether the project even has a
 * judge — every one of those is answered by `GET /api/run-plan`, which is the
 * same resolution `POST /api/runs` performs. A page that worked any of it out
 * for itself would be a second opinion, and the moment the two disagreed
 * somebody would approve one run and start another.
 */

export type CapabilityStanding = "supported" | "unsupported" | "not_measured";

/**
 * What is known about the connection a run would use — or the fact that nobody
 * has measured it.
 *
 * `unknown` and a `known` state with nothing in its list are different
 * sentences and lead somewhere different: one is a Refresh away from an answer,
 * the other is a settled fact about the target.
 */
export type PlanCapabilities =
  | { readonly state: "unknown" }
  | {
      readonly state: "known";
      readonly measured: readonly string[];
      readonly supported: readonly string[];
      readonly checked_at: string;
      readonly source: string;
    };

/**
 * Which model would judge, whose account would pay, and the honest answer when
 * neither question has one.
 *
 * `configured` carries the provider, the model and the **reference** to a key —
 * an organization credential or the deployment's `platform` sentinel. There is
 * no field here a secret could travel in, and there never will be.
 */
export type JudgeChoice =
  | { readonly tag: "not_required" }
  | {
      readonly tag: "configured";
      readonly provider: string;
      readonly model: string;
      readonly source: string;
    }
  | { readonly tag: "unavailable_at_capture" };

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
export type PlanGrader = {
  readonly kind: "authored";
  readonly grader_id: string;
  readonly grader_version_id: string;
  readonly name: string;
  /** The library entry this copy reads its definition through. */
  readonly library_id: string;
  readonly required: boolean;
  readonly scope: string;
  readonly judge: JudgeChoice;
};

/**
 * Why egma would not conduct a test's conversations at all.
 *
 * **Two reasons, never one.** `required_capability_unsupported` is a settled
 * fact about the target and the fix is to write a different test;
 * `required_capability_unknown` means nobody has measured this connection and a
 * Refresh may change the answer. A page that folded them would send somebody
 * the wrong way, and neither is ever a failure of the agent.
 */
export type PlanSkip = {
  readonly reason:
    | "required_capability_unsupported"
    | "required_capability_unknown";
  readonly capabilities: readonly string[];
};

export type PlannedTest = {
  readonly test_id: string;
  readonly test_version_id: string;
  readonly test_name: string;
  readonly personas: readonly {
    readonly persona_id: string;
    readonly persona_version_id: string;
    readonly name: string;
  }[];
  readonly required_capabilities: readonly string[];
  /** Null where the conversations would happen. */
  readonly skip: PlanSkip | null;
  readonly graders: readonly PlanGrader[];
};

export type RunPlan = {
  readonly agent_id: string;
  readonly connection_id: string;
  readonly connection: {
    readonly type: string;
    readonly modality: string;
    readonly environment: string | null;
    readonly capabilities: PlanCapabilities;
  };
  readonly judge:
    | { readonly state: "needs_setup" }
    | {
        readonly state: "configured";
        readonly provider: string;
        readonly model: string;
        readonly source: string;
      };
  readonly runnable_simulation_count: number;
  readonly skipped_simulation_count: number;
  readonly tests: readonly PlannedTest[];
};

/** A started run, as far as a builder needs to read one. */
export type StartedRun = {
  readonly id: string;
  readonly status: string;
  readonly expected_simulation_count: number;
  readonly skipped_count: number | null;
};

export const RUNS_PATH = "/api/runs";
export const RUN_PLAN_PATH = "/api/run-plan";

/**
 * The address of one plan read.
 *
 * The whole selection is in the address rather than in a body, because it is a
 * read: reload, Back and a copied link all restore the same review, and nothing
 * is created by asking.
 */
export function runPlanQuery(selection: {
  readonly agentId: string;
  readonly connectionId: string;
  readonly testVersionIds: readonly string[];
}): string {
  const asked = new URLSearchParams();
  asked.set("agent", selection.agentId);
  asked.set("connection", selection.connectionId);
  asked.set("test_versions", selection.testVersionIds.join(","));
  return `${RUN_PLAN_PATH}?${asked.toString()}`;
}

/** Where the run builder lives inside one project. */
export const RUN_BUILDER_SECTION = "runs";
export const RUN_BUILDER_STEP = "new";

/**
 * The agent a builder should open with, taken from the address.
 *
 * **It preselects and never bypasses.** Arriving from an agent's page fills the
 * first step in; every later check — the connection is that agent's, the test
 * applies to it, the project has a judge — still runs, on the server, exactly
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
  return plan.runnable_simulation_count + plan.skipped_simulation_count;
}

/**
 * Whether any grader in this plan would ask a model and find none configured.
 *
 * **The plan says so itself, on every item.** A grader that asks a model in a
 * project holding none is frozen `unavailable_at_capture`; one that never asks
 * — `latency`, computed from spans — is `not_required` whatever the project's
 * judge setting says. So this is a read of what the server already decided
 * rather than a second rule about which graders need a judge, which is the
 * shape everything in this module takes.
 */
function asksAModelWithNone(plan: RunPlan): boolean {
  return plan.tests.some((test) =>
    test.graders.some((grader) => grader.judge.tag === "unavailable_at_capture"),
  );
}

/**
 * Whether this plan could be started at all, and what to say when it could not.
 *
 * **Two blockers, and only two, and both are states rather than mistakes.**
 *
 * The first is a plan that would ask a model this project has not configured.
 * It used to be *any* run in a project with no judge, because every run carried
 * the judge-backed expected-behaviors built-in — and that grader is an ordinary
 * deletable copy now, so the sentence stopped being true. A project judging
 * only with `latency`, or with nothing at all, asks no model and starts
 * perfectly well; what it must not do is dial real simulations for a judgment
 * nobody can pay for. The server refuses on exactly the same reading, so this
 * is the page saying so early rather than the page being the check.
 *
 * The second is a plan in which every simulation would be skipped: a run with
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
  if (plan.judge.state === "needs_setup" && asksAModelWithNone(plan)) {
    return "This project has no LLM judge configured, and a grader in this plan judges by asking a model. An organization admin can set the judge in project Settings, or you can delete that grader in Graders.";
  }
  if (plan.runnable_simulation_count === 0) {
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
export type VerdictWord = "passed" | "failed" | "skipped" | "errored";

export const VERDICT_WORDS: readonly VerdictWord[] = [
  "passed",
  "failed",
  "skipped",
  "errored",
];

/** A run's machinery, and never a judgement of what it found. */
export type RunStatusWord = "pending" | "running" | "completed" | "canceled";

export const RUN_STATUS_WORDS: readonly RunStatusWord[] = [
  "pending",
  "running",
  "completed",
  "canceled",
];

/** One conversation's machinery. `skipped` is born terminal and never claimed. */
export type SimulationStatusWord =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped";

/**
 * Where the judging of one conversation stands — never what it decided.
 *
 * `not_required` is the one worth reading twice: a conversation egma never
 * conducted, or one somebody stopped, has no grading job and never will. Drawing
 * it as `pending` would leave a progress line waiting forever on work nobody
 * filed.
 */
export type GradingWord = "not_required" | "waiting" | "pending" | "graded";

export type VerdictCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
  readonly total: number;
};

/**
 * One run as a list draws it — the four facts, each as itself.
 *
 * `verdict` is `null` until every conversation has one, which is *nobody has
 * finished looking* and is not a verdict. `simulation_counts` is the machinery,
 * counted by state, with `skipped` its own number for the reason it is its own
 * column: egma declining to conduct a conversation says nothing about the agent.
 */
export type RunRow = {
  readonly id: string;
  readonly project_id: string;
  readonly status: RunStatusWord;
  readonly label: string | null;
  readonly agent_id: string;
  readonly connection_id: string;
  readonly connection_type: string;
  readonly modality: string;
  readonly environment: string | null;
  readonly retry_of_run_id: string | null;
  readonly expected_simulation_count: number;
  readonly completed_count: number | null;
  readonly failed_count: number | null;
  readonly canceled_count: number | null;
  readonly skipped_count: number | null;
  readonly simulation_counts: Readonly<Record<SimulationStatusWord, number>>;
  readonly finished_count: number;
  readonly gradable_count: number;
  readonly graded_count: number;
  readonly verdict: VerdictWord | null;
  readonly score: number | null;
  readonly verdict_counts: VerdictCounts;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
};

export type RunHistoryPage = {
  readonly items: readonly RunRow[];
  /**
   * Where this page stopped, or null on the last one.
   *
   * **A verdict-filtered page can be short and still carry one**, and the
   * promise is worth reading exactly: a cursor says there is more to look at,
   * never that there is more to show. A verdict is folded at read time from
   * another store, so the server sweeps and folds rather than filtering in the
   * query, and a sweep that found two matches in fifty runs answers two.
   */
  readonly next_cursor: string | null;
};

/** One conversation of a run, as the run's own page draws it. */
export type RunSimulation = {
  readonly id: string;
  readonly position: number;
  readonly test_id: string | null;
  readonly test_name: string | null;
  readonly test_version_id: string | null;
  readonly persona_id: string;
  readonly persona_name: string;
  /** Exactly who called, frozen. The name above reads as it stands today. */
  readonly persona_version_id: string;
  readonly status: SimulationStatusWord;
  readonly grading: GradingWord;
  readonly verdict: VerdictWord | null;
  readonly score: number | null;
  readonly counts: VerdictCounts | null;
  readonly reason: string | null;
  /**
   * One sentence saying what actually went wrong, where the reason word cannot
   * say it alone — and the screen that fixes it, as one word from a closed
   * list. Both null on every conversation that ran.
   *
   * A word rather than a link, because the address of a page is the browser's
   * business: a stored link would be a route the platform could not be
   * refactored around, and an unknown word would be a button to nowhere.
   */
  readonly detail: string | null;
  readonly repair: string | null;
  readonly skip_reason: string | null;
  readonly skipped_capabilities: readonly string[] | null;
  readonly modality: string | null;
  readonly has_recording: boolean;
};

/** One judge choice a frozen plan holds. Never a key, and there is no field for one. */
export type PlanJudgeChoice =
  | { readonly tag: "not_required" }
  | {
      readonly tag: "configured";
      readonly provider: string;
      readonly model: string;
      readonly source: string;
    }
  | { readonly tag: "unavailable_at_capture" };

/** One item of a frozen plan. See `PlanGrader` for why there is one shape. */
export type FrozenPlanItem = {
  readonly kind: "authored";
  readonly grader_id: string;
  readonly grader_version_id: string;
  readonly name: string;
  readonly library_id: string;
  readonly required: boolean;
  readonly scope: string;
  readonly judge: PlanJudgeChoice;
};

export type FrozenPlanGroup =
  | {
      readonly tag: "version";
      readonly test_id: string;
      readonly test_version_id: string;
      readonly test_name: string;
      readonly items: readonly FrozenPlanItem[];
    }
  | { readonly tag: "legacy_testless"; readonly items: readonly FrozenPlanItem[] };

/**
 * When a run's grading plan was decided, and whether one was decided at all.
 *
 * The state has to be shown, because it decides how much of the rest can be
 * believed. `migration_snapshot` was captured during an upgrade rather than when
 * the run began, and `not_recorded` has no plan at all — a page must say so
 * rather than presenting today's graders as something that was pinned.
 */
export type FrozenPlan = {
  readonly state: "run_start" | "migration_snapshot" | "not_recorded";
  readonly captured_at: string | null;
  readonly groups: readonly FrozenPlanGroup[];
};

export type ConnectionSnapshot = {
  readonly type: string;
  readonly modality: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: unknown;
};

/** One mocked answer a run froze, as the snapshot carries it. */
export type FrozenMockTool = {
  readonly tool_name: string;
  readonly mock_tool_id?: string;
};

export type MockToolSnapshot = {
  readonly defaults: readonly FrozenMockTool[];
  readonly overrides: Readonly<Record<string, readonly FrozenMockTool[]>>;
};

/**
 * One run, whole — what its own page reads.
 *
 * The agent and the connection come back **as they now stand, archived or not**.
 * That is what keeps a run readable after somebody archives what it went over:
 * archiving stops new work, and it must never make old evidence unnameable.
 */
export type RunDetail = {
  readonly id: string;
  readonly project_id: string;
  readonly status: RunStatusWord;
  readonly label: string | null;
  readonly agent_id: string;
  readonly connection_id: string;
  readonly connection_type: string | null;
  readonly modality: string | null;
  readonly connection_snapshot: ConnectionSnapshot;
  readonly retry_of_run_id: string | null;
  readonly test_versions: readonly string[];
  readonly mock_tools: MockToolSnapshot;
  readonly expected_simulation_count: number;
  readonly completed_count: number | null;
  readonly failed_count: number | null;
  readonly canceled_count: number | null;
  readonly skipped_count: number | null;
  readonly simulation_counts: Readonly<Record<SimulationStatusWord, number>>;
  readonly finished_count: number;
  readonly gradable_count: number;
  readonly graded_count: number;
  readonly verdict: VerdictWord | null;
  readonly score: number | null;
  readonly counts: VerdictCounts | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly simulations: readonly RunSimulation[];
  readonly grading_plan: FrozenPlan | null;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  } | null;
  readonly connection: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly archived: boolean;
  } | null;
};

/** One numbered change, as the feed carries it. */
export type RunEventRow = {
  readonly seq: number;
  readonly at: string;
  readonly kind: "run" | "simulation";
  readonly status: string;
  readonly simulation_id?: string;
  readonly test_name?: string | null;
  readonly persona_name?: string | null;
  readonly verdict?: VerdictWord | null;
  readonly reason?: string | null;
};

export type RunEventFeed = {
  readonly events: readonly RunEventRow[];
  /** Hand back as `after` to continue; the same number again on an empty page. */
  readonly next: number;
  /** True once the run has finished, and only then. */
  readonly done: boolean;
};

/** What narrows a run history. Every one of them optional, and none a default. */
export type RunFilters = {
  readonly agent?: string;
  readonly connection?: string;
  readonly test?: string;
  readonly status?: RunStatusWord;
  readonly verdict?: VerdictWord;
  /** RFC 3339. Runs started at or after this moment. */
  readonly since?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

/** The address of one page of history. The whole question is in the address. */
export function runsQuery(filters: RunFilters = {}): string {
  const asked = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === "") continue;
    asked.set(name, String(value));
  }
  const query = asked.toString();
  return query === "" ? RUNS_PATH : `${RUNS_PATH}?${query}`;
}

export function runPath(runId: string): string {
  return `${RUNS_PATH}/${encodeURIComponent(runId)}`;
}

export function runEventsPath(runId: string): string {
  return `${runPath(runId)}/events`;
}

export function runCancelPath(runId: string): string {
  return `${runPath(runId)}/cancel`;
}

/**
 * Where Retry is asked for — a verb on the earlier run, never a field on a
 * create body. Everything the new run uses comes off the run in this address, so
 * a run that says it retries another one really does execute what that one
 * executed.
 */
export function runRetryPath(runId: string): string {
  return `${runPath(runId)}/retry`;
}

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
    return "Frozen when this run started. These are the exact grader versions and judge choices it was judged against.";
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
 * now — persona and grader versions, the project's default graders, the judge
 * setting, the connection's configuration, and the mocked world. Somebody who
 * read "run it again" and got different results would think egma was
 * inconsistent, when what actually changed is what they changed.
 */
export const RETRY_IS_NOT_A_REPLAY =
  "Retry starts a new run with this run's agent, connection and exact test versions. Everything else is resolved as it stands now — current persona and grader versions, the project's default graders, the judge setting, the connection, and Mock Tools. It is not an exact replay of the original conditions, and this run is not changed.";
