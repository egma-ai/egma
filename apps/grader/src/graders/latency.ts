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
 * **The assertion key is the measure the entry bounds** — not its position, and
 * not the bound. `assertionKey` below argues the whole of it out: a copy's
 * config is not pinned by a run, so a position names a different check after an
 * edit, while a bound in the key would make a re-grade at a tightened bound a
 * second assertion counted beside the first forever. The measure survives both,
 * and the write door keeps it unique inside a copy so that it is an identity.
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
  return execution.config.assertions.map(keyOf);
}

export function executeLatency(execution: Execution): readonly Judgment[] {
  const entries = execution.config.assertions;

  // The same sentence every other grader answers with, read off the
  // conversation rather than written a second time here: two copies of it are
  // two things a reader could be told about one conversation.
  const nothingToJudge = execution.conversation.nothingToJudgeBecause;
  if (nothingToJudge !== null) {
    return entries.map((entry, at) => couldNotCheck(keyOf(entry, at), nothingToJudge));
  }

  return entries.map((entry, at) => {
    const key = keyOf(entry, at);
    const asked = boundIn(entry);
    if (asked === undefined) {
      // Unreachable through the write door, which checks every value against
      // the entry's declared parameters. Answered rather than thrown, because a
      // grading service is not the place to fall over a row that came out of
      // its own database — and `errored` rather than `failed`, because egma
      // could not make the check and the agent did nothing.
      return couldNotCheck(
        key,
        "this check holds no measure and bound Egma can read, so it was not made.",
      );
    }

    const measured = execution.conversation.measures.find(
      (candidate) => candidate.measure === asked.metric,
    );
    const worst = measured === undefined ? undefined : worstSampleOf(measured);
    if (measured === undefined || worst === undefined) {
      return {
        assertion: key,
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
      assertion: key,
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
 * One config entry's key, decided in **one** place so that `execute` and
 * `assertions` cannot answer differently.
 *
 * The two are asked at different moments — one when egma judged, one when egma
 * could not — and a row filed under a key the other never produces is a row no
 * re-grade can reach. Sharing this function is what makes them the same list
 * rather than two lists that agree today.
 *
 * The position survives as a last resort, for an entry holding values egma
 * cannot read. It cannot arrive through the write door, and a key is needed
 * anyway; the position is the only thing such an entry has.
 */
function keyOf(
  entry: Readonly<Record<string, string | number>>,
  at: number,
): string {
  const asked = boundIn(entry);
  return asked === undefined ? `assertion_${at + 1}` : assertionKey(asked);
}

/**
 * What each verdict row files this check under: **the measure it bounds.**
 *
 * ## Why not the entry's position, which is what this used to be
 *
 * A copy's config is **not pinned by a run**. Judging reads the grader through
 * `grader.current_version_id` every time — `applicableGraders` → `listGraders`,
 * and the same on a re-grade — so a conversation judged last week and re-judged
 * today is judged by *today's* config, at a new version, writing rows beside the
 * old ones. Meanwhile the fold counts one assertion once per
 * `[trace, grader, assertion, source]` and deliberately **not** per version,
 * because that is what makes a re-grade supersede rather than double.
 *
 * Put those two together and a position is not an identity. A copy holding
 * `[turn_response_latency, first_response_latency]`, edited to drop the first,
 * re-grades to a config whose *first* entry is `first_response_latency` — so the
 * key `assertion_1` named one measure on Monday and a different one on Tuesday,
 * and Tuesday's row silently replaced Monday's. A verdict about one measure
 * overwritten by a verdict about another is not a stale answer; it is a wrong
 * one, filed under a name that says it is about something else.
 *
 * ## Why the measure is an identity where a position is not
 *
 * `contract.ts` says an assertion key is never content, and the reason it gives
 * is precise: a key that moved when the config moved would make a re-grade at a
 * **tightened bound** a second assertion, counted beside the first forever. The
 * measure survives exactly that — tightening 2000 to 500 leaves
 * `turn_response_latency` alone — while the position does not survive an edit
 * the rule never contemplated. So this honours the rule's reason where the
 * position honoured only its letter.
 *
 * And a measure is not really "what a person wrote": it is one of a closed list
 * egma owns, refused at the write door if it is anything else. What a person
 * wrote is the bound, and the bound is deliberately not in here.
 *
 * **It is unique within a copy because the write door makes it so** — a second
 * entry bounding a measure the copy already bounds is refused, and it has to be:
 * two entries sharing a key would share a row in the verdict store's sorting key
 * as well, and one of the two checks would vanish inside a single grading.
 *
 * ## Why `expected_behaviors` still keys by position, and is right to
 *
 * Its assertions live on the **test version**, and a simulation *is* pinned to
 * the test version it was executed against. Position is stable there because the
 * list it indexes into cannot change under that conversation. The latency
 * grader's list can, which is the whole difference.
 *
 * ## What this does not fix, and cannot
 *
 * Removing an entry still leaves its old verdict in the store with nothing to
 * supersede it, and no keying scheme changes that: the row exists, the fold
 * ignores the version, and nothing writes that key again. It is the same shape
 * as a **deleted grader**, whose rows keep speaking by an explicit product
 * decision — "what it already said stays readable" (`resolve.ts`). A test pins
 * this behaviour so it stays a decision rather than a surprise.
 */
function assertionKey(entry: Bounded): string {
  return entry.metric;
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
function couldNotCheck(assertion: string, rationale: string): Judgment {
  return {
    assertion,
    verdict: "errored",
    score: 0,
    rationale,
    citedSpanIds: [],
  };
}
