import {
  judgeInputOf,
  turnReference,
  NoJudge,
  type JudgeAnswer,
} from "../judge/index.ts";
import { theOneCheck, type ExecutionOf, type Judgment } from "./contract.ts";

/**
 * A team's own criteria, in the words they wrote them in, decided by a judge.
 *
 * "Was the agent empathetic when the caller got frustrated" is not a substring
 * and not a number, and it is the question a team most wants answered. This is
 * the type that answers it: the rubric goes to a model as one criterion, the
 * model's decision becomes one verdict row, and the row names the model that
 * made it.
 *
 * ## One rubric, one call, one row
 *
 * The config holds a `rubric` — singular, one block of criteria text — so this
 * asks one question and produces one dimension. A grader that wants two things
 * decided separately is two graders, which is one call each to create and gives
 * two rows a developer can read apart. Splitting one rubric's text here, on
 * whatever punctuation looked like a list, would invent criteria nobody wrote.
 *
 * The dimension is the grader's own type, like every other one-check type's.
 * Not the rubric's text: a dimension name may derive nothing from the config,
 * because the fold counts one dimension once per grader and prefers the latest
 * grading of it — a rubric reworded would otherwise become a *second* dimension
 * counted beside the first forever, with both of them speaking.
 *
 * ## The judge is the project's, and the override is this version's
 *
 * The same seam the built-in behaviors grader uses, and deliberately the same
 * one: the project's judge configuration is read at most once per conversation
 * and shared, so five judged checks on one conversation cost one read of the
 * configuration and speak with one account.
 *
 * Where this type differs from the built-in is the override. A grader version
 * may name its own provider and model — a stronger judge on the subtle rubric,
 * a cheap one on the routine checks, on one account — and that name is passed
 * here. It never names a key: the key is the project's whatever the override
 * says, so no grader can move a project's judging onto an account nobody
 * configured. What comes back is a way to ask and a `provider/model` name to
 * record, and there is nothing on that pair a secret could travel on.
 *
 * ## What it says when it cannot say anything
 *
 * - **The project configured no judge**, or its key will not open: `errored`,
 *   saying which. A check egma could not make is never a check that passed.
 * - **The judge could not tell**: `skipped`, which leaves the score's
 *   denominator. A judge that could only say yes or no would guess, and a guess
 *   dressed as a judgment is the false trust this product exists to kill.
 * - **The call failed after its retries**: that is left to the engine, which
 *   turns any executor falling over into one `errored` row saying so — the same
 *   handling every grader type gets, written once above the seam.
 */
export async function executeLlmRubric(
  execution: ExecutionOf<"llm_rubric">,
): Promise<readonly Judgment[]> {
  const { config } = execution.judgment;
  const dimension = theOneCheck("llm_rubric");

  // Only now, with a rubric to decide and a conversation that happened, is the
  // project's key worth unsealing. The engine has already refused to execute
  // anything for a simulation that never ran.
  const resolved = await execution.judging.judge();
  if (resolved instanceof NoJudge) {
    return [
      {
        dimension,
        verdict: "errored",
        score: 0,
        rationale: resolved.message,
        citedSpanIds: [],
      },
    ];
  }

  const judge = resolved.judging(
    execution.judging.model,
    execution.judging.makers,
  );

  const evidence = judgeInputOf(execution.conversation);
  const answer = await judge.ask({ criterion: config.rubric, evidence });

  return [asJudgment(dimension, answer, judge.name, evidence.transcript.length)];
}

/** One judge's answer, as the verdict row it becomes. */
function asJudgment(
  dimension: string,
  answer: JudgeAnswer,
  judgedBy: string,
  turns: number,
): Judgment {
  const verdict =
    answer.decision === "met"
      ? "passed"
      : answer.decision === "not_met"
        ? "failed"
        : "skipped";

  return {
    dimension,
    verdict,
    // A rubric is met or it is not; there is no half of a written-down
    // criterion. `skipped` scores zero and is out of the denominator, so the
    // number it carries is never counted either way.
    score: verdict === "passed" ? 1 : 0,
    rationale: answer.rationale,
    // Only turns that are actually in the transcript. A judgment citing turn
    // nine of a seven-turn conversation is pointing a reader at nothing, and
    // dropping it is better than filing evidence nobody can look up.
    citedSpanIds: answer.citedTurns
      .filter((cited) => cited >= 1 && cited <= turns)
      .map(turnReference),
    // The judge that answered, on the row, and never the account: `judged_by`
    // is part of a verdict's identity, so a project that changes its judge model
    // gets rows beside the old ones rather than over them.
    judgedBy,
  };
}
