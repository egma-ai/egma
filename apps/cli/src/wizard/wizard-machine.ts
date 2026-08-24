/**
 * The wizard's order, without any I/O.
 *
 * The flow owns effects such as ACP work, platform requests, and UI updates.
 * This module owns only which phase can follow which. That gives the flow one
 * small seam for ordering and gives tests the same seam.
 *
 * **The goal lives here and nowhere else.** After discovery the wizard knows
 * the agent and its platform, so it can ask what Egma is here to do — test the
 * agent, watch its production traffic, or both — and the answer becomes state.
 * Nothing in the public CLI mirrors it: a coding agent types verbs, and a verb
 * that named a phase of this machine would be a second way to run the wizard.
 */

export type WizardAgentPlatform = "retell" | "livekit";
export type UnsupportedWizardAgentPlatform = "pipecat" | "vapi";

/** What Egma is being asked to do for the agent the wizard just found. */
export type WizardGoal = "testing" | "monitoring" | "both";

/** Every goal, in the order the question offers them. */
export const WIZARD_GOALS: readonly WizardGoal[] = ["testing", "monitoring", "both"];

/** The two goals whose lane runs the testing work. */
type TestingGoal = "testing" | "both";

/** The two goals that want production traffic watched. */
type MonitoringGoal = "monitoring" | "both";

type ChosenCodingAgent = { readonly codingAgentId: string };

type OnAPlatform = {
  readonly platform: WizardAgentPlatform;
  readonly goal: TestingGoal;
};

export type WizardState =
  | { readonly phase: "coding-agent" }
  | ({ readonly phase: "intro" } & ChosenCodingAgent)
  | ({ readonly phase: "login" } & ChosenCodingAgent)
  | ({ readonly phase: "discovery" } & ChosenCodingAgent)
  /** The one question, asked once the agent and its platform are known. */
  | ({ readonly phase: "goal"; readonly platform: WizardAgentPlatform } & ChosenCodingAgent)
  | ({ readonly phase: "connection-setup" } & OnAPlatform & ChosenCodingAgent)
  | ({ readonly phase: "test-writing" } & OnAPlatform & ChosenCodingAgent)
  /**
   * The mocked world, written after the tests it has to serve.
   *
   * Only LiveKit reaches it, because only a LiveKit simulation is served mock
   * tools. On Retell the lane passes from test writing to the review gate with
   * no screen in between, and the type says so rather than a comment.
   */
  | ({
      readonly phase: "mock-authoring";
      readonly platform: "livekit";
      readonly goal: TestingGoal;
      readonly testCount: number;
    } & ChosenCodingAgent)
  | ({
      readonly phase: "review";
      readonly testCount: number;
    } & OnAPlatform &
      ChosenCodingAgent)
  | ({
      readonly phase: "run";
      readonly testCount: number;
    } & OnAPlatform &
      ChosenCodingAgent)
  /**
   * Setting up production monitoring, which is one phase on both platforms.
   *
   * The step forks by platform inside — Retell pastes a key and starts
   * watching; LiveKit has its worker edited, mints a project key and writes
   * the two environment lines — but the machine has one state for it, because
   * what follows is decided by the goal and never by the platform.
   */
  | ({
      readonly phase: "monitoring-setup";
      readonly platform: WizardAgentPlatform;
      readonly goal: MonitoringGoal;
    } & ChosenCodingAgent)
  /**
   * The end of the walk, whichever lane reached it.
   *
   * It carries the goal because the last screen differs by it: the testing
   * lane points at a graded run, the monitoring lane at Monitoring, and both
   * points at both. `testCount` is zero for a lane that wrote no tests, which
   * is a fact about that lane rather than a gap.
   */
  | ({
      readonly phase: "complete";
      readonly platform: WizardAgentPlatform;
      readonly goal: WizardGoal;
      readonly testCount: number;
    } & ChosenCodingAgent)
  /** The repository has already been through the wizard once. */
  | { readonly phase: "already-onboarded" }
  | ({ readonly phase: "no-agent" } & ChosenCodingAgent)
  | ({
      readonly phase: "unsupported-platform";
      readonly platform: UnsupportedWizardAgentPlatform;
    } & ChosenCodingAgent)
  | { readonly phase: "no-coding-agent" };

export type WizardPhase = WizardState["phase"];

export type WizardEvent =
  | { readonly type: "coding-agent-selected"; readonly id: string }
  | { readonly type: "coding-agent-unavailable" }
  /** An egma folder is already here, so this repository is not a new one. */
  | { readonly type: "repository-already-onboarded" }
  | { readonly type: "intro-accepted" }
  | { readonly type: "login-finished" }
  | { readonly type: "agent-found"; readonly platform: WizardAgentPlatform }
  | { readonly type: "agent-not-found" }
  | {
      readonly type: "agent-unsupported";
      readonly platform: UnsupportedWizardAgentPlatform;
    }
  | { readonly type: "goal-chosen"; readonly goal: WizardGoal }
  /** Production monitoring is set up, however this platform sets it up. */
  | { readonly type: "monitoring-ready" }
  | { readonly type: "connection-ready" }
  | { readonly type: "tests-ready"; readonly count: number }
  /** The mocked world is written, so the gate can show it beside the tests. */
  | { readonly type: "mocks-ready" }
  | { readonly type: "review-approved"; readonly count: number }
  | { readonly type: "wizard-completed" };

export const INITIAL_WIZARD_STATE: WizardState = { phase: "coding-agent" };

export type InvalidWizardTransition = {
  readonly kind: "invalid-transition";
  readonly reason: "unexpected-event" | "invalid-test-count" | "invalid-coding-agent";
  readonly phase: WizardState["phase"];
  readonly event: WizardEvent["type"];
  readonly message: string;
};

export type WizardTransition =
  | { readonly ok: true; readonly state: WizardState }
  | {
      readonly ok: false;
      /** The state is returned unchanged, so a caller can report and stop. */
      readonly state: WizardState;
      readonly error: InvalidWizardTransition;
    };

/** Move the wizard by one event. No state is changed in place. */
export function transitionWizard(state: WizardState, event: WizardEvent): WizardTransition {
  switch (state.phase) {
    case "coding-agent":
      if (event.type === "coding-agent-unavailable") {
        return movedTo({ phase: "no-coding-agent" });
      }
      // Read before a coding agent is even selected, so a repository that has
      // been through the wizard once starts nothing at all the second time.
      if (event.type === "repository-already-onboarded") {
        return movedTo({ phase: "already-onboarded" });
      }
      if (event.type === "coding-agent-selected") {
        if (event.id.trim() === "") return invalid(state, event, "invalid-coding-agent");
        return movedTo({ phase: "intro", codingAgentId: event.id });
      }
      break;

    case "intro":
      if (event.type === "intro-accepted") {
        return movedTo({ phase: "login", codingAgentId: state.codingAgentId });
      }
      break;

    case "login":
      if (event.type === "login-finished") {
        return movedTo({ phase: "discovery", codingAgentId: state.codingAgentId });
      }
      break;

    case "discovery":
      if (event.type === "agent-found") {
        return movedTo({
          phase: "goal",
          platform: event.platform,
          codingAgentId: state.codingAgentId,
        });
      }
      if (event.type === "agent-not-found") {
        return movedTo({ phase: "no-agent", codingAgentId: state.codingAgentId });
      }
      if (event.type === "agent-unsupported") {
        return movedTo({
          phase: "unsupported-platform",
          platform: event.platform,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "goal":
      if (event.type === "goal-chosen") {
        // Monitoring first, for both goals that want it: the historical import
        // and the worker's own export start while the developer writes tests,
        // so a sitting that does both ends with Monitoring already filling.
        if (event.goal !== "testing") {
          return movedTo({
            phase: "monitoring-setup",
            platform: state.platform,
            goal: event.goal,
            codingAgentId: state.codingAgentId,
          });
        }
        return movedTo({
          phase: "connection-setup",
          platform: state.platform,
          goal: event.goal,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "monitoring-setup":
      if (event.type === "monitoring-ready") {
        // Monitoring alone is finished here: no connection is created and no
        // suite, test or run exists, so there is nothing left to do.
        if (state.goal === "monitoring") {
          return movedTo({
            phase: "complete",
            platform: state.platform,
            goal: state.goal,
            testCount: 0,
            codingAgentId: state.codingAgentId,
          });
        }
        return movedTo({
          phase: "connection-setup",
          platform: state.platform,
          goal: state.goal,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "connection-setup":
      if (event.type === "connection-ready") {
        return movedTo({
          phase: "test-writing",
          platform: state.platform,
          goal: state.goal,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "test-writing":
      if (event.type === "tests-ready") {
        if (!Number.isSafeInteger(event.count) || event.count < 1) {
          return invalid(state, event, "invalid-test-count");
        }
        // Mock tools are served on LiveKit and nowhere else yet, so a Retell
        // lane has no mocked world to author and no screen for one.
        if (state.platform === "livekit") {
          return movedTo({
            phase: "mock-authoring",
            platform: "livekit",
            goal: state.goal,
            testCount: event.count,
            codingAgentId: state.codingAgentId,
          });
        }
        return movedTo({
          phase: "review",
          platform: state.platform,
          goal: state.goal,
          testCount: event.count,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "mock-authoring":
      if (event.type === "mocks-ready") {
        return movedTo({
          phase: "review",
          platform: state.platform,
          goal: state.goal,
          testCount: state.testCount,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "review":
      if (event.type === "tests-ready") {
        if (!Number.isSafeInteger(event.count) || event.count < 1) {
          return invalid(state, event, "invalid-test-count");
        }
        return movedTo({ ...state, testCount: event.count });
      }
      if (event.type === "review-approved") {
        if (!Number.isSafeInteger(event.count) || event.count < 1) {
          return invalid(state, event, "invalid-test-count");
        }
        return movedTo({
          phase: "run",
          platform: state.platform,
          goal: state.goal,
          testCount: event.count,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "run":
      if (event.type === "wizard-completed") {
        return movedTo({
          phase: "complete",
          platform: state.platform,
          goal: state.goal,
          testCount: state.testCount,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "complete":
    case "already-onboarded":
    case "no-agent":
    case "unsupported-platform":
    case "no-coding-agent":
      break;
  }

  return invalid(state, event, "unexpected-event");
}

function movedTo(state: WizardState): WizardTransition {
  return { ok: true, state };
}

function invalid(
  state: WizardState,
  event: WizardEvent,
  reason: InvalidWizardTransition["reason"],
): WizardTransition {
  const message =
    reason === "invalid-test-count"
      ? `The wizard cannot review ${event.type === "tests-ready" || event.type === "review-approved" ? event.count : 0} tests.`
      : reason === "invalid-coding-agent"
        ? "The wizard cannot select a coding agent with no id."
        : `The wizard cannot handle ${event.type} while it is in ${state.phase}.`;

  return {
    ok: false,
    state,
    error: {
      kind: "invalid-transition",
      reason,
      phase: state.phase,
      event: event.type,
      message,
    },
  };
}
