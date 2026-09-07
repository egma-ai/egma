import type { ReasoningEffort } from "@egma/db";
import type { JudgeInput } from "./input.ts";

/** One request carries the saved instruction and the complete pinned context. */
export type JudgeQuestion = {
  readonly prompt: string;
  readonly criterion: string;
  readonly expectedBehaviors: readonly { readonly id: string; readonly text: string }[];
  readonly evidence: JudgeInput;
};

export type JudgeUsage = {
  /** When the provider answered. */
  readonly occurredAt: Date;
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

export type Decision = "met" | "not_met" | "cannot_determine";
export const DECISIONS: readonly Decision[] = ["met", "not_met", "cannot_determine"];

export type JudgeResult = {
  readonly id: string;
  readonly decision: Decision;
  readonly rationale: string;
  readonly cited_turns: readonly number[];
};
export type JudgeAnswer = { readonly results: readonly JudgeResult[] };
export type Judge = (question: JudgeQuestion) => Promise<JudgeAnswer>;

/** Credentials are operational and are never stored in parameters or results. */
export type ResolvedJudge = {
  readonly provider: "openai";
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly key: string;
  readonly usage?: JudgeUsageSink | undefined;
};
export type JudgeMaker = (judge: ResolvedJudge) => Judge;
