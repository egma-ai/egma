import type {
  GraderJudgment,
  GraderType,
  JudgeModel,
  Verdict,
} from "@egma/db";

import type { Conversation } from "../conversation.ts";
import type { JudgeMakers, JudgeResolution } from "../judge/index.ts";

/**
 * What every grader type is handed and what every one of them answers with.
 *
 * The contract lives on its own, apart from the roster that dispatches on it, so
 * that adding a type is adding a file that imports this one — never editing the
 * thing every other type also imports.
 */

/**
 * One judged assertion, as the grader that judged it decided — before egma
 * stamps whose it was and when.
 *
 * Nothing about how loudly it speaks is here, and there is nothing left to put
 * here: scoring is binary, so every assertion of every applicable grader has to
 * pass and no judgment can be worth less than another.
 */
export type Judgment = {
  /**
   * Which 0-or-1 check inside the grader was judged, as its **key**: one
   * expected behavior's position, or the single check a one-check grader makes.
   *
   * **It must be stable across the grader's versions**, and that is a hard
   * constraint rather than a preference: the fold counts one assertion once,
   * keyed by the conversation, the grader and this name, and prefers the latest
   * grading of it. An assertion name that changed when the config changed would
   * make a re-grade at a tightened threshold a *second* assertion, counted
   * beside the first forever, with both of them speaking. So nothing derived
   * from the config may appear here.
   */
  readonly assertion: string;
  readonly verdict: Verdict;
  /** Between 0 and 1. A one-check grader answers 1 or 0. */
  readonly score: number;
  /** One line saying why, in words somebody reading the record can use. */
  readonly rationale: string;
  /** The spans this judgment is about, by their own ids. */
  readonly citedSpanIds: readonly string[];
};

/**
 * How a grader type that judges with a model reaches one.
 *
 * **A capability rather than a fact about the grader.** It is handed to every
 * executor, including the deterministic ones, and the deterministic ones simply
 * never call it — resolving a judge is what unseals a project's key, so a
 * conversation whose graders are all deterministic never opens the envelope
 * however many of them were handed this. That is what keeps "asked for only if
 * something judges" a property of the shape rather than of the roster.
 *
 * **The key is deliberately absent, and cannot be reached from here.** What
 * `judging` answers with is a way to ask and a `provider/model` name to record,
 * so no grader type — today's or tomorrow's — can put a secret in a rationale, a
 * verdict row or a log line.
 */
export type Judging = {
  /**
   * The project's judge, resolved at most once per conversation and shared by
   * everything on it that judges — so five judged checks cost one read of the
   * configuration rather than five, and all of them speak with one account.
   */
  readonly judge: JudgeResolution;
  /** How each provider is spoken to. A test hands over a scripted one. */
  readonly makers: JudgeMakers;
  /**
   * This grader version's own judge, or `null` for the project's default.
   *
   * The override is judged content: it lives on the immutable version beside the
   * config, so a verdict written under it stays readable as "decided by this
   * model" long after the project's default moved on. It names a provider and a
   * model and never a key, so a grader cannot move a project's judging onto an
   * account nobody configured.
   */
  readonly model: JudgeModel | null;
};

/**
 * What a grader is handed, and all it is handed: what it judges by, the
 * conversation, and a way to reach a judge. Not the grader's name and not whose
 * it is — an executor that could see either could be written to answer with it.
 *
 * Narrowed by the type, so a `metric_threshold` executor is handed a
 * `MetricThresholdConfig` and cannot be handed anything else. The pair travels
 * together, inseparable, from the factory's read all the way to the executor.
 */
export type ExecutionOf<Type extends GraderType> = {
  readonly judgment: Extract<GraderJudgment, { readonly type: Type }>;
  readonly conversation: Conversation;
  readonly judging: Judging;
};

/** Any grader's execution, which is what the dispatch holds. */
export type Execution = ExecutionOf<GraderType>;

/**
 * One grader type, executed. Asynchronous because the judged types will call a
 * model and the deterministic ones will not, and a seam that only fitted the
 * deterministic ones would have to be rebuilt for the first judge.
 */
export type ExecutorFor<Type extends GraderType> = (
  execution: ExecutionOf<Type>,
) => readonly Judgment[] | Promise<readonly Judgment[]>;

/**
 * What a grader that makes exactly one check names its one assertion: its own
 * type.
 *
 * Stable across every version of the grader, because a grader's type is set at
 * creation and can never be edited — which is precisely the property the fold's
 * assertion key needs, and the reason nothing from the config is allowed near
 * it. A grader that judges several things at once names its assertions itself
 * and never comes here.
 */
export function theOneCheck(type: GraderType): string {
  return type;
}
