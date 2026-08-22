import { describe, expect, it } from "vitest";

import {
  INITIAL_WIZARD_STATE,
  transitionWizard,
  WIZARD_GOALS,
  type WizardEvent,
  type WizardPhase,
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

/** Everything up to the one question, which is where the lanes part. */
function askedTheGoal(platform: "retell" | "livekit"): WizardState {
  let state = move(selected(), { type: "intro-accepted" });
  state = move(state, { type: "login-finished" });
  return move(state, { type: "agent-found", platform });
}

/** The phases one lane really passes through, in order. */
function walk(
  from: WizardState,
  events: readonly WizardEvent[],
): readonly WizardPhase[] {
  const phases: WizardPhase[] = [];
  let state = from;
  for (const event of events) {
    state = move(state, event);
    phases.push(state.phase);
  }
  return phases;
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
    "asks what Egma is for once it knows the agent runs on %s",
    (platform) => {
      let state = move(selected(), { type: "intro-accepted" });
      state = move(state, { type: "login-finished" });
      expect(state).toEqual({ phase: "discovery", codingAgentId: "claude" });

      state = move(state, { type: "agent-found", platform });
      expect(state).toEqual({ phase: "goal", platform, codingAgentId: "claude" });
    },
  );
});

describe("the goal, per platform", () => {
  /**
   * The testing lane, whole. On Retell it passes from test writing to the
   * review gate; on LiveKit it writes the mocked world in between, because
   * LiveKit is where a mock tool is served.
   */
  it("runs connection setup, tests and the review gate on Retell, with no mock authoring", () => {
    const state = move(askedTheGoal("retell"), { type: "goal-chosen", goal: "testing" });

    expect(state).toEqual({
      phase: "connection-setup",
      platform: "retell",
      goal: "testing",
      codingAgentId: "claude",
    });
    expect(
      walk(state, [
        { type: "connection-ready" },
        { type: "tests-ready", count: 12 },
        { type: "review-approved", count: 12 },
        { type: "wizard-completed" },
      ]),
    ).toEqual(["test-writing", "review", "run", "complete"]);
  });

  it("writes the mocked world between the tests and the gate on LiveKit", () => {
    const state = move(askedTheGoal("livekit"), { type: "goal-chosen", goal: "testing" });

    expect(
      walk(state, [
        { type: "connection-ready" },
        { type: "tests-ready", count: 12 },
        { type: "mocks-ready" },
        { type: "review-approved", count: 12 },
        { type: "wizard-completed" },
      ]),
    ).toEqual(["test-writing", "mock-authoring", "review", "run", "complete"]);
  });

  it("carries the goal and the test count the whole way down the lane", () => {
    let state = move(askedTheGoal("livekit"), { type: "goal-chosen", goal: "testing" });
    state = move(state, { type: "connection-ready" });
    state = move(state, { type: "tests-ready", count: 3 });

    expect(state).toEqual({
      phase: "mock-authoring",
      platform: "livekit",
      goal: "testing",
      testCount: 3,
      codingAgentId: "claude",
    });

    state = move(state, { type: "mocks-ready" });
    expect(state).toEqual({
      phase: "review",
      platform: "livekit",
      goal: "testing",
      testCount: 3,
      codingAgentId: "claude",
    });
  });

  /**
   * Watching production traffic is not built into the terminal yet, and the
   * both lane starts with it. Both therefore stop at one honest terminal phase
   * rather than running half of what the answer promised.
   */
  it.each([
    { platform: "retell", goal: "monitoring" },
    { platform: "retell", goal: "both" },
    { platform: "livekit", goal: "monitoring" },
    { platform: "livekit", goal: "both" },
  ] as const)("ends at monitoring-elsewhere for $goal on $platform", ({ platform, goal }) => {
    expect(move(askedTheGoal(platform), { type: "goal-chosen", goal })).toEqual({
      phase: "monitoring-elsewhere",
      platform,
      goal,
      codingAgentId: "claude",
    });
  });

  it("does not leave the monitoring terminal", () => {
    const state = move(askedTheGoal("retell"), { type: "goal-chosen", goal: "monitoring" });
    const result = transitionWizard(state, { type: "connection-ready" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an invalid transition");
    expect(result.error.phase).toBe("monitoring-elsewhere");
  });

  it("offers exactly three answers, and no fourth", () => {
    expect(WIZARD_GOALS).toEqual(["testing", "monitoring", "both"]);
  });
});

describe("a repository that has been through the wizard already", () => {
  /**
   * Read before a coding agent is even selected. A second walk over a committed
   * folder would write half of another setup into somebody's files, so nothing
   * at all starts.
   */
  it("refuses politely before anything is started", () => {
    const state = move(INITIAL_WIZARD_STATE, { type: "repository-already-onboarded" });

    expect(state).toEqual({ phase: "already-onboarded" });
  });

  it("does not leave that terminal either", () => {
    const state: WizardState = { phase: "already-onboarded" };
    const result = transitionWizard(state, { type: "coding-agent-selected", id: "claude" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an invalid transition");
    expect(result.error.phase).toBe("already-onboarded");
  });

  it("is not something the wizard can decide once it has started", () => {
    const result = transitionWizard(selected(), { type: "repository-already-onboarded" });

    expect(result.ok).toBe(false);
  });
});

describe("the terminals the goal question did not change", () => {
  it("ends at no-agent when discovery finds no voice agent", () => {
    let state = move(selected(), { type: "intro-accepted" });
    state = move(state, { type: "login-finished" });
    state = move(state, { type: "agent-not-found" });

    expect(state).toEqual({ phase: "no-agent", codingAgentId: "claude" });
  });

  it.each(["pipecat", "vapi"] as const)(
    "ends at unsupported-platform for %s, without ever asking the goal",
    (platform) => {
      let state = move(selected(), { type: "intro-accepted" });
      state = move(state, { type: "login-finished" });
      state = move(state, { type: "agent-unsupported", platform });
      expect(state).toEqual({ phase: "unsupported-platform", platform, codingAgentId: "claude" });
    },
  );

  it("ends at no-coding-agent when there is none to drive", () => {
    expect(
      move(INITIAL_WIZARD_STATE, { type: "coding-agent-unavailable" }),
    ).toEqual({ phase: "no-coding-agent" });
  });
});

describe("the review count", () => {
  it("can replace the review count when the platform holds one file back", () => {
    const state: WizardState = {
      phase: "review",
      platform: "retell",
      goal: "testing",
      testCount: 12,
      codingAgentId: "claude",
    };
    expect(move(state, { type: "tests-ready", count: 11 })).toEqual({
      phase: "review",
      platform: "retell",
      goal: "testing",
      testCount: 11,
      codingAgentId: "claude",
    });
  });

  it("uses the final pushed count when a held-back file is fixed before approval", () => {
    const state: WizardState = {
      phase: "review",
      platform: "livekit",
      goal: "testing",
      testCount: 11,
      codingAgentId: "claude",
    };
    expect(move(state, { type: "review-approved", count: 12 })).toEqual({
      phase: "run",
      platform: "livekit",
      goal: "testing",
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

  it("does not skip the goal question on the way to connection setup", () => {
    const result = transitionWizard(askedTheGoal("retell"), { type: "connection-ready" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an invalid transition");
    expect(result.error.phase).toBe("goal");
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "does not move %s tests to review",
    (count) => {
      const state: WizardState = {
        phase: "test-writing",
        platform: "livekit",
        goal: "testing",
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
        goal: "testing",
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
