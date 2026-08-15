import { turnReference, type JudgeAnswer } from "../judge/index.ts";
import type { Judgment } from "./contract.ts";

/**
 * What a judge's answer becomes, for every grader that asks one.
 *
 * The built-in behaviors grader and the rubric type ask about different things —
 * one expectation a test's author wrote down, one criterion a team wrote down —
 * and they file the answers under different assertions, different versions and
 * different priorities. What each does with the answer *itself* is identical,
 * and it is three decisions that must not be made twice:
 *
 * - **`cannot_determine` is `skipped`, and never `failed`.** A judge that could
 *   only say yes or no would guess, and a guess dressed as a judgment is the
 *   false trust this product exists to kill. `skipped` leaves the score's
 *   denominator, so a criterion nobody could judge neither passed nor failed
 *   anything.
 * - **The score follows the word.** A written-down criterion is met or it is
 *   not; there is no half of one. `skipped` scores zero and is out of the
 *   denominator, so the number it carries is never counted either way.
 * - **Only turns that are actually in the transcript are cited.** A judgment
 *   citing turn nine of a seven-turn conversation is pointing a reader at
 *   nothing, and dropping it is better than filing evidence nobody can look up.
 *
 * Deliberately here rather than in `contract.ts`, which every type imports and
 * which nothing should have to edit: this is a helper the judged types share,
 * and the next type that judges with a model imports it the same way.
 *
 * Who decided it is the caller's to add. The built-in records one judge for the
 * whole fan-out, an authored grader records its own — that is a fact about the
 * grader rather than about the answer.
 */
export function judgmentOf(
  assertion: string,
  answer: JudgeAnswer,
  turns: number,
): Judgment {
  const verdict =
    answer.decision === "met"
      ? "passed"
      : answer.decision === "not_met"
        ? "failed"
        : "skipped";

  return {
    assertion,
    verdict,
    score: verdict === "passed" ? 1 : 0,
    rationale: answer.rationale,
    citedSpanIds: answer.citedTurns
      .filter((cited) => cited >= 1 && cited <= turns)
      .map(turnReference),
  };
}
