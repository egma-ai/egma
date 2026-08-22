import { PREDEFINED_GRADERS } from "@egma/db";

import type {
  Execution,
  GraderExecutor,
  GraderResult,
} from "./contract.ts";
import { executeExpectedBehaviors } from "./expected-behaviors.ts";

/** The shared definitions this worker knows how to execute. */
const EXECUTORS: Readonly<Record<string, GraderExecutor | undefined>> = {
  [PREDEFINED_GRADERS.expectedBehaviors]: {
    execute: executeExpectedBehaviors,
  },
};

/** Execute one frozen grader definition and return one top-level result. */
export async function execute(execution: Execution): Promise<GraderResult> {
  const executor = EXECUTORS[execution.definition.definitionId];
  if (executor === undefined) {
    return {
      score: null,
      details: {
        error:
          `Egma does not execute grader definition ${
            execution.definition.definitionId
          } yet`,
      },
    };
  }
  return executor.execute(execution);
}

export type {
  Execution,
  Executor,
  GraderAssertionResult,
  GraderExecutor,
  GraderResult,
  GraderResultDetails,
  Judging,
  Reading,
} from "./contract.ts";
