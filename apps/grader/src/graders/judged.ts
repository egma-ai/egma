import type { JudgeResult, Turn } from "../judge/index.ts";
import type { GraderAssertionResult } from "./contract.ts";

/** Only a confirmed met decision earns credit; the decision remains evidence. */
export function assertionResultOf(
  key: string,
  answer: JudgeResult,
  turns: readonly Turn[],
): GraderAssertionResult {
  const citedSpanIds = answer.cited_turns
    .map((cited) => turns[cited - 1]?.spanId)
    .filter((spanId): spanId is string => spanId !== undefined);

  return {
    key,
    decision: answer.decision,
    score: answer.decision === "met" ? 1 : 0,
    rationale: answer.rationale,
    citedSpanIds,
    citedTurns: answer.cited_turns,
  };
}
