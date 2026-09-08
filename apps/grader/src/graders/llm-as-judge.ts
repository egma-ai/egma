import { ProviderKeyUnavailableError } from "@egma/db";
import { judgeInputOf, type JudgeQuestion } from "../judge/index.ts";
import { validateJudgeAnswer } from "../judge/response.ts";
import type { Execution, GraderResult } from "./contract.ts";
import { assertionResultOf } from "./judged.ts";

const PROMPT = [
  "You grade one recorded conversation using the supplied saved instruction (instruction_1).",
  "Follow that instruction. Unless it asks you to evaluate the supplied expected behaviors separately, return exactly one result for instruction_1.",
  "The test expected behaviors are context; do not adopt them as criteria unless the saved instruction asks you to.",
  "Set decision to exactly one of met, not_met, or cannot_determine.",
  "Use met when the evidence shows the instruction was met.",
  "Use not_met when the evidence shows the instruction was not met.",
  "Use cannot_determine when the evidence does not settle the instruction.",
  "Return a JSON object with a results array. Each result contains id, decision, rationale, and cited_turns.",
  "Return instruction_1 alone or exactly one result for every supplied behavior ID. Do not mix, omit, duplicate, or invent IDs.",
  "Cite only supplied transcript turn numbers, or use an empty array when no specific turns can be cited.",
  "Follow the required response schema. Do not calculate an overall score; Egma calculates it from the decisions.",
].join("\n");

/** One shared request and scoring path for every saved LLM grader prompt. */
export async function executeLlmAsJudge(execution: Execution): Promise<GraderResult> {
  const nothingToGrade = execution.conversation.nothingToJudgeBecause;
  if (nothingToGrade !== null) return { score: null, details: { error: nothingToGrade } };
  const instructions = execution.definition.prompt?.trim();
  if (!instructions) return { score: null, details: { error: "this grader has no grading instructions" } };
  const judge = execution.judging.judge;
  if (judge === null) throw new Error("an LLM grader reached execution without its judge");
  const evidence = judgeInputOf(execution.conversation);
  const question: JudgeQuestion = {
    prompt: PROMPT,
    criterion: instructions,
    expectedBehaviors: (await execution.reading.expectedBehaviors()).map((text, at) => ({ id: `behavior_${at + 1}`, text })),
    evidence,
  };
  try {
    const answer = validateJudgeAnswer(await judge.ask(question), question);
    const assertions = answer.results.map((one) => assertionResultOf(one.id, one, evidence.transcript));
    const errors = assertions.filter((one) => one.error !== undefined);
    if (errors.length > 0) {
      return { score: null, details: {
        error: `${errors.length} of ${assertions.length} criteria could not be graded`, assertions,
      } };
    }
    const met = answer.results.filter((one) => one.decision === "met").length;
    return { score: met / assertions.length, details: {
      rationale: assertions.length === 1 ? assertions[0]?.rationale : `${met} of ${assertions.length} criteria passed.`,
      assertions,
    } };
  } catch (error) {
    if (error instanceof ProviderKeyUnavailableError) throw error;
    return { score: null, details: { error: `this grader could not produce a score: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
