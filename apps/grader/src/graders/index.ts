import { PREDEFINED_GRADERS } from "@egma/db";

import {
  theOneCheck,
  type Execution,
  type Executor,
  type Judgment,
} from "./contract.ts";
import { executeExpectedBehaviors } from "./expected-behaviors.ts";
import { executeLatency } from "./latency.ts";

/**
 * The executor seam: one library entry, one function, and nothing else in the
 * engine knows how any of them work.
 *
 * **Keyed by the entry's own identifier, and that is what the fixed identifiers
 * in the catalog are for.** A grader's *type* says how it is executed in
 * general — asked of a model, or computed by egma — but not what it asks or
 * what it computes: `expected_behaviors` reads its assertions off the test in
 * front of it, and `latency` reads its own config against a conversation's
 * spans. Both are `llm_as_judge` and `code` respectively, and a roster keyed by
 * those two words could hold exactly two entries forever. Keyed by identifier it
 * holds as many as egma ships, each named by the row a copy actually points at.
 *
 * **Not total, deliberately, and the gap is answered rather than silent.** An
 * entry with no executor here is one egma has not built yet, and a copy of it
 * answers `errored`, out loud, rather than passing. The roster is complete for
 * the two entries v0 ships and the arm below is what the next one lands
 * through; a row written while an entry waited is replaced by a real judgment
 * the moment its executor arrives, because a re-grade at the same grader version
 * replaces rather than doubles.
 */
const EXECUTORS: Readonly<Record<string, Executor | undefined>> = {
  [PREDEFINED_GRADERS.expectedBehaviors]: executeExpectedBehaviors,
  // Computed from the conversation's spans by the one shared measure module —
  // the same module the metrics display reads through — with no model call
  // anywhere on this path.
  [PREDEFINED_GRADERS.latency]: executeLatency,
};

/**
 * The grader's judgment of this conversation.
 *
 * **An entry egma cannot execute yet answers `errored`, and deliberately not
 * `skipped`.** `skipped` means the check did not apply to this conversation, and
 * it leaves the score's denominator — which is right for a measure a chat
 * simulation could never produce, and wrong here: this check applies perfectly
 * well and egma did not make it. Saying so out loud is what keeps a project's
 * page from going green because a grader quietly judged nothing, which is the
 * exact false trust this product exists to kill.
 *
 * **A conversation with nothing to judge is `errored` too, and the executor
 * decides its shape rather than this function.** Either the conversation never
 * happened — the agent never joined, the line was never answered, egma's own
 * runtime broke — or it happened and egma cannot read it. Both are things that
 * went wrong on egma's side of the glass, and the one thing a test product must
 * never do is score them as the agent behaving badly. It is left to the executor
 * because how many rows that is depends on what the grader's assertions are: the
 * expected-behaviors grader writes one per behavior, so a page shows the same
 * list whether the conversation happened or not. Every executor is held to it by
 * `nothingToJudgeBecause` on the conversation it is handed, and by a test.
 */
export async function execute(
  execution: Execution,
): Promise<readonly Judgment[]> {
  const executor = EXECUTORS[execution.definition.id];

  if (executor === undefined) {
    const nothingToJudge = execution.conversation.nothingToJudgeBecause;
    return [
      {
        assertion: theOneCheck(execution.definition),
        verdict: "errored",
        score: 0,
        rationale:
          nothingToJudge ??
          `egma does not execute the ${execution.definition.name} grader yet, so this check was not made.`,
        citedSpanIds: [],
      },
    ];
  }

  return executor(execution);
}

export {
  theOneCheck,
  type Execution,
  type Executor,
  type Judging,
  type Judgment,
  type Reading,
} from "./contract.ts";
