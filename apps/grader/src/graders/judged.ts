import { turnReference, type JudgeAnswer } from "../judge/index.ts";
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
  turns: number,
): GraderAssertionResult {
  const citedSpanIds = answer.citedTurns
    .filter((cited) => cited >= 1 && cited <= turns)
    .map(turnReference);

  if (answer.decision === "cannot_determine") {
    return {
      key,
      rationale: answer.rationale,
      citedSpanIds,
      error: "the judge could not determine whether this behavior was met",
    };
  }

  return {
    key,
    score: answer.decision === "met" ? 1 : 0,
    rationale: answer.rationale,
    citedSpanIds,
  };
}
