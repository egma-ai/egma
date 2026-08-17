import { describe, expect, it } from "vitest";

import {
  INITIAL_WIZARD_STATE,
  transitionWizard,
  type WizardEvent,
  type WizardState,
} from "../src/wizard/wizard-machine.ts";

function move(state: WizardState, event: WizardEvent): WizardState {
  const result = transitionWizard(state, event);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

function selected(id = "claude"): WizardState {
  return move(INITIAL_WIZARD_STATE, { type: "coding-agent-selected", id });
}

describe("the wizard's phase order", () => {
  it("starts by selecting one installed coding agent and keeps that choice", () => {
    let state = INITIAL_WIZARD_STATE;

    expect(state).toEqual({ phase: "coding-agent" });
    state = move(state, { type: "coding-agent-selected", id: "codex" });
    expect(state).toEqual({ phase: "intro", codingAgentId: "codex" });
    state = move(state, { type: "intro-accepted" });
    expect(state).toEqual({ phase: "login", codingAgentId: "codex" });
  });

  it.each(["retell", "livekit"] as const)(
    "takes the complete %s path and keeps its context",
    (platform) => {
      let state = selected();

      state = move(state, { type: "intro-accepted" });
      expect(state).toEqual({ phase: "login", codingAgentId: "claude" });

      state = move(state, { type: "login-finished" });
      expect(state).toEqual({ phase: "discovery", codingAgentId: "claude" });

      state = move(state, { type: "agent-found", platform });
      expect(state).toEqual({ phase: "provider-setup", platform, codingAgentId: "claude" });

      state = move(state, { type: "provider-ready" });
      expect(state).toEqual({ phase: "test-writing", platform, codingAgentId: "claude" });

      state = move(state, { type: "tests-ready", count: 12 });
      expect(state).toEqual({ phase: "review", platform, testCount: 12, codingAgentId: "claude" });

      state = move(state, { type: "review-approved", count: 12 });
      expect(state).toEqual({ phase: "run", platform, testCount: 12, codingAgentId: "claude" });

      state = move(state, { type: "wizard-completed" });
      expect(state).toEqual({ phase: "complete", platform, testCount: 12, codingAgentId: "claude" });
    },
  );

  it("ends at no-agent when discovery finds no voice agent", () => {
    let state = move(selected(), { type: "intro-accepted" });
    state = move(state, { type: "login-finished" });
    state = move(state, { type: "agent-not-found" });

    expect(state).toEqual({ phase: "no-agent", codingAgentId: "claude" });
  });

  it.each(["pipecat", "vapi"] as const)(
    "ends at unsupported-platform for %s",
    (platform) => {
      let state = move(selected(), { type: "intro-accepted" });
      state = move(state, { type: "login-finished" });
      state = move(state, { type: "agent-unsupported", platform });
      expect(state).toEqual({ phase: "unsupported-platform", platform, codingAgentId: "claude" });
    },
  );

  it("can replace the review count when the platform holds one file back", () => {
    const state: WizardState = {
      phase: "review",
      platform: "retell",
      testCount: 12,
      codingAgentId: "claude",
    };
    expect(move(state, { type: "tests-ready", count: 11 })).toEqual({
      phase: "review",
      platform: "retell",
      testCount: 11,
      codingAgentId: "claude",
    });
  });

  it("uses the final pushed count when a held-back file is fixed before approval", () => {
    const state: WizardState = {
      phase: "review",
      platform: "livekit",
      testCount: 11,
      codingAgentId: "claude",
    };
    expect(move(state, { type: "review-approved", count: 12 })).toEqual({
      phase: "run",
      platform: "livekit",
      testCount: 12,
      codingAgentId: "claude",
    });
  });
});

describe("invalid wizard transitions", () => {
  it("does not accept a coding-agent choice after that phase", () => {
    const state: WizardState = { phase: "intro", codingAgentId: "claude" };
    const result = transitionWizard(state, {
      type: "coding-agent-selected",
      id: "codex",
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
  });

  it("returns a structured error and leaves the state unchanged", () => {
    const state: WizardState = Object.freeze({ phase: "intro", codingAgentId: "claude" });
    const result = transitionWizard(state, {
      type: "agent-found",
      platform: "retell",
    });

    expect(result).toEqual({
      ok: false,
      state,
      error: {
        kind: "invalid-transition",
        reason: "unexpected-event",
        phase: "intro",
        event: "agent-found",
        message: "The wizard cannot handle agent-found while it is in intro.",
      },
    });
    expect(result.state).toBe(state);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "does not move %s tests to review",
    (count) => {
      const state: WizardState = {
        phase: "test-writing",
        platform: "livekit",
        codingAgentId: "claude",
      };
      const result = transitionWizard(state, { type: "tests-ready", count });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an invalid transition");
      expect(result.state).toBe(state);
      expect(result.error).toMatchObject({
        kind: "invalid-transition",
        reason: "invalid-test-count",
        phase: "test-writing",
        event: "tests-ready",
      });
    },
  );

  it.each([
    {
      state: {
        phase: "complete",
        platform: "retell",
        testCount: 2,
        codingAgentId: "claude",
      } as const,
    },
    { state: { phase: "no-agent", codingAgentId: "claude" } as const },
    {
      state: {
        phase: "unsupported-platform",
        platform: "pipecat",
        codingAgentId: "claude",
      } as const,
    },
  ])("does not leave the terminal $state.phase phase", ({ state }) => {
    const result = transitionWizard(state, { type: "intro-accepted" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an invalid transition");
    expect(result.error.reason).toBe("unexpected-event");
    expect(result.error.phase).toBe(state.phase);
  });
});
