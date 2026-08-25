import { judgeInputOf, type JudgeQuestion } from "../judge/index.ts";
import type { Execution, GraderResult } from "./contract.ts";
import { assertionResultOf } from "./judged.ts";

const PROMPT = [
  "You grade one recorded conversation against one instruction.",
  "Decide only the instruction you are given.",
  "Use cannot_determine when the evidence does not settle it.",
  "Answer with JSON containing decision, rationale, and cited_turns.",
].join("\n");

/** Grade one customer-authored instruction with one model call. */
export async function executeLlmAsJudge(
  execution: Execution,
): Promise<GraderResult> {
  const nothingToGrade = execution.conversation.nothingToJudgeBecause;
  if (nothingToGrade !== null) {
    return { score: null, details: { error: nothingToGrade } };
  }

  const instructions = execution.definition.prompt?.trim();
  if (instructions === undefined || instructions === "") {
    return {
      score: null,
      details: { error: "this grader has no grading instructions" },
    };
  }

  const judge = execution.judging.judge;
  if (judge === null) {
    throw new Error("an LLM grader reached execution without its judge");
  }

  const evidence = judgeInputOf(execution.conversation);
  const question: JudgeQuestion = {
    prompt: PROMPT,
    criterion: instructions,
    evidence,
  };
  const answer = await judge.ask(question);
  const answered = assertionResultOf(
    "instruction_1",
    answer,
    evidence.transcript,
  );
  const assertion = answer.decision === "cannot_determine"
    ? {
        ...answered,
        error:
          "the grader could not determine whether the grading instructions were met",
      }
    : answered;

  if (assertion.error !== undefined) {
    return {
      score: null,
      details: {
        error: assertion.error,
        rationale: assertion.rationale,
        assertions: [assertion],
      },
    };
  }

  if (assertion.score === undefined) {
    return {
      score: null,
      details: {
        error: "the judge returned no score",
        assertions: [assertion],
      },
    };
  }

  return {
    score: assertion.score,
    details: {
      rationale: assertion.rationale,
      assertions: [assertion],
    },
  };
}
