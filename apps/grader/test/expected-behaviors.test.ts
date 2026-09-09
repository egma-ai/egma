import { GRADER_DEFINITION_CATALOG, PREDEFINED_GRADERS } from "@egma/db";
import { describe, expect, it } from "vitest";
import { execute } from "../src/graders/index.ts";
import type { JudgeAnswer, JudgeQuestion } from "../src/judge/index.ts";
import type { Execution } from "../src/graders/index.ts";

const BEHAVIORS = ["Confirm cancellation", "Give a confirmation number", "Offer more help"];
const expected = GRADER_DEFINITION_CATALOG.find((one) => one.id === PREDEFINED_GRADERS.expectedBehaviors)!;
const result = (id: string, decision = "met") => ({ id, decision, rationale: `Evidence for ${id}`, cited_turns: [1] });
function input(answer: unknown, id: string = expected.id, behaviors = BEHAVIORS) {
  const asked: JudgeQuestion[] = [];
  const execution: Execution = {
    definition: { definitionId: id, definitionVersion: 1, type: "llm_as_judge", prompt: expected.prompt, parameterContract: expected.parameterContract, modalities: expected.modalities },
    parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
    conversation: { source: "simulation", traceId: "1", nothingToJudgeBecause: null, endingReason: "persona_concluded",
      transcript: [{ span_id: "aaaaaaaaaaaaaaaa", speaker: "agent", text: "Cancelled. Your number is ABC123." }],
      events: [{ kind: "tool_call", name: "cancel", arguments: { subscription: "1" }, result: "must not reach judge" }],
      measures: [], runId: "run", agentId: "agent" },
    judging: { judge: { ask: async (question) => { asked.push(question); return answer as JudgeAnswer; } } },
    reading: { expectedBehaviors: async () => behaviors },
  };
  return { execution, asked };
}

describe("the common LLM response", () => {
  it.each([expected.id, "grl_01M01MH8KAE8ZB19B0YJ7Z7EX1"])("grades three behaviors in one call for definition %s", async (id) => {
    const { execution, asked } = input({ results: [result("behavior_1"), result("behavior_2"), result("behavior_3", "not_met")] }, id);
    const grade = await execute(execution);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.criterion).toBe(expected.prompt);
    expect(asked[0]?.expectedBehaviors).toEqual([
      { id: "behavior_1", text: BEHAVIORS[0] }, { id: "behavior_2", text: BEHAVIORS[1] }, { id: "behavior_3", text: BEHAVIORS[2] },
    ]);
    expect(asked[0]?.evidence).not.toHaveProperty("outcome");
    expect(asked[0]?.evidence.toolCalls).toEqual([{ tool: "cancel", arguments: '{"subscription":"1"}' }]);
    expect(grade.score).toBe(2 / 3);
    expect(grade.details.assertions).toHaveLength(3);
    expect(grade.details.assertions?.[2]).toMatchObject({ key: "behavior_3", decision: "not_met", score: 0, citedTurns: [1], citedSpanIds: ["aaaaaaaaaaaaaaaa"] });
  });
  it("retains all criterion details when one decision cannot be determined", async () => {
    const { execution } = input({ results: [result("behavior_1"), result("behavior_2"), result("behavior_3", "cannot_determine")] });
    const grade = await execute(execution);
    expect(grade.score).toBeNull();
    expect(grade.details.error).toContain("1 of 3");
    expect(grade.details.assertions).toHaveLength(3);
    expect(grade.details.assertions?.[2]).toMatchObject({ decision: "cannot_determine", rationale: "Evidence for behavior_3", citedTurns: [1] });
  });
  it("accepts the complete instruction family with test context, without claiming prompt obedience", async () => {
    const { execution, asked } = input({ results: [result("instruction_1")] });
    expect((await execute(execution)).score).toBe(1);
    expect(asked[0]?.expectedBehaviors).toHaveLength(3);
  });
  it("does not invent test context for production", async () => {
    const { execution, asked } = input({ results: [result("instruction_1")] }, "custom", []);
    expect((await execute({ ...execution, conversation: { ...execution.conversation, source: "production" } })).score).toBe(1);
    expect(asked[0]?.expectedBehaviors).toEqual([]);
  });
  it.each([
    { results: [] },
    { results: [result("behavior_1")] },
    { results: [result("behavior_1"), result("behavior_1"), result("behavior_3")] },
    { results: [result("behavior_1"), result("behavior_2"), result("behavior_4")] },
    { results: [result("instruction_1"), result("behavior_1")] },
    { results: [result("instruction_1", "maybe")] },
    { results: [{ ...result("instruction_1"), cited_turns: [99] }] },
    { results: [{ ...result("instruction_1"), cited_turns: [1.5] }] },
    { results: [{ ...result("instruction_1"), rationale: 3 }] },
    { results: [{ ...result("instruction_1"), score: 1 }] },
    { results: [result("instruction_1")], score: 1 },
    { results: [{ id: "instruction_1", decision: "met", rationale: "no evidence field" }] },
  ])("rejects incomplete or malformed responses %# without scoring a subset", async (answer) => {
    const { execution } = input(answer);
    expect(await execute(execution)).toMatchObject({ score: null, details: { error: expect.any(String) } });
  });
  it("rejects behavior judgments when no behaviors were supplied", async () => {
    const { execution } = input({ results: [result("behavior_1")] }, "custom", []);
    expect((await execute(execution)).score).toBeNull();
  });
});
