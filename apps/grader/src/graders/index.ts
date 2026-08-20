import { PREDEFINED_GRADERS } from "@egma/db";

import {
  theOneCheck,
  type Execution,
  type Executor,
  type GraderExecutor,
  type Judgment,
} from "./contract.ts";
import {
  executeExpectedBehaviors,
  expectedBehaviorAssertions,
} from "./expected-behaviors.ts";
import { executeLatency, latencyAssertions } from "./latency.ts";

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
 * **Complete for the two entries v0 ships, and deliberately not total.** An
 * entry with no executor here is one egma has not built yet, and a copy of it
 * answers `errored`, out loud, rather than passing — which is the arm a third
 * entry arrives through, and the arm `latency` sat in while the shelf had it and
 * the engine did not.
 *
 * That arm names the grader's **one** check, because an entry egma cannot run is
 * an entry that cannot say what it would have checked. Everything with an
 * executor names its own keys, so the rows a failure writes are the rows a later
 * judging writes over — see `couldNotJudge`, which is where that matters.
 */
const EXECUTORS: Readonly<Record<string, GraderExecutor | undefined>> = {
  [PREDEFINED_GRADERS.expectedBehaviors]: {
    execute: executeExpectedBehaviors,
    assertions: expectedBehaviorAssertions,
  },
  // Computed from the conversation's spans by the one shared measure module —
  // the same module the metrics display reads through — with no model call
  // anywhere on this path. Its keys are the copy's config entries by position,
  // which is what makes an `errored` latency row re-gradable: the keys a
  // failure writes are exactly the keys a later judging writes over.
  [PREDEFINED_GRADERS.latency]: {
    execute: executeLatency,
    assertions: latencyAssertions,
  },
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
  const executor = EXECUTORS[execution.definition.libraryId];

  if (executor === undefined) {
    const nothingToJudge = execution.conversation.nothingToJudgeBecause;
    return couldNotJudge(
      execution,
      nothingToJudge ??
        `Egma does not execute Library grader ${execution.definition.libraryId} yet, so this check was not made.`,
    );
  }

  return executor.execute(execution);
}

/**
 * What a grader says when egma could not make its checks at all: one `errored`
 * row per assertion it would have written, with the same reason on each.
 *
 * **One row per assertion, and never one row for the grader.** The fold counts a
 * verdict once per conversation, grader and assertion key, and prefers the
 * latest grading of that key — so a row filed under a key the executor never
 * produces can never be superseded. It would sit beside the real rows forever,
 * `errored` outranking every `passed` beside it, and no re-grade could reach it.
 * A grader that failed today and passes tomorrow has to be able to say so.
 *
 * A grader egma cannot execute at all names its one check, which is what the
 * branch above writes too — so those rows are re-writable on exactly the same
 * terms the moment its executor arrives.
 *
 * **Asking for the keys may throw, and that is left to escape.** If egma cannot
 * say what a grader checks, it must write nothing about that grader rather than
 * a row it can never correct; the caller lets the job be retried instead.
 */
export async function couldNotJudge(
  execution: Execution,
  rationale: string,
): Promise<readonly Judgment[]> {
  const executor = EXECUTORS[execution.definition.libraryId];
  const keys =
    executor === undefined
      ? [theOneCheck(execution.definition)]
      : await executor.assertions(execution);

  return keys.map((assertion) => ({
    assertion,
    verdict: "errored" as const,
    score: 0,
    rationale,
    citedSpanIds: [],
  }));
}

export {
  theOneCheck,
  type AssertionKeys,
  type Execution,
  type Executor,
  type GraderExecutor,
  type Judging,
  type Judgment,
  type Reading,
} from "./contract.ts";
