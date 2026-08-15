import {
  MEASURE_CATALOG,
  type CatalogedMeasure,
} from "@egma/simulation-contract";

import type { TraceSpan } from "../access/traces.ts";

/**
 * The shared measure module: a conversation's spans in, the measure catalog's
 * numbers out.
 *
 * **One computation, and that is the whole reason this file exists.** The
 * metrics display reads through it and so does the grader that bounds a
 * measure, for a simulation and for a production trace alike. So the number a
 * developer sees on a page and the number a verdict row was decided by are the
 * same arithmetic over the same rows — not two readers that agree today and
 * drift the week somebody fixes one of them. A second implementation anywhere
 * would be a second answer about one conversation, with no stored number to
 * settle the disagreement against, which is precisely the false trust this
 * product exists to kill.
 *
 * **The source is not an input, and cannot become one.** What goes in is spans;
 * what comes out is what those spans carry. A simulation's telemetry and a real
 * caller's arrive at the same OTLP door and land in the same table, so
 * "identical spans, identical numbers" is a property of this function's
 * signature rather than a promise somebody has to keep — there is nowhere here
 * for `source` to be read even by a caller who wanted to.
 *
 * **The catalog decides what is computed and how.** Every measure carries its
 * span-level definition beside its name
 * (`packages/simulation-contract/measure-catalog.md`), the rule is one of a
 * closed list, and the switch below is exhaustive — so a measure whose rule
 * nothing implements stops the TypeScript build rather than shipping as a
 * grader that is silently `skipped` forever.
 *
 * It reaches nothing: rows a caller already fetched go in, arithmetic comes
 * out. So it takes no `AuthContext` and is exported from the package's entry
 * point rather than from the data-access surface, exactly as the verdict fold
 * is, and for the same reason.
 */

/**
 * The part of a trace this reads: its spans, however they were arranged for a
 * transcript.
 *
 * Structural rather than `TraceDetail` itself, so a caller holding a trace hands
 * it straight over and a test can hand over the two lists — and so that adding a
 * fact to a trace read is not a change to this arithmetic. A trace read hands
 * back the turns lifted out for the transcript and everything filed beside them,
 * with children hanging beneath both; every span is under one of the two, once.
 */
export type SpannedConversation = {
  readonly turns: readonly TraceSpan[];
  readonly spans: readonly TraceSpan[];
};

/**
 * One measurement, and where it happened.
 *
 * The number and its span travel together rather than in two lists a caller
 * indexes into in step. Two aligned arrays would put the alignment in every
 * reader's hands — and the first thing an index type says about `spanIds[at]`
 * is that it might not be there, which is a sentinel nobody wants and a
 * question this shape cannot be asked.
 */
export type Sample = {
  readonly value: number;
  readonly spanId: string;
};

/** One measure, as this conversation's spans carried it. */
export type MeasuredFromSpans = {
  readonly measure: string;
  /** The catalog's own unit, so nothing downstream has to look it up again. */
  readonly unit: CatalogedMeasure["unit"];
  /**
   * One measurement, or the whole series for a measure taken once a turn, in
   * the order they were taken.
   *
   * Never empty: a measure this conversation did not take is **absent** from
   * the answer rather than present with nothing in it. That is what lets a
   * grader tell "measured, and here it is" from "not measured here", and the
   * second of those is a `skipped` check rather than a failed one.
   */
  readonly samples: readonly Sample[];
};

/**
 * The kind the ingest door files a timing span under.
 *
 * Selecting on the **kind as well as the name** is deliberate. The door
 * recognises egma's vocabulary by the emitting scope and files those spans as
 * `timing`; a provider's own span that happens to be called
 * `turn_response_latency` is filed as whatever it is. Reading the name alone
 * would let another framework's bookkeeping become a measurement egma judges an
 * agent against.
 */
const TIMING = "timing";

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * Every measure this conversation's spans carry, in the catalog's own order.
 *
 * **Catalog order rather than the order they were measured in**, so a display
 * lists the same measures in the same places for every conversation, and two
 * readings of one trace are the same answer however the flushes arrived. The
 * *samples* inside a measure are in the order they were taken, which is the
 * order that means something: a per-turn series read forwards is the
 * conversation read forwards.
 */
export function measuresFromSpans(
  conversation: SpannedConversation,
): readonly MeasuredFromSpans[] {
  const timed = timingSpansByName(conversation);

  const measured: MeasuredFromSpans[] = [];
  for (const cataloged of MEASURE_CATALOG) {
    const found = samplesOf(cataloged, timed);
    if (found.length === 0) continue;
    measured.push({
      measure: cataloged.measure,
      unit: cataloged.unit,
      samples: found,
    });
  }
  return measured;
}

/**
 * The worst sample a measure produced, and the span it happened in.
 *
 * **The worst rather than the mean, and the reason is the catalog's own**: a
 * mean hides the one turn that took nine seconds, which is the turn the caller
 * hung up on. A bound is "the most this measure may be", so a conversation
 * holds it only if every measurement held it — one bad turn out of twenty is a
 * conversation that was bad once, and a check that says otherwise is a check
 * nobody should believe.
 *
 * The eight aggregations the catalog names are what this becomes when a grader
 * can ask for one. Nothing asks today: the **Use** form has a measure and a
 * bound and no third control, so the reduction is the strictest one rather than
 * a default somebody could mistake for a choice they made.
 *
 * Ties keep the earliest sample, so two readings of one trace cite one span.
 *
 * `undefined` for a measure with no samples, which nothing this module builds
 * ever has — a measure with none is absent instead. It is answered rather than
 * assumed because the alternative is a fallback number, and a fallback number
 * here is a bound quietly passed by a conversation nobody measured.
 */
export function worstSampleOf(measured: MeasuredFromSpans): Sample | undefined {
  let worst: Sample | undefined;
  for (const sample of measured.samples) {
    if (worst === undefined || sample.value > worst.value) worst = sample;
  }
  return worst;
}

/**
 * The timing spans this conversation holds, grouped by the measure they are
 * named for and ordered by when each was taken.
 *
 * Done once per reading rather than once per measure: a conversation with five
 * measures on it is one walk of the tree, not five.
 */
function timingSpansByName(
  conversation: SpannedConversation,
): ReadonlyMap<string, readonly Sample[]> {
  const taken: (Sample & { readonly measure: string; readonly at: string })[] =
    [];

  for (const span of everySpanIn(conversation)) {
    if (span.kind !== TIMING) continue;
    taken.push({
      // A timing span is named for the measure it takes, which is what makes
      // the catalog and the span vocabulary the same list read twice.
      measure: span.name,
      at: span.startedAt,
      // The span's own duration **is** the measurement. Nothing carries the
      // number a second time — a second copy would be free to disagree with the
      // interval — so this conversion is the only place nanoseconds become
      // milliseconds. Floating point on purpose: a measure is `862.5ms` and a
      // whole-number division would quietly floor every one of them, and the
      // counts involved are tens of seconds, nowhere near where a double stops
      // holding a nanosecond exactly.
      value: Number(span.durationNanoseconds) / NANOSECONDS_PER_MILLISECOND,
      spanId: span.spanId,
    });
  }

  const byName = new Map<string, Sample[]>();
  for (const sample of taken.sort(byWhenItStarted)) {
    const held = byName.get(sample.measure);
    if (held === undefined) {
      byName.set(sample.measure, [{ value: sample.value, spanId: sample.spanId }]);
    } else {
      held.push({ value: sample.value, spanId: sample.spanId });
    }
  }
  return byName;
}

/**
 * One measure's samples, by the rule the catalog pins beside its name.
 *
 * The switch is exhaustive over the closed list of rules, so a rule added to
 * the catalog with nothing here to answer it stops the build — which is the
 * mechanism that keeps the form's dropdown, the write door and this arithmetic
 * from ever being three different lists.
 */
function samplesOf(
  cataloged: CatalogedMeasure,
  timed: ReadonlyMap<string, readonly Sample[]>,
): readonly Sample[] {
  switch (cataloged.fromSpans.rule) {
    case "timing_spans_named_for_it": {
      return timed.get(cataloged.measure) ?? [];
    }
    case "no_span_carries_it": {
      // Nothing, always. The number is real and arrives elsewhere — the
      // terminal transition, where the simulation row keeps it — and deriving
      // it here a second way would be a second answer about one conversation.
      // A grader may not name such a measure at all; the write door refuses it,
      // so this arm is what a display asks and never what a verdict rests on.
      return [];
    }
  }
}

/**
 * Every span the conversation holds, exactly once: the turns, whatever hangs
 * inside them, and everything filed beside them.
 *
 * Which list a span lands in depends on what its parent was — the simulator
 * hangs its measurements off the root, so they arrive inside it, while a trace
 * whose root never came holds those same spans at the top. Walking both lists is
 * what makes the reading the same either way, and it is what makes a measurement
 * countable on a conversation egma holds only part of.
 *
 * **Exported because the grading engine walks the same tree** for the tool calls
 * and for the span that closes a trace. It used to hold a copy of this,
 * docstring and all, which is two implementations of "every span, once" — and
 * the day one of them learned about a third list, the other would quietly stop
 * seeing part of every conversation.
 */
export function* everySpanIn(
  conversation: SpannedConversation,
): Generator<TraceSpan> {
  const walk = function* (spans: readonly TraceSpan[]): Generator<TraceSpan> {
    for (const span of spans) {
      yield span;
      yield* walk(span.spans);
    }
  };
  yield* walk(conversation.turns);
  yield* walk(conversation.spans);
}

/**
 * By when it began, as the store wrote the instant — fixed-width RFC 3339 to
 * the microsecond, so the strings sort exactly as the moments do and no `Date`
 * is built to round the last three digits off.
 */
function byWhenItStarted(
  left: { readonly at: string },
  right: { readonly at: string },
): number {
  return left.at < right.at ? -1 : left.at > right.at ? 1 : 0;
}
