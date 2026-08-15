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

/** One grader a run would freeze, in whichever of its two shapes it has. */
export type PlanGrader =
  | {
      readonly kind: "built_in";
      /** The reserved key. `expected_behaviors_v1` is the first and only one. */
      readonly grader_key: string;
      readonly engine_version: string;
      readonly reads: readonly string[];
      readonly modalities: readonly string[];
      readonly judge: JudgeChoice;
    }
  | {
      readonly kind: "authored";
      readonly grader_id: string;
      readonly grader_version_id: string;
      readonly name: string;
      /** How it got here. A direct link is the per-test scoping decision. */
      readonly origin: "project_default" | "scenario_specific";
      readonly priority: string;
      readonly scope: string;
      readonly reads: readonly string[];
      readonly modalities: readonly string[];
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
    : `Nobody has measured whether this connection supports ${named}. Egma will not conduct these simulations, and will say nothing about the agent. Refresh the connection's capabilities, then plan the run again.`;
}

/** How many conversations a plan would produce, conducted and skipped alike. */
export function plannedSimulationCount(plan: RunPlan): number {
  return plan.runnable_simulation_count + plan.skipped_simulation_count;
}

/**
 * Whether this plan could be started at all, and what to say when it could not.
 *
 * **Two blockers, and only two, and both are states rather than mistakes.** A
 * project with no judge cannot start any run, because every run carries the
 * judge-backed expected-behaviors built-in. And a plan in which every
 * conversation would be skipped is a run with nothing to conduct — it would
 * complete immediately having judged nothing, and offering Start for it would
 * be offering somebody a green tick nobody earned.
 *
 * The server refuses the first for itself, so this is the page saying so early
 * rather than the page being the check.
 */
export function whyNotStartable(plan: RunPlan): string | null {
  if (plan.judge.state === "needs_setup") {
    return "This project has no LLM judge configured, and every run judges its test's expected behaviors with one. An organization admin can set it in project Settings.";
  }
  if (plan.runnable_simulation_count === 0) {
    return "Every simulation in this selection would be skipped, so this run would conduct nothing. Choose a connection that supports what these tests require, or choose tests that require less.";
  }
  return null;
}
