import { worstSampleOf, type MeasuredFromSpans } from "@egma/db";

import type { Execution, Judgment } from "./contract.ts";

/**
 * The latency grader: a measure off the conversation's spans, against a bound
 * somebody typed.
 *
 * **Computed, and there is no model anywhere in this file.** It is the `code`
 * half of the shelf: egma's own engine reads the numbers the shared measure
 * module worked out and compares each with the bound its copy holds. Nothing
 * here resolves a judge, so a project whose only running graders are computed
 * never unseals its judge key at all — which is a property of the shape rather
 * than of this file behaving well.
 *
 * **Its assertions are its config entries, one each.** A copy holds one filled-in
 * set per assertion — `{ metric, bound }` — checked at Use time against the
 * entry's `params`, so what arrives here has a measure egma computes and a
 * number. Each entry is one 0-or-1 check and one verdict row.
 *
 * **The assertion key is the entry's index, never what it names.** A key derived
 * from the measure or the bound would make a re-grade at a tightened bound a
 * *second* assertion, counted beside the first forever with both of them
 * speaking. The position is stable across the copy's versions, which is exactly
 * what the fold's key needs, and the values a row was decided by are readable
 * from the frozen version the row names.
 *
 * **The worst measurement decides.** A bound is "the most this measure may be",
 * so a conversation holds it only if every measurement held it. A mean would
 * hide the one turn that took nine seconds, which is the turn the caller hung
 * up on. The eight aggregations the measure catalog names are what this becomes
 * the day the form grows a third control; until it does, the reduction is the
 * strictest one rather than a default somebody could mistake for a choice they
 * made — and the rationale says which measurement decided, so nobody has to
 * guess.
 *
 * ## What it says when it cannot say anything
 *
 * - **The conversation's spans do not carry the measure.** `skipped`, out of
 *   the score's denominator, never `failed` and never `errored`. A chat
 *   simulation has no audio and therefore no `time_to_first_word`; a production
 *   trace from an agent that emits no timing spans has none of them. The check
 *   did not apply, and marking an agent down for a measurement nobody took is
 *   the false signal this product exists to kill.
 * - **There was no conversation.** One `errored` row per assertion, in the
 *   conversation's own words — the simulator reported it never ran, or its
 *   spans never arrived. Both went wrong on egma's side of the glass, so the
 *   list a page shows is the same list whether the conversation happened or not.
 * - **The copy holds no assertions.** No rows. It cannot happen — the write
 *   door refuses a latency copy with none, because a copy that checks nothing
 *   can never fail — and answering nothing is the honest reply to a row that
 *   somehow has none.
 */

/** What one filled-in entry of the copy's config says, once read off it. */
type Bounded = {
  readonly metric: string;
  readonly bound: number;
};

/**
 * The keys this grader files its rows under, whether or not it manages to check
 * anything — one per config entry, in the order they were filled in.
 *
 * **The engine asks for these when something threw**, so a conversation whose
 * span read broke gets one `errored` row per assertion rather than a single row
 * under a key nothing writes again. That is the difference between a transient
 * failure a re-grade can clear and one that fails the test forever: the fold
 * counts a verdict once per conversation, grader and key without regard to the
 * grader version, so an orphan key is a row no later judging can supersede and
 * `errored` outranks every `passed` beside it. `contract.ts` argues it out.
 *
 * It reads the copy's own frozen config and nothing else, so it cannot fail for
 * the reasons `execute` can — which is the point: the path that says "egma could
 * not check this" must not be the path that breaks.
 */
export function latencyAssertions(execution: Execution): readonly string[] {
  return execution.config.assertions.map((_, at) => assertionKey(at));
}

export function executeLatency(execution: Execution): readonly Judgment[] {
  const entries = execution.config.assertions;

  // The same sentence every other grader answers with, read off the
  // conversation rather than written a second time here: two copies of it are
  // two things a reader could be told about one conversation.
  const nothingToJudge = execution.conversation.nothingToJudgeBecause;
  if (nothingToJudge !== null) {
    return entries.map((_, at) => couldNotCheck(at, nothingToJudge));
  }

  return entries.map((entry, at) => {
    const asked = boundIn(entry);
    if (asked === undefined) {
      // Unreachable through the write door, which checks every value against
      // the entry's declared parameters. Answered rather than thrown, because a
      // grading service is not the place to fall over a row that came out of
      // its own database — and `errored` rather than `failed`, because egma
      // could not make the check and the agent did nothing.
      return couldNotCheck(
        at,
        "this check holds no measure and bound egma can read, so it was not made.",
      );
    }

    const measured = execution.conversation.measures.find(
      (candidate) => candidate.measure === asked.metric,
    );
    const worst = measured === undefined ? undefined : worstSampleOf(measured);
    if (measured === undefined || worst === undefined) {
      return {
        assertion: assertionKey(at),
        // Not applicable rather than not passed. It leaves the score's
        // denominator, so a chat conversation is never marked down for having
        // no audio and a production trace is never marked down for telemetry
        // its agent does not emit.
        verdict: "skipped",
        score: 0,
        // Said in the words a person reads a verdict in — a rationale lands on
        // a page, so it names what was measured rather than where egma keeps
        // the measurement.
        rationale: `nothing in this conversation measured ${asked.metric}, so there was nothing to check against ${asked.bound}.`,
        citedSpanIds: [],
      };
    }

    const held = worst.value <= asked.bound;
    return {
      assertion: assertionKey(at),
      verdict: held ? "passed" : "failed",
      score: held ? 1 : 0,
      rationale: rationaleFor(asked, measured, worst.value, held),
      // Where the deciding measurement happened, by its own id — which is what
      // the verdict row's column is for, and what lets a reader open the one
      // measurement this judgment is about. A sample carries its span with it,
      // so there is no index to line up and no absent id to guard against.
      citedSpanIds: [worst.spanId],
    };
  });
}

/**
 * What each verdict row files this check under: the entry's position, one-based.
 *
 * Written as a function rather than as a template at each site, so the string a
 * row is filed under is decided in one place — and named for the domain word,
 * because a config entry *is* one assertion.
 */
function assertionKey(at: number): string {
  return `assertion_${at + 1}`;
}

/**
 * One config entry as this grader reads it, or nothing where the row does not
 * hold what the entry's form asks for.
 *
 * A stored config is checked on the way in and shape-guarded on the way out, so
 * the values are already a string and a number; this is the last narrowing, and
 * it answers rather than asserts for the reason every read in a grading service
 * does.
 */
function boundIn(entry: Readonly<Record<string, string | number>>): Bounded | undefined {
  const metric = entry["metric"];
  const bound = entry["bound"];
  if (typeof metric !== "string" || metric === "") return undefined;
  if (typeof bound !== "number" || !Number.isFinite(bound)) return undefined;
  return { metric, bound };
}

/**
 * Why, in words somebody reading the record can use: the measure, what it came
 * to at its worst, the unit it is counted in, and the bound it was held to.
 *
 * It says **how many measurements there were** when there was more than one,
 * because "the worst of eleven turns was 2.4 seconds" and "the one turn took 2.4
 * seconds" are different things to go and look at, and a rationale that hid the
 * difference would leave a developer opening the wrong transcript.
 */
function rationaleFor(
  asked: Bounded,
  measured: MeasuredFromSpans,
  worst: number,
  held: boolean,
): string {
  const taken =
    measured.samples.length === 1
      ? `was ${worst} ${measured.unit}`
      : `was ${worst} ${measured.unit} at its worst, across ${measured.samples.length} measurements`;
  return held
    ? `${asked.metric} ${taken}, within the bound of ${asked.bound}.`
    : `${asked.metric} ${taken}, over the bound of ${asked.bound}.`;
}

/** egma could not make this check. Never `failed`: nothing is said about the agent. */
function couldNotCheck(at: number, rationale: string): Judgment {
  return {
    assertion: assertionKey(at),
    verdict: "errored",
    score: 0,
    rationale,
    citedSpanIds: [],
  };
}
