import type {
  AuthContext,
  Grader,
  LibraryEntry,
  Verdict,
} from "@egma/db";

import type { Conversation } from "../conversation.ts";
import type { JudgeMakers, JudgeResolution } from "../judge/index.ts";

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
  /** The spans this judgment is about, by their own ids. */
  readonly citedSpanIds: readonly string[];
};

/**
 * How a library entry that judges with a model reaches one.
 *
 * **A capability rather than a fact about the grader.** It is handed to every
 * executor, including the ones egma computes, and those simply never call it —
 * resolving a judge is what unseals a project's key, so a conversation whose
 * graders are all computed never opens the envelope however many of them were
 * handed this. That is what keeps "asked for only if something judges" a
 * property of the shape rather than of the roster.
 *
 * **The key is deliberately absent, and cannot be reached from here.** What
 * `judging` answers with is a way to ask and a `provider/model` name to record,
 * so no executor — today's or tomorrow's — can put a secret in a rationale, a
 * verdict row or a log line.
 */
export type Judging = {
  /**
   * The project's judge, resolved at most once per conversation and shared by
   * everything on it that judges — so five judged checks cost one read of the
   * configuration rather than five, and all of them speak with one account.
   */
  readonly judge: JudgeResolution;
  /** How each provider is spoken to. A test hands over a scripted one. */
  readonly makers: JudgeMakers;
  /**
   * This grader version's own judge, or `null` for the project's default.
   *
   * The override is judged content: it lives on the immutable version beside the
   * config, so a verdict written under it stays readable as "decided by this
   * model" long after the project's default moved on. It names a provider and a
   * model and never a key, so a grader cannot move a project's judging onto an
   * account nobody configured.
   */
  readonly model: JudgeModelOverride;
};

/** What a version may insist on: a provider and a model, or the project's. */
type JudgeModelOverride = Grader["judgeModel"];

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
  readonly config: Grader["config"];
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
 * What a grader that makes exactly one check names it: the entry it is a copy
 * of.
 *
 * Stable across every version of the copy, because a copy's pointer is set at
 * Use time and can never be edited — which is precisely the property the fold's
 * key needs, and the reason nothing from the config is allowed near it. A grader
 * that judges several things at once names each of them itself and never comes
 * here.
 */
export function theOneCheck(definition: LibraryEntry): string {
  return definition.name;
}
