import type { GraderType } from "@egma/db";

import {
  theOneCheck,
  type Execution,
  type ExecutorFor,
  type Judgment,
} from "./contract.ts";
import { executeLlmRubric } from "./llm-rubric.ts";
import { executeMetricThreshold } from "./metric-threshold.ts";
import { executePhraseMatch } from "./phrase-match.ts";
import { executeToolCalls } from "./tool-calls.ts";

/**
 * The executor seam: one grader type, one function, and nothing else in the
 * engine knows how any of them work.
 *
 * A grader's type decides what its config holds and how it is executed, and
 * those two facts are already inseparable in `GraderJudgment` — the type and its
 * config arrive as one narrowed pair. This file is where that pair meets the
 * conversation, and it is the only place a new type has to be added: the claim,
 * the resolution, the verdict rows and the fold are all written once, in the
 * grader's vocabulary rather than in any type's.
 *
 * **A type that is named and not yet executed is named here too**, as
 * `undefined`, so the roster is total and the compiler fails when a type joins
 * it with nowhere to run. Every type egma names today executes; the reserved
 * ones — `state_check`, `code` — arrive here first and their entry is the
 * decision that they are not built. What egma does when it meets one is below,
 * and it is deliberately not silence.
 */

/**
 * The whole roster. Total by construction — a type added to `GRADER_TYPES` with
 * no entry here does not compile.
 */
const EXECUTORS: {
  readonly [Type in GraderType]: ExecutorFor<Type> | undefined;
} = {
  metric_threshold: executeMetricThreshold,
  llm_rubric: executeLlmRubric,
  tool_calls: executeToolCalls,
  phrase_match: executePhraseMatch,
};

/**
 * The grader's judgment of this conversation.
 *
 * **A type egma cannot execute yet answers `errored`, and deliberately not
 * `skipped`.** `skipped` means the check did not apply to this conversation, and
 * it leaves the score's denominator — which is right for a measure a chat
 * simulation could never produce, and wrong here: this check applies perfectly
 * well and egma did not make it. Saying so out loud is what keeps a project's
 * page from going green because a grader quietly judged nothing, which is the
 * exact false trust this product exists to kill. The row is replaced by a real
 * judgment the moment the type becomes executable, because a re-grade at the
 * same grader version replaces rather than doubles.
 */
export async function execute(
  execution: Execution,
): Promise<readonly Judgment[]> {
  const { type } = execution.judgment;
  // One cast, at the one place the roster is read. The key came off the
  // judgment itself, so the executor and the config it is handed are the same
  // type by construction — which is exactly the correlation a compiler cannot
  // follow through an indexed access.
  const executor = EXECUTORS[type] as ExecutorFor<GraderType> | undefined;

  if (executor === undefined) {
    return [
      {
        dimension: theOneCheck(type),
        verdict: "errored",
        score: 0,
        rationale: `egma does not execute ${type} graders yet, so this check was not made.`,
        citedSpanIds: [],
      },
    ];
  }

  return executor(execution);
}

export {
  theOneCheck,
  type Execution,
  type ExecutionOf,
  type ExecutorFor,
  type Judging,
  type Judgment,
} from "./contract.ts";
