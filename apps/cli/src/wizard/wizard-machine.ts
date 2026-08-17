/**
 * The wizard's order, without any I/O.
 *
 * The flow owns effects such as ACP work, platform requests, and UI updates.
 * This module owns only which phase can follow which. That gives the flow one
 * small seam for ordering and gives tests the same seam.
 */

export type WizardAgentPlatform = "retell" | "livekit";
export type UnsupportedWizardAgentPlatform = "pipecat" | "vapi";

type ChosenCodingAgent = { readonly codingAgentId: string };

export type WizardState =
  | { readonly phase: "coding-agent" }
  | ({ readonly phase: "intro" } & ChosenCodingAgent)
  | ({ readonly phase: "login" } & ChosenCodingAgent)
  | ({ readonly phase: "discovery" } & ChosenCodingAgent)
  | ({ readonly phase: "provider-setup"; readonly platform: WizardAgentPlatform } & ChosenCodingAgent)
  | ({ readonly phase: "test-writing"; readonly platform: WizardAgentPlatform } & ChosenCodingAgent)
  | ({
      readonly phase: "review";
      readonly platform: WizardAgentPlatform;
      readonly testCount: number;
    } & ChosenCodingAgent)
  | ({
      readonly phase: "run";
      readonly platform: WizardAgentPlatform;
      readonly testCount: number;
    } & ChosenCodingAgent)
  | ({
      readonly phase: "complete";
      readonly platform: WizardAgentPlatform;
      readonly testCount: number;
    } & ChosenCodingAgent)
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
  | { readonly type: "intro-accepted" }
  | { readonly type: "login-finished" }
  | { readonly type: "agent-found"; readonly platform: WizardAgentPlatform }
  | { readonly type: "agent-not-found" }
  | {
      readonly type: "agent-unsupported";
      readonly platform: UnsupportedWizardAgentPlatform;
    }
  | { readonly type: "provider-ready" }
  | { readonly type: "tests-ready"; readonly count: number }
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
          phase: "provider-setup",
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

    case "provider-setup":
      if (event.type === "provider-ready") {
        return movedTo({
          phase: "test-writing",
          platform: state.platform,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "test-writing":
      if (event.type === "tests-ready") {
        if (!Number.isSafeInteger(event.count) || event.count < 1) {
          return invalid(state, event, "invalid-test-count");
        }
        return movedTo({
          phase: "review",
          platform: state.platform,
          testCount: event.count,
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
          testCount: state.testCount,
          codingAgentId: state.codingAgentId,
        });
      }
      break;

    case "complete":
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
