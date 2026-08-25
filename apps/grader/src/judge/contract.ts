import type { ReasoningEffort } from "@egma/db";

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
 * isolation is the whole shape of the expected-behaviors grader — each expected
 * behavior gets its own independent call — and a request that could carry two
 * criteria is a request somebody would eventually put two in. The evidence is
 * assembled once per conversation and shared; the criterion is what makes each
 * call different, and it is the only thing that does.
 */
export type JudgeQuestion = {
  /**
   * The words the judge is told it is working under — **the exact immutable
   * Library definition revision the grader version pins**.
   *
   * It rides the question rather than being held in this package because there
   * is exactly one executable copy of a revision, and it is not here. A catalog
   * update inserts the next shared revision; it never rewrites the prompt used
   * by a run that already started.
   */
  readonly prompt: string;
  /** The one thing this call decides, in the words it was written in. */
  readonly criterion: string;
  /** What the judge may read, declared. */
  readonly evidence: JudgeInput;
};

/**
 * What a judge is allowed to say.
 *
 * **`cannot_determine` is a first-class model answer and a grading error.** A
 * judge that could only say yes or no would have to guess when the transcript
 * does not settle the question. The expected-behaviors grader keeps the answer
 * in assertion details and returns a null top-level score, so uncertainty can
 * never make the combined score look better by disappearing from it.
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
 * One grader version's exact judge, with its deployment key resolved.
 *
 * The key is here because a provider cannot speak to an account without one,
 * and it is here **and nowhere else**: it is held for the length of one
 * grading, handed to one `fetch`, and never written to a row, a log line or a
 * rationale. Nothing in this file or under it prints it, and nothing outside
 * this directory is ever handed one of these.
 */
export type ResolvedJudge = {
  readonly provider: "openai";
  readonly model: string;
  /** Release-owned provider setting for this stored model pair. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly key: string;
};

/**
 * One provider, made into a judge. The seam: `openai` is the only entry today,
 * and Anthropic or an OpenAI-compatible endpoint is a second file plus a line
 * in the roster.
 */
export type JudgeMaker = (judge: ResolvedJudge) => Judge;
