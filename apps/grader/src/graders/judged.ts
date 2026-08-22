import type { JudgeAnswer, Turn } from "../judge/index.ts";
import type { GraderAssertionResult } from "./contract.ts";

/**
 * Turn one model answer into assertion evidence.
 *
 * `cannot_determine` is a grading error in the score model. It does not become
 * zero, because zero says the agent failed a rule while this answer says Egma
 * could not decide.
 */
export function assertionResultOf(
  key: string,
  answer: JudgeAnswer,
  turns: readonly Turn[],
): GraderAssertionResult {
  const citedSpanIds = answer.citedTurns
    .map((cited) => turns[cited - 1]?.spanId)
    .filter((spanId): spanId is string => spanId !== undefined);

  if (answer.decision === "cannot_determine") {
    return {
      key,
      rationale: answer.rationale,
      citedSpanIds,
      error: "the grader could not determine whether this behavior was met",
    };
  }

  return {
    key,
    score: answer.decision === "met" ? 1 : 0,
    rationale: answer.rationale,
    citedSpanIds,
  };
}
