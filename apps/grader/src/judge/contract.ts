import type { ReasoningEffort } from "@egma/db";
import type { JudgeInput } from "./input.ts";

/** One request carries the saved instruction and the complete pinned context. */
export type JudgeQuestion = {
  readonly prompt: string;
  readonly criterion: string;
  readonly expectedBehaviors: readonly { readonly id: string; readonly text: string }[];
  readonly evidence: JudgeInput;
};

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
};
export type JudgeMaker = (judge: ResolvedJudge) => Judge;
