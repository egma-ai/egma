import type {
  AuthContext,
  ExecutableGrader,
  LibraryEntry,
  Verdict,
} from "@egma/db";

import type { Conversation } from "../conversation.ts";
import type { AskableJudge } from "../judge/index.ts";

/**
 * What every grader is handed and what every one of them answers with.
 *
 * The contract lives on its own, apart from the roster that dispatches on it, so
 * that teaching egma to execute another library entry is adding a file that
 * imports this one — never editing the thing every other one also imports.
 */

/**
 * One judged assertion, as the grader that judged it decided — before egma
 * stamps whose it was and when.
 *
 * Nothing about how loudly it speaks is here, and there is nothing left to put
 * here: scoring is binary, so every assertion of every applicable `required`
 * grader has to pass and no judgment can be worth less than another. Whether a
 * grader can fail a test at all is `required` on the running copy, and an
 * executor that could see it would be an executor that could be tempted to
 * judge differently because of it.
 */
export type Judgment = {
  /**
   * Which 0-or-1 check inside the grader was judged, as its **key**: one
   * expected behavior's position, or one filled-in entry of the copy's config.
   *
   * **It is a key and never content**, and it must be stable across the
   * grader's versions — a hard constraint rather than a preference. The fold
   * counts one assertion once, keyed by the conversation, the grader and this
   * name, and prefers the latest grading of it. A name that changed when the
   * config changed would make a re-grade at a tightened bound a *second*
   * assertion, counted beside the first forever, with both of them speaking. So
   * nothing derived from what a person wrote may appear here.
   */
  readonly assertion: string;
  readonly verdict: Verdict;
  /** Between 0 and 1. A single check answers 1 or 0. */
  readonly score: number;
  /** One line saying why, in words somebody reading the record can use. */
  readonly rationale: string;
  /**
   * A **stable word a reader may branch on**, where there is one to say beyond
   * the rationale — `modality_unsupported` on a grader that cannot score this
   * conversation. Absent means the sentence is the whole of it.
   *
   * Separate from the rationale for the reason the dimension is separate from
   * the config: the rationale is prose, free to be reworded whenever it reads
   * badly, and a page that had to recognise a case by matching on that wording
   * would break the first time somebody improved a sentence.
   */
  readonly reason?: string | undefined;
  /** The spans this judgment is about, by their own ids. */
  readonly citedSpanIds: readonly string[];
};

/**
 * How a library entry that judges with a model reaches one. The selected
 * provider key is already closed inside this capability and cannot be reached
 * from an executor, verdict row, or log.
 */
export type Judging = {
  /** Null only for a code grader, which never calls it. */
  readonly judge: AskableJudge | null;
};

/**
 * What egma knows about *this* conversation besides its spans — what an entry
 * whose assertions come from the test needs in order to go and read them.
 *
 * It is a narrow window on purpose. An executor gets a way to reach the store
 * and the id of the simulation in front of it, and nothing about who owns the
 * grader or what it is called. A production trace resolves to no simulation,
 * which is the same fact as "there is no test here to have written any
 * behaviors down".
 */
export type Reading = {
  readonly auth: AuthContext;
  readonly simulationId: string | undefined;
};

/**
 * What a grader is handed, and all it is handed.
 *
 * Three things, and the first two are the two levels the redesign is made of:
 *
 * - **`definition`** — the library entry, **read through the copy's
 *   `library_id` at judging time and never copied down onto it.** The judge
 *   prompt a model is sent is this row's, so the words on the Library screen and
 *   the words in the request are one string. A definition written onto the copy
 *   would be a second string, and the day the two disagreed the screen would go
 *   on describing a judgment nobody was making.
 * - **`config`** — the copy's own filled-in values, frozen on the version that
 *   is judging.
 * - the conversation, a way to reach a judge, and the narrow reading window
 *   above.
 *
 * Not the grader's name, not whether it is required, not whose it is — an
 * executor that could see any of those could be written to answer with them.
 */
export type Execution = {
  readonly definition: LibraryEntry;
  readonly config: ExecutableGrader["config"];
  readonly conversation: Conversation;
  readonly judging: Judging;
  readonly reading: Reading;
};

/**
 * One library entry, executed. Asynchronous because a judged entry calls a model
 * and a computed one does not, and a seam that only fitted the computed ones
 * would have to be rebuilt for the first judge.
 */
export type Executor = (
  execution: Execution,
) => readonly Judgment[] | Promise<readonly Judgment[]>;

/**
 * Which assertions this grader would write about this conversation, by their
 * keys, in order — **asked when egma could not judge and has to say so.**
 *
 * It is a companion to `execute` rather than something the engine can work out,
 * and it exists because of what the fold does with a key. A verdict is counted
 * once per `[conversation, grader, assertion, source]`, and that identity does
 * *not* span the grader version — so the newest grading of a key supersedes the
 * older one, and a key nothing writes again is a row that speaks forever.
 *
 * An `errored` row filed under a key the executor never produces is therefore
 * permanent: `errored` outranks `passed` in the fold, and a re-grade writes the
 * real keys and cannot reach the orphan. The test could never pass again. So
 * every grader answers its own keys, and a failure writes one row per assertion
 * exactly as a successful judging does — which is also why a page shows the same
 * list of checks whether egma managed to make them or not.
 *
 * It may throw, and a throw is meant: if egma cannot even say what a grader
 * checks, it must write nothing about that grader rather than write a row it
 * can never correct. `judgmentsOf` lets that out, and the job is retried.
 */
export type AssertionKeys = (
  execution: Execution,
) => readonly string[] | Promise<readonly string[]>;

/** One library entry egma knows how to run: what it does, and what it names. */
export type GraderExecutor = {
  readonly execute: Executor;
  readonly assertions: AssertionKeys;
};

/**
 * What a grader that makes exactly one check names it: **the identifier of the
 * entry it is a copy of**, and deliberately not that entry's name.
 *
 * Stable for the entry's whole life, because a predefined entry keeps one
 * identifier across every upgrade while its name is ordinary text a release may
 * improve — the catalog says so out loud. A key taken from the name would split
 * every row written before a rename from every row written after it, with both
 * halves speaking forever, which is precisely what the key rules above exist to
 * prevent. Nothing a person wrote may appear here, and a name is something
 * somebody wrote.
 *
 * A grader that judges several things at once names each of them itself and
 * never comes here.
 */
export function theOneCheck(definition: LibraryEntry): string {
  return definition.id;
}
