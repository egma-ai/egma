import { PREDEFINED_GRADERS } from "../grader-library/catalog.ts";
import type { AuthContext } from "./context.ts";
import { graderFacts } from "./graders.ts";
import { getSimulationTestVersion } from "./runs.ts";

/**
 * Turning an assertion **key** back into the words somebody wrote.
 *
 * A verdict row files its assertion by key and never by content — a behavior's
 * position in the pinned test version, a config entry's index — because the fold
 * counts one assertion once per grader and prefers the latest grading of it, and
 * a key derived from what a person typed would make an edited sentence a
 * *second* assertion counted beside the first forever. The cost of that decision
 * is exactly this file: what a human reads has to be fetched, at display time,
 * from the versions the conversation was pinned to.
 *
 * **From the pinned version, never from the live test.** The whole point of a
 * key is that within one frozen version position 3 is the same sentence forever.
 * Resolving against the test as it now stands would put this morning's wording
 * on last night's judgment — the exact rewriting of history that pinning exists
 * to prevent, and worse than showing the bare key, because a plausible wrong
 * sentence is unfalsifiable where `behavior_3` is merely terse.
 *
 * **Keyed by the grader as well as the key**, because a key means whatever the
 * grader that wrote it says it means. `behavior_3` off an expected-behaviors
 * copy is the test's third sentence; the same characters off some other copy are
 * that copy's own business, and guessing across the two would put a test's
 * sentence on a judgment about something else entirely.
 *
 * **Nothing resolvable is invented.** A key this cannot place — a copy of an
 * entry with no words to look up, a position past the end of a version somebody
 * has since shortened, a conversation with no test at all — comes back absent,
 * and a reader shows the key. An absent answer is honest; a made-up one is not.
 */

/** What an assertion key stands for, for the conversation it was written about. */
export type AssertionWords = {
  /**
   * The sentence this grader's key stands for, or `undefined` where nothing here
   * can say — which a caller renders as the key itself.
   */
  readonly of: (graderId: string, assertion: string) => string | undefined;
};

/** Nothing to look up: every key stays a key. */
const NOTHING_TO_SAY: AssertionWords = { of: () => undefined };

/**
 * The words behind this conversation's assertion keys.
 *
 * Two reads and no more: the version the simulation was executed against, and
 * the copies that wrote the rows. Both are asked once for the whole
 * conversation, so a page showing twenty judgments costs the same as one showing
 * two.
 *
 * A production trace has no simulation and therefore no test, and a smoke
 * simulation started against no test has none either. Both come back with
 * nothing to say, which is the same answer for the same reason.
 *
 * @param simulationId The conversation, as the verdict rows file it.
 * @param graderIds The copies that wrote them — the row's own `graderId`s.
 */
export async function readAssertionWords(
  auth: AuthContext,
  simulationId: string,
  graderIds: readonly string[],
): Promise<AssertionWords> {
  if (graderIds.length === 0) return NOTHING_TO_SAY;

  // The pinned version, and nothing about the test as it now stands. It answers
  // `undefined` for a conversation that pinned none, and for one whose version
  // this credential cannot reach — in both cases there is nothing to read.
  const version = await getSimulationTestVersion(auth, simulationId);
  if (version === undefined) return NOTHING_TO_SAY;

  const behaviors = version.expectedBehaviors;
  const facts = await graderFacts(auth, graderIds);

  return {
    of: (graderId, assertion) => {
      const its = facts.get(graderId);
      if (its === undefined) return undefined;

      // One entry per predefined library entry whose keys mean something a
      // person can read. `latency`'s key is the index of a config entry the copy
      // itself holds, and what that reads as is the change that computes it from
      // spans — so it is absent here rather than guessed at, and a reader sees
      // the key exactly as it is written.
      if (its.libraryId !== PREDEFINED_GRADERS.expectedBehaviors) {
        return undefined;
      }
      return behaviors[behaviorAt(assertion) ?? -1];
    },
  };
}

/**
 * Which behavior a key is about, counting from nought — or nothing at all where
 * the key is not one of this grader's.
 *
 * The inverse of the one place the engine mints these, written here rather than
 * pattern-matched at the call site so that the two spellings of `behavior_3`
 * live one function apart. A key in any other shape is a key this cannot read,
 * which is a fact to report rather than a case to be clever about.
 */
function behaviorAt(assertion: string): number | undefined {
  const digits = /^behavior_(\d+)$/u.exec(assertion)?.[1];
  if (digits === undefined) return undefined;

  const position = Number(digits);
  // One-based on the wire, so position 1 is the first sentence. A nought or a
  // number the parse could not hold is a key nothing wrote.
  return Number.isSafeInteger(position) && position > 0
    ? position - 1
    : undefined;
}
