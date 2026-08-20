import type { Judging } from "../../src/graders/index.ts";
import type {
  Judge,
  JudgeAnswer,
  JudgeMakers,
  JudgeQuestion,
  ResolvedJudge,
} from "../../src/judge/index.ts";
import { judgeFor } from "../../src/judge/index.ts";

/**
 * The scripted judge: deterministic answers, no key, no network.
 *
 * **This is the seam the whole engine suite runs on.** Per-behavior fan-out,
 * the skipped denominator, one judge call failing while its siblings land —
 * every one of those is a claim about egma rather than about a model, and
 * asserting them against a real judge would be
 * paying an account to learn something a model cannot tell you reliably anyway.
 * The thin live smoke beside these files is where a real model is asked whether
 * the wire still looks the way this pretends it does.
 *
 * It records what it was asked and what it was made from, which is how a test
 * asserts the two things that are otherwise invisible: that each call saw one
 * criterion and no other behavior's words, and that the key resolved out of the
 * credential store actually reached the provider seam — without that key ever
 * being written anywhere a verdict, a log or a report could pick it up.
 */

/** An answer, or what the provider does instead of answering. */
export type Scripted = JudgeAnswer | Error;

export type ScriptedJudge = {
  /** Hand this to the service or to `gradeClaim`. */
  readonly makers: JudgeMakers;
  /** Every question asked, in the order the calls were made. */
  readonly asked: readonly JudgeQuestion[];
  /** Every judge it was configured as — provider, model, and the key it got. */
  readonly configured: readonly ResolvedJudge[];
};

export type ScriptedJudgeOptions = {
  /**
   * What it says about each criterion, keyed by the criterion's exact words.
   * An `Error` is thrown instead of answered, which is what a provider that
   * refused after its retries looks like from here.
   */
  readonly answers: Readonly<Record<string, Scripted>>;
  /** What it says about a criterion nothing scripted. */
  readonly otherwise?: Scripted | undefined;
};

export function scriptedJudge(options: ScriptedJudgeOptions): ScriptedJudge {
  const asked: JudgeQuestion[] = [];
  const configured: ResolvedJudge[] = [];

  const cannotTell: JudgeAnswer = {
    decision: "cannot_determine",
    rationale: "nothing was scripted for this criterion.",
    citedTurns: [],
  };

  const makers: JudgeMakers = {
    openai: (judge: ResolvedJudge): Judge => {
      configured.push(judge);
      return async (question: JudgeQuestion): Promise<JudgeAnswer> => {
        asked.push(question);
        const said = options.answers[question.criterion] ?? options.otherwise ?? cannotTell;
        if (said instanceof Error) throw said;
        return said;
      };
    },
  };

  return { makers, asked, configured };
}

/**
 * The judge seam as an executor is handed it, with no project and no store
 * behind it — for the unit tests that judge one conversation with one config.
 *
 * The whole path from a pinned grader version and current deployment credential
 * to a provider client has its own service tests. What is stood in for here is
 * only that client, so that "this rubric asked one question and the answer
 * became this row" is testable without a database.
 */
export function scriptedJudging(
  options: ScriptedJudgeOptions,
): { readonly judging: Judging; readonly judge: ScriptedJudge } {
  const judge = scriptedJudge(options);

  return {
    judge,
    judging: {
      judge: judgeFor(
        { provider: "openai", model: "gpt-4o-mini" },
        { openai: "sk-egma-unit-judge-NEVERLEAKME" },
        judge.makers,
      ),
    },
  };
}

/**
 * The judge seam handed to a grader that must never reach for one.
 *
 * Every deterministic type is handed a way to judge, because the seam is one
 * shape for every type — and every one of them is supposed to answer without
 * touching it. Asking here throws, so "no model was called" is an assertion the
 * suite makes rather than a claim the doc comment makes.
 */
export function noJudgeWanted(): Judging {
  return { judge: null };
}

/** An answer in one line, for the ordinary case. */
export function met(rationale: string, citedTurns: readonly number[] = []): JudgeAnswer {
  return { decision: "met", rationale, citedTurns };
}

export function notMet(
  rationale: string,
  citedTurns: readonly number[] = [],
): JudgeAnswer {
  return { decision: "not_met", rationale, citedTurns };
}

export function cannotDetermine(rationale: string): JudgeAnswer {
  return { decision: "cannot_determine", rationale, citedTurns: [] };
}
