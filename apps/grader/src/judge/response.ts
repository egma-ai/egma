import { DECISIONS, type JudgeAnswer, type JudgeQuestion, type JudgeResult } from "./contract.ts";

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || fields.some((key) => !(key in value))) {
    throw new Error(`the judge response must contain exactly ${fields.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

/** The response family must be complete; the saved prompt chooses that family. */
export function validateJudgeAnswer(value: unknown, question: JudgeQuestion): JudgeAnswer {
  const root = object(value, ["results"]);
  if (!Array.isArray(root.results) || root.results.length === 0) {
    throw new Error("the judge response needs a nonempty results array");
  }
  const ids = new Set<string>();
  const turns = new Set(question.evidence.transcript.map((turn) => turn.at));
  const results = root.results.map((value): JudgeResult => {
    const result = object(value, ["id", "decision", "rationale", "cited_turns"]);
    if (typeof result.id !== "string" || typeof result.rationale !== "string" ||
      !DECISIONS.includes(result.decision as never) || !Array.isArray(result.cited_turns) ||
      result.cited_turns.some((turn) => typeof turn !== "number" || !Number.isInteger(turn) || !turns.has(turn))) {
      throw new Error("the judge response has an invalid id, decision, rationale, or cited turn");
    }
    if (ids.has(result.id)) throw new Error("the judge response repeats a result id");
    ids.add(result.id);
    return result as JudgeResult;
  });
  const instruction = ids.size === 1 && ids.has("instruction_1");
  const behaviors = question.expectedBehaviors;
  const completeBehaviors = behaviors.length > 0 && ids.size === behaviors.length &&
    behaviors.every((behavior) => ids.has(behavior.id));
  if (!instruction && !completeBehaviors) {
    throw new Error("the judge must return instruction_1 alone or every supplied behavior id; mixed, partial, and unknown results are invalid");
  }
  return { results };
}
