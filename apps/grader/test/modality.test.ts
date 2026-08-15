import type { Grader } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { judgmentsOf, MODALITY_UNSUPPORTED } from "../src/grade.ts";
import { met, noJudgeWanted, scriptedJudging } from "./support/scripted-judge.ts";

/**
 * A grader that cannot score the conversation in front of it.
 *
 * **`skipped`, and never `failed`.** "Recovered from a mishearing" and "did not
 * interrupt the caller" are meaningless on a chat conversation — there is no
 * speech to mishear and no audio to talk over — so a grader narrowed to voice
 * is not a check the agent failed on chat. It was never about that
 * conversation. Scoring it as a failure would make a suite red for a judgment
 * nobody made, and scoring it as `errored` would say egma broke, which is a
 * different and equally untrue thing.
 *
 * It is also not asked. A judged grader that cannot score this conversation
 * must cost no model call, which is why the check sits above the executor seam
 * rather than inside any type: it is true of every grader type that will ever
 * exist rather than of the ones that remembered.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    source: "simulation",
    traceId: "sim_01JQZ0000000000000000000AA",
    nothingToJudgeBecause: null,
    endingReason: "persona_concluded",
    transcript: [
      { speaker: "agent", text: "Thanks for calling. How can I help?" },
    ],
    events: [],
    metrics: { turn_response_latency: [900] },
    modality: "voice",
    runId: "run_01JQZ0000000000000000000AA",
    agentId: "agt_01JQZ0000000000000000000AA",
    ...overrides,
  };
}

function grader(overrides: Record<string, unknown> = {}): Grader {
  return {
    id: "grd_01JQZ0000000000000000000AA",
    projectId: "prj_01JQZ0000000000000000000AA",
    name: "Never interrupted the caller",
    description: null,
    priority: "P0",
    scope: "simulations",
    productionSampleRate: 100,
    version: 1,
    versionId: "grv_01JQZ0000000000000000000AA",
    judgeModel: null,
    reads: ["measures"],
    modalities: ["voice"],
    revision: "rev_01JQZ0000000000000000000AA",
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    type: "metric_threshold",
    config: {
      measure: "turn_response_latency",
      aggregation: "p90",
      comparator: "below",
      threshold: 2_000,
    },
    ...overrides,
  } as Grader;
}

describe("a grader narrowed to one modality", () => {
  it("skips a conversation of the other one, and says why in a word a reader can branch on", async () => {
    const [only] = await judgmentsOf(
      grader({ modalities: ["voice"] }),
      conversation({ modality: "chat" }),
      noJudgeWanted(),
    );

    expect(only).toMatchObject({
      dimension: "metric_threshold",
      verdict: "skipped",
      score: 0,
      // The word lives in its own field, so a page recognises the case without
      // matching on prose that is free to be reworded.
      reason: MODALITY_UNSUPPORTED,
      citedSpanIds: [],
    });
    // And the sentence beside it still explains itself to a person, naming both
    // sides of the mismatch so that nobody has to go and read the grader.
    expect(only?.rationale).toContain("voice");
    expect(only?.rationale).toContain("chat");
    expect(only?.rationale).not.toContain(MODALITY_UNSUPPORTED);
  });

  it("is never failed and never errored, whichever way the mismatch runs", async () => {
    const mismatches: readonly (readonly ["voice" | "chat", "voice" | "chat"])[] =
      [
        ["voice", "chat"],
        ["chat", "voice"],
      ];

    for (const [scores, ran] of mismatches) {
      for (const judgment of await judgmentsOf(
        grader({ modalities: [scores] }),
        conversation({ modality: ran }),
        noJudgeWanted(),
      )) {
        expect(judgment.verdict).toBe("skipped");
      }
    }
  });

  it("says nothing in the reason column when a check really was made", async () => {
    const [only] = await judgmentsOf(
      grader({ modalities: ["voice", "chat"] }),
      conversation({ modality: "chat" }),
      noJudgeWanted(),
    );

    expect(only?.reason).toBeUndefined();
  });

  it("judges normally when the conversation is one it scores", async () => {
    const [only] = await judgmentsOf(
      grader({ modalities: ["voice", "chat"] }),
      conversation({ modality: "chat" }),
      noJudgeWanted(),
    );

    expect(only?.verdict).toBe("passed");
  });

  /**
   * The cost half of the promise. A rubric written about speech must not spend
   * a judge call on every chat conversation — which is a bill somebody would
   * pay for judgments that were never going to say anything.
   */
  it("asks no judge at all, so a skip on a rubric costs nothing", async () => {
    const { judging, judge } = scriptedJudging({
      answers: {},
      otherwise: met("the judge was asked, which it should not have been"),
    });

    const [only] = await judgmentsOf(
      grader({
        type: "llm_rubric",
        config: { rubric: "The agent recovered from a mishearing." },
        reads: ["transcript"],
        modalities: ["voice"],
      }),
      conversation({ modality: "chat" }),
      judging,
    );

    expect(only?.verdict).toBe("skipped");
    expect(judge.asked).toEqual([]);
  });
});

/**
 * A production trace says nothing about how the person on the other end
 * reached the agent, and egma does not guess.
 *
 * The safe direction is to judge: a check that runs and says something can be
 * argued with, while a check silently skipped on a guess is a hole in the
 * record that nobody sees.
 */
describe("a conversation whose modality is unstated", () => {
  it("is judged by every grader, however narrow", async () => {
    const [only] = await judgmentsOf(
      grader({ modalities: ["voice"] }),
      conversation({ source: "production", modality: null }),
      noJudgeWanted(),
    );

    expect(only?.verdict).toBe("passed");
  });
});
