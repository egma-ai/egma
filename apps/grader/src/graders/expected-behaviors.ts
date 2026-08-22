import type { GraderDefinitionSnapshot } from "@egma/db";

import { judgeInputOf, type JudgeQuestion } from "../judge/index.ts";
import type {
  Execution,
  GraderAssertionResult,
  GraderResult,
} from "./contract.ts";
import { assertionResultOf } from "./judged.ts";

/**
 * Grade every expected behavior independently, then return one grader result.
 *
 * Each behavior still gets its own model call and its own evidence. Those
 * answers are assertion details, not separate grade rows. One assertion error
 * makes the top-level grade an error while preserving every completed detail.
 */
export async function executeExpectedBehaviors(
  execution: Execution,
): Promise<GraderResult> {
  const behaviors = await execution.reading.expectedBehaviors();
  if (behaviors.length === 0) {
    return {
      score: null,
      details: {
        error: "the test defines no expected behaviors to grade",
        assertions: [],
      },
    };
  }

  const nothingToGrade = execution.conversation.nothingToJudgeBecause;
  if (nothingToGrade !== null) {
    return errored(
      behaviors.map((_, at) => assertionError(at, nothingToGrade)),
      nothingToGrade,
    );
  }

  const prompt = judgePromptOf(execution.definition);
  if (prompt === null) {
    const reason =
      "this grader definition has no judge prompt, so Egma could not grade it";
    return errored(
      behaviors.map((_, at) => assertionError(at, reason)),
      reason,
    );
  }

  const judge = execution.judging.judge;
  if (judge === null) {
    throw new Error("a model-judged grader reached execution without its judge");
  }

  const evidence = judgeInputOf(execution.conversation);
  const assertions = await Promise.all(
    behaviors.map(async (behavior, at): Promise<GraderAssertionResult> => {
      const question: JudgeQuestion = { prompt, criterion: behavior, evidence };
      try {
        return assertionResultOf(
          behaviorAssertionKey(at),
          await judge.ask(question),
          evidence.transcript,
        );
      } catch (error) {
        return assertionError(
          at,
          `this behavior could not be graded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
  );

  const failedToGrade = assertions.filter(
    (assertion) => assertion.error !== undefined,
  );
  if (failedToGrade.length > 0) {
    return errored(
      assertions,
      `${failedToGrade.length} of ${assertions.length} expected behaviors could not be graded`,
    );
  }

  const passed = assertions.filter((assertion) => assertion.score === 1).length;
  return {
    score: passed / assertions.length,
    details: {
      rationale:
        `${passed} of ${assertions.length} expected behaviors passed.`,
      assertions,
    },
  };
}

function judgePromptOf(definition: GraderDefinitionSnapshot): string | null {
  const prompt = definition.prompt;
  return prompt === null || prompt.trim() === "" ? null : prompt;
}

function assertionError(at: number, error: string): GraderAssertionResult {
  return { key: behaviorAssertionKey(at), error };
}

/** Stable within the frozen ordered behavior list, one-based for display. */
function behaviorAssertionKey(at: number): string {
  return `behavior_${at + 1}`;
}

function errored(
  assertions: readonly GraderAssertionResult[],
  error: string,
): GraderResult {
  return { score: null, details: { error, assertions } };
}
