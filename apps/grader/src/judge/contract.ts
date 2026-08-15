import type { JudgeProvider } from "@egma/db";

import type { JudgeInput } from "./input.ts";

/**
 * What a judge is asked and what every judge answers with.
 *
 * The contract lives on its own, apart from the roster that dispatches on it,
 * for the reason the grader types' does: adding a provider is adding a file
 * that imports this one, never editing the thing every other provider also
 * imports.
 */

/**
 * One judge call: one criterion, decided against one conversation's evidence.
 *
 * **One criterion, singular, and the type is the guarantee.** Per-assertion
 * isolation is the whole shape of the built-in grader — each expected behavior
 * gets its own independent call — and a request that could carry two criteria
 * is a request somebody would eventually put two in. The evidence is assembled
 * once per conversation and shared; the criterion is what makes each call
 * different, and it is the only thing that does.
 */
export type JudgeQuestion = {
  /** The one thing this call decides, in the words it was written in. */
  readonly criterion: string;
  /** What the judge may read, declared. */
  readonly evidence: JudgeInput;
};

/**
 * What a judge is allowed to say.
 *
 * **`cannot_determine` is a first-class answer**, not an error and not a
 * failure. A judge that could only say yes or no would have to guess when the
 * transcript does not settle the question, and a guess dressed as a judgment is
 * exactly the false trust this product exists to kill. It becomes `skipped` on
 * the verdict row and leaves the score's denominator — Coval's rule for the
 * same problem — so a behavior nobody could judge neither passes nor fails
 * anything.
 */
export type Decision = "met" | "not_met" | "cannot_determine";

export const DECISIONS: readonly Decision[] = [
  "met",
  "not_met",
  "cannot_determine",
];

export type JudgeAnswer = {
  readonly decision: Decision;
  /** One line saying why, in words somebody reading the record can use. */
  readonly rationale: string;
  /**
   * The turns this answer is about, by the numbers the transcript was shown
   * with. Empty is honest — a behavior about what the agent never said has no
   * turn to point at — and a number outside the transcript is dropped by the
   * caller rather than filed as evidence nobody can look up.
   */
  readonly citedTurns: readonly number[];
};

/**
 * One judge, configured: ask it a question, get an answer.
 *
 * Asynchronous and single-question, so the fan-out that makes one call per
 * behavior is written once, in the grader, rather than once per provider.
 */
export type Judge = (question: JudgeQuestion) => Promise<JudgeAnswer>;

/**
 * A judge as the project configured it, with the key resolved.
 *
 * The key is here because a provider cannot speak to an account without one,
 * and it is here **and nowhere else**: it is held for the length of one
 * grading, handed to one `fetch`, and never written to a row, a log line or a
 * rationale. Nothing in this file or under it prints it, and nothing outside
 * this directory is ever handed one of these.
 */
export type ResolvedJudge = {
  readonly provider: JudgeProvider;
  readonly model: string;
  readonly key: string;
};

/**
 * One provider, made into a judge. The seam: `openai` is the only entry today,
 * and Anthropic or an OpenAI-compatible endpoint is a second file plus a line
 * in the roster.
 */
export type JudgeMaker = (judge: ResolvedJudge) => Judge;
