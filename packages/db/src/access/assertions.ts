import { behaviorAssertionAt } from "../grader-library/assertion-keys.ts";
import { PREDEFINED_GRADERS } from "../grader-library/catalog.ts";
import type { AuthContext } from "./context.ts";
import { getGraderLibraryEntry } from "./grader-library.ts";
import { graderFacts } from "./graders.ts";
import { getSimulationTestVersion } from "./runs.ts";

/**
 * Turning an assertion **key** back into the words somebody wrote.
 *
 * A verdict row files its assertion by key and never by what a person typed,
 * because the fold counts one assertion once per grader and prefers the latest
 * grading of it — so a key that moved when somebody edited a sentence or
 * tightened a bound would make the edit a *second* assertion, counted beside the
 * first forever. The cost of that decision is exactly this file: what a human
 * reads has to be fetched, at display time, from the versions the conversation
 * was pinned to.
 *
 * **Each grader picks the key its own list can keep, and they differ.** An
 * expected-behaviors key is a behavior's **position** in the pinned test
 * version, which is stable because a simulation is pinned to that version and
 * the list cannot change beneath it. A latency key is the **measure** the check
 * bounds, because a copy's config is pinned by nothing: removing one entry makes
 * the next one first, so a position there would name a different check after an
 * edit. That difference is why this resolves per grader rather than per key
 * shape — and why a latency key needs no resolution at all, being already the
 * name of the thing it is about.
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
 * What several conversations judged by the same copies share, read once.
 *
 * **Everything except the pinned version is a fact about the graders, not about
 * the conversation.** Which entry a copy points at cannot be edited at all, and
 * what that entry is called is one row on the shelf — so a run of two hundred
 * conversations judged by two copies has two grader rows and one or two library
 * rows behind the whole page, and reading them per conversation would be two
 * hundred copies of one answer.
 *
 * The version each conversation pinned is the one thing that genuinely varies,
 * and it stays where it has to be: behind `forSimulation`, asked once per
 * conversation.
 */
export type AssertionShelf = {
  /** The words for one conversation, from the version that conversation pinned. */
  readonly forSimulation: (simulationId: string) => Promise<AssertionWords>;
};

/**
 * The shelf for a whole run: the grader facts and the entry names behind these
 * copies, read once, ready to resolve any conversation they judged.
 *
 * @param graderIds Every copy that wrote a row anywhere in the run.
 */
export async function readAssertionShelf(
  auth: AuthContext,
  graderIds: readonly string[],
): Promise<AssertionShelf> {
  if (graderIds.length === 0) return NOTHING_FOR_ANYBODY;

  const facts = await graderFacts(auth, graderIds);
  if (facts.size === 0) return NOTHING_FOR_ANYBODY;

  // The entries behind those copies, by their own ids — the same read the engine
  // makes through the same pointer, so what a page calls a grader and what
  // judged the conversation are one row.
  const named = new Map(
    await Promise.all(
      [...new Set([...facts.values()].map((its) => its.libraryId))].map(
        async (libraryId) =>
          [libraryId, (await getGraderLibraryEntry(auth, libraryId))?.name] as const,
      ),
    ),
  );

  return {
    forSimulation: async (simulationId) => {
      // The pinned version, and nothing about the test as it now stands. It
      // answers `undefined` for a conversation that pinned none, and for one
      // whose version this credential cannot reach — in both cases there are no
      // behaviors to read, which is not the same as having nothing at all to
      // say: a whole-grader key still resolves, because what it names is the
      // shelf rather than the test.
      const version = await getSimulationTestVersion(auth, simulationId);
      const behaviors = version?.expectedBehaviors ?? [];

      return {
        of: (graderId, assertion) => {
          const its = facts.get(graderId);
          if (its === undefined) return undefined;

          // **A whole-grader key is the entry's own identifier**, which is what
          // a grader that makes exactly one assertion names it — fixed for the
          // entry's life, precisely so that no catalog rename can rekey a
          // verdict. The words for it are that entry's name, read here rather
          // than written into the row for the same reason every other key is a
          // key.
          if (assertion === its.libraryId) return named.get(its.libraryId);

          // Behaviors are the one key shape that means a sentence in a test, and
          // it is the expected-behaviors entry that mints them. Any other
          // entry's keys are its own business — absent here rather than guessed
          // at, so a reader sees the key exactly as it is written.
          //
          // A latency key needs nothing from this and gets nothing: it is the
          // measure the check bounds, which is already the name of what the
          // judgment is about, and a reader shows it as written.
          if (its.libraryId !== PREDEFINED_GRADERS.expectedBehaviors) {
            return undefined;
          }
          return behaviors[behaviorAssertionAt(assertion) ?? -1];
        },
      };
    },
  };
}

/** A shelf with nothing on it: every conversation resolves every key to itself. */
const NOTHING_FOR_ANYBODY: AssertionShelf = {
  forSimulation: async () => NOTHING_TO_SAY,
};

/**
 * The words behind one conversation's assertion keys.
 *
 * The single-conversation door onto the shelf above, for the surface that shows
 * one transcript and has no run to amortise anything over. A page reading many
 * conversations builds the shelf itself and asks it once per conversation.
 *
 * @param simulationId The conversation, as the verdict rows file it.
 * @param graderIds The copies that wrote them — the row's own `graderId`s.
 */
export async function readAssertionWords(
  auth: AuthContext,
  simulationId: string,
  graderIds: readonly string[],
): Promise<AssertionWords> {
  return (await readAssertionShelf(auth, graderIds)).forSimulation(simulationId);
}
