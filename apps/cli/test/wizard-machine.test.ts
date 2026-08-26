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

function authorized(): WizardState {
  let state = move(INITIAL_WIZARD_STATE, { type: "welcome-accepted" });
  state = move(state, { type: "login-finished" });
  return state;
}

function selected(id = "claude"): WizardState {
  return move(authorized(), { type: "coding-agent-selected", id });
}

/** Everything up to the one question, which is where the lanes part. */
function askedTheGoal(platform: "retell" | "livekit"): WizardState {
  const state = move(selected(), { type: "intro-accepted" });
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
  it("authorizes the CLI before selecting and driving a coding agent", () => {
    let state = INITIAL_WIZARD_STATE;

    expect(state).toEqual({ phase: "welcome" });
    state = move(state, { type: "welcome-accepted" });
    expect(state).toEqual({ phase: "login" });
    state = move(state, { type: "login-finished" });
    expect(state).toEqual({ phase: "coding-agent" });
    state = move(state, { type: "coding-agent-selected", id: "codex" });
    expect(state).toEqual({ phase: "intro", codingAgentId: "codex" });
    state = move(state, { type: "intro-accepted" });
    expect(state).toEqual({ phase: "discovery", codingAgentId: "codex" });
  });

  it.each(["retell", "livekit"] as const)(
    "asks what Egma is for once it knows the agent runs on %s",
    (platform) => {
      let state = move(selected(), { type: "intro-accepted" });
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
   * One state for setting monitoring up, on both platforms.
   *
   * The work inside it forks — Retell pastes a key and starts watching, LiveKit
   * has its worker edited and its key minted — but what follows is decided by
   * the goal and never by the platform, which is why there is one state and not
   * two.
   */
  it.each([
    { platform: "retell", goal: "monitoring" },
    { platform: "retell", goal: "both" },
    { platform: "livekit", goal: "monitoring" },
    { platform: "livekit", goal: "both" },
  ] as const)("sets monitoring up first for $goal on $platform", ({ platform, goal }) => {
    expect(move(askedTheGoal(platform), { type: "goal-chosen", goal })).toEqual({
      phase: "monitoring-setup",
      platform,
      goal,
      codingAgentId: "claude",
    });
  });

  /**
   * Monitoring alone creates no connection, no suite and no tests, so the walk
   * is over the moment watching is on.
   */
  it.each(["retell", "livekit"] as const)(
    "ends the walk on %s when monitoring is the whole job",
    (platform) => {
      const state = move(askedTheGoal(platform), {
        type: "goal-chosen",
        goal: "monitoring",
      });

      expect(move(state, { type: "monitoring-ready" })).toEqual({
        phase: "complete",
        platform,
        goal: "monitoring",
        testCount: 0,
        codingAgentId: "claude",
      });
    },
  );

  /** Both is monitoring first and then the whole testing lane, in one sitting. */
  it("runs monitoring and then the whole testing lane on Retell", () => {
    const state = move(askedTheGoal("retell"), { type: "goal-chosen", goal: "both" });

    expect(
      walk(state, [
        { type: "monitoring-ready" },
        { type: "connection-ready" },
        { type: "tests-ready", count: 12 },
        { type: "review-approved", count: 12 },
        { type: "wizard-completed" },
      ]),
    ).toEqual(["connection-setup", "test-writing", "review", "run", "complete"]);
  });

  it("runs monitoring and then the whole testing lane on LiveKit", () => {
    const state = move(askedTheGoal("livekit"), { type: "goal-chosen", goal: "both" });

    expect(
      walk(state, [
        { type: "monitoring-ready" },
        { type: "connection-ready" },
        { type: "tests-ready", count: 12 },
        { type: "mocks-ready" },
        { type: "review-approved", count: 12 },
        { type: "wizard-completed" },
      ]),
    ).toEqual([
      "connection-setup",
      "test-writing",
      "mock-authoring",
      "review",
      "run",
      "complete",
    ]);
  });

  it("carries the goal through the both lane to the last screen", () => {
    let state = move(askedTheGoal("retell"), { type: "goal-chosen", goal: "both" });
    for (const event of [
      { type: "monitoring-ready" },
      { type: "connection-ready" },
      { type: "tests-ready", count: 2 },
      { type: "review-approved", count: 2 },
      { type: "wizard-completed" },
    ] as const) {
      state = move(state, event);
    }

    expect(state).toEqual({
      phase: "complete",
      platform: "retell",
      goal: "both",
      testCount: 2,
      codingAgentId: "claude",
    });
  });

  it("will not start connection setup before monitoring is set up", () => {
    const state = move(askedTheGoal("retell"), { type: "goal-chosen", goal: "both" });
    const result = transitionWizard(state, { type: "connection-ready" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an invalid transition");
    expect(result.error.phase).toBe("monitoring-setup");
  });

  it("offers exactly three answers, and no fourth", () => {
    expect(WIZARD_GOALS).toEqual(["testing", "monitoring", "both"]);
  });
});

describe("the terminals the goal question did not change", () => {
  it("ends at no-agent when discovery finds no voice agent", () => {
    let state = move(selected(), { type: "intro-accepted" });
    state = move(state, { type: "agent-not-found" });

    expect(state).toEqual({ phase: "no-agent", codingAgentId: "claude" });
  });

  it.each(["pipecat", "vapi"] as const)(
    "ends at unsupported-platform for %s, without ever asking the goal",
    (platform) => {
      let state = move(selected(), { type: "intro-accepted" });
      state = move(state, { type: "agent-unsupported", platform });
      expect(state).toEqual({ phase: "unsupported-platform", platform, codingAgentId: "claude" });
    },
  );

  it("ends at no-coding-agent when there is none to drive", () => {
    expect(
      move(authorized(), { type: "coding-agent-unavailable" }),
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
