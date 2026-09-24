import type { GraderDefinitionSnapshot } from "@egma/db";
import { describe, expect, it } from "vitest";

import type { Conversation } from "../src/conversation.ts";
import { execute } from "../src/graders/index.ts";
import {
  cannotDetermine,
  met,
  scriptedJudging,
} from "./support/scripted-judge.ts";

const INSTRUCTIONS = "The agent must clearly explain the next step.";

function definition(): GraderDefinitionSnapshot {
  return {
    definitionId: "grl_01M01MH8KAE8ZB19B0YJ7Z7EX1",
    definitionVersion: 1,
    type: "llm_as_judge",
    prompt: INSTRUCTIONS,
    parameterContract: [],
    modalities: ["chat", "voice"],
  };
}

function conversation(
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    source: "production",
    traceId: "1111111111111111111111111111bbbb",
    nothingToJudgeBecause: null,
    endingReason: null,
    transcript: [
      {
        span_id: "aaaaaaaaaaaaaaaa",
        speaker: "agent",
        text: "I sent the request. You will get an email next.",
      },
    ],
    events: [],
    measures: [],
    runId: "",
    agentId: "",
    ...overrides,
  };
}

function execution(
  answer: ReturnType<typeof met> | ReturnType<typeof cannotDetermine>,
  overrides: Partial<Conversation> = {},
) {
  const scripted = scriptedJudging({ answers: { [INSTRUCTIONS]: answer } });
  return {
    scripted,
    execution: {
      definition: definition(),
      parameterValues: {},
      conversation: conversation(overrides),
      judging: scripted.judging,
      reading: {
        async expectedBehaviors() {
          return [];
        },
      },
    },
  };
}

describe("a customer LLM grader", () => {
  it("does not call the model when the trace is incomplete", async () => {
    const { scripted, execution: input } = execution(
      met("unused"),
      { nothingToJudgeBecause: "the trace is incomplete" },
    );

    await expect(execute(input)).resolves.toEqual({
      score: null,
      details: { error: "the trace is incomplete" },
    });
    expect(scripted.judge.asked).toEqual([]);
  });
});
