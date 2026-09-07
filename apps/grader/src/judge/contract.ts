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
  /**
   * Which assertion of the grader this call decides, by the stable key the
   * result is filed under — `behavior_1`, `instruction_1`.
   *
   * It rides the question because a usage record's identity needs it: one
   * grader fans out over several behaviors in parallel, and the calls differ
   * only by which one they decide. Without it, two of them made in the same
   * attempt of the same job would be one record, and a fan-out of three would
   * be charged as one.
   */
  readonly assertion: string;
  /** What the judge may read, declared. */
  readonly evidence: JudgeInput;
};

/**
 * One provider request a judge actually made, as the grader records it.
 *
 * Reported per HTTP attempt that came back with a body, rather than per
 * question: a retry after a rate limit is a second request the provider
 * answered, and it is real spend. An attempt that never got a body — a
 * timeout, a refusal — reports nothing, because there is nothing the provider
 * said it consumed.
 */
export type JudgeUsage = {
  /** When the provider answered. */
  readonly occurredAt: Date;
  /** Which assertion this call decided. */
  readonly assertion: string;
  /** Which HTTP attempt of that call this was, counted from one. */
  readonly httpAttempt: number;
  /**
   * The provider's own id for the response, where it gave one.
   *
   * There is no model here, and that is the decision rather than an omission.
   * OpenAI answers `gpt-5.6-terra-2026-08-01` to a request that asked for
   * `gpt-5.6-terra`, and the rate card is keyed by the catalog Egma itself
   * closed — so the record is written against the pinned selection, and a
   * served string on this shape would be a second candidate for the one field
   * that decides a price.
   */
  readonly providerRef: string | undefined;
  /**
   * The billable counts, normalised: `input_tokens` is the **uncached** part
   * of the prompt, because OpenAI's own `prompt_tokens` includes the cached
   * tokens and rating the whole of it at the uncached price would charge for
   * the cache twice.
   */
  readonly quantities: Readonly<Record<string, number>>;
  /** The provider's usage object, verbatim, for a later re-rating. */
  readonly rawUsage: Readonly<Record<string, unknown>>;
};

/**
 * Where a judge hands over what one request consumed.
 *
 * A sink rather than a field on the answer: a judge makes as many requests as
 * its retries need and answers once, so the two are not the same event, and an
 * answer carrying only the last attempt's usage would quietly lose the spend of
 * every attempt before it.
 */
export type JudgeUsageSink = (usage: JudgeUsage) => void;

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
  /**
   * Where this judge reports what each of its requests consumed. Absent where
   * nobody is collecting — a unit test asking one question — and the adapter
   * then measures nothing rather than holding numbers no one will read.
   */
  readonly usage?: JudgeUsageSink | undefined;
};

/**
 * One provider, made into a judge. The seam: `openai` is the only entry today,
 * and Anthropic or an OpenAI-compatible endpoint is a second file plus a line
 * in the roster.
 */
export type JudgeMaker = (judge: ResolvedJudge) => Judge;
