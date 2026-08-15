import { turnReference, type JudgeAnswer } from "../judge/index.ts";
import type { Judgment } from "./contract.ts";

/**
 * What a judge's answer becomes, for every grader that asks one.
 *
 * One judged entry ships today and more will follow, each asking about its own
 * kind of thing and filing the answers under its own keys. What each does with
 * the answer *itself* has to be identical, and it is three decisions that must
 * not be made twice:
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
 * Deliberately here rather than in `contract.ts`, which every executor imports
 * and which nothing should have to edit: this is a helper the judged entries
 * share, and the next entry that judges with a model imports it the same way.
 *
 * The answer says nothing about who gave it, and nothing downstream asks. Which
 * judge answered was carried to the verdict row's `judged_by`, and that column
 * retired with the human corrections it existed for.
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
