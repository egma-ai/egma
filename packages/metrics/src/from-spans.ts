import {
  MEASURE_CATALOG,
  type CatalogedMeasure,
  type MeasureAggregation,
} from "./measures.ts";
import type { ReportedOnTrace, TraceSpan } from "./spans.ts";

/**
 * The shared measure module: a conversation in, the measure catalog's numbers
 * out.
 *
 * **Three sources, one answer per measure.** A measure egma timed itself wins;
 * a measure worked out from a recognised framework's own spans comes next; what
 * the agent platform reported about its own conversation comes last. Every step
 * of the chain is absolute — nothing is averaged with anything and nothing is
 * appended to anything — and every number says which step it came from, because
 * a developer reading a verdict is entitled to know whether egma watched it
 * happen or was told about it.
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
 * **The source is not an input, and cannot become one.** What goes in is a
 * conversation's spans, and what a platform reported about it; what comes out is
 * what those carry. A simulation's telemetry and a real caller's arrive at the
 * same OTLP door and land in the same table, so "identical input, identical
 * numbers" is a property of this function's signature rather than a promise
 * somebody has to keep — there is nowhere here for `source` to be read even by a
 * caller who wanted to. The reported block is not a way in for it: it is what a
 * platform said about one conversation, read on its own terms and last of the
 * three, and a simulation carrying one would be read exactly the same way.
 *
 * **The catalog decides what is computed and how.** Every measure carries its
 * span-level definition beside its name
 * (`packages/metrics/measure-catalog.md`), the rule is one of a
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
 * transcript, and what its platform reported about it.
 *
 * Structural rather than `TraceDetail` itself, so a caller holding a trace hands
 * it straight over and a test can hand over the lists — and so that adding a
 * fact to a trace read is not a change to this arithmetic. A trace read hands
 * back the turns lifted out for the transcript and everything filed beside them,
 * with children hanging beneath both; every span is under one of the two, once.
 */
export type SpannedConversation = {
  readonly turns: readonly TraceSpan[];
  readonly spans: readonly TraceSpan[];
  /**
   * What the platform measured about this conversation itself, when the trace
   * read found a block on its root span.
   *
   * **Not spans, and that is the honest shape.** These numbers were never
   * events egma watched happen; they are what somebody else says happened, and
   * dressing them as spans would fabricate a granularity the platform never
   * gave. So they arrive beside the spans rather than among them, they are read
   * last, and every number worked out from them says so.
   *
   * Optional, because a conversation is a conversation without one — every
   * simulation, and every platform egma reads no numbers from.
   */
  readonly reported?: ReportedOnTrace | undefined;
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
   * Which of the three sources this number came from: a timing span egma's own
   * vocabulary names, a derivation off a recognised framework's own spans, or
   * the platform's own reported block.
   *
   * A fact about *this* conversation and not about the measure, which is why it
   * rides the answer instead of sitting in the catalog: the same measure is
   * timed on a simulation, derived on a stock LiveKit call, and reported on a
   * Retell one. A page saying where a number came from is the difference
   * between a verdict a developer trusts and one they have to go and check —
   * and `reported` is the value that most needs saying out loud, because a
   * platform's measurement of its own agent is a different kind of evidence
   * from egma's observation of it.
   *
   * Not the catalog's own `origin`, which says where a measure arrives from in
   * general — a timing span or a terminal fact. This says who measured this
   * one, on this conversation.
   */
  readonly origin: "timed" | "derived" | "reported";
  /**
   * Who reported it — the agent platform name, such as `retell` — and the
   * empty string for every measure egma measured itself.
   *
   * Empty rather than absent, so that reading it is never a narrowing: anything
   * printing a platform's name asks `origin === "reported"` first, and there is
   * one question to ask rather than two that could come to disagree.
   */
  readonly reportedBy: string;
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

/**
 * The kinds a derivation reads, and the whole of why reading them is safe.
 *
 * **The vetting lives at the door.** `apps/api/src/otlp/normalise.ts` assigns
 * every one of these from a table keyed by the emitting instrumentation scope;
 * a scope that table does not know is filed as `other`, whatever its spans are
 * called. So a span carrying one of these kinds is a span egma recognised the
 * emitter of, and nothing here has to re-check a name a lookalike framework
 * could have chosen. `speaking` is LiveKit's alone today; the two turn kinds
 * are LiveKit's, egma's own simulator's, and the Retell normalizer's — whose
 * turns carry real word-bound timings, so the derivations below read them
 * exactly as they read LiveKit's. A simulation carries timing spans, which win
 * outright below.
 *
 * **The root is not a kind.** A root wears whatever word its platform uses —
 * `root` on egma's own traces and on LiveKit's, `conversation` on a Retell one
 * — so the derivations recognise it the way the trace read itself does: by the
 * empty parent, the one fact about a root no platform spells differently. A
 * reader that named kinds would have to learn a new word per platform, and
 * forgetting one costs a measure silently (Retell's `first_response_latency`
 * was never derived for exactly that reason).
 */
const HUMAN_TURN = "turn:human";
const AGENT_TURN = "turn:agent";
const SPEAKING = "speaking";

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const NANOSECONDS_PER_MICROSECOND = 1_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;

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
  const derived = derivedFromFrameworkSpans(conversation);
  const reported = conversation.reported;

  const measured: MeasuredFromSpans[] = [];
  for (const cataloged of MEASURE_CATALOG) {
    const found = samplesOf(cataloged, timed);
    if (found.length > 0) {
      measured.push({
        measure: cataloged.measure,
        unit: cataloged.unit,
        origin: "timed",
        reportedBy: "",
        samples: found,
      });
      continue;
    }
    // **egma's own timing vocabulary wins absolutely, and this `continue` is
    // where.** A conversation carrying both a timed measure and the shapes a
    // derivation reads has one answer, not two averaged or two appended: the
    // measurement somebody instrumented on purpose. Deriving beside it would
    // double the samples of one turn and quietly move every percentile.
    const worked = derived.get(cataloged.measure) ?? [];
    if (worked.length > 0) {
      measured.push({
        measure: cataloged.measure,
        unit: cataloged.unit,
        origin: "derived",
        reportedBy: "",
        samples: worked,
      });
      continue;
    }
    // **And the platform's own numbers are last, for the same reason and by the
    // same absolute rule.** egma watching the conversation outranks the
    // platform grading its own homework, so a measure egma timed or derived is
    // never joined by what the platform said about it: one answer per measure,
    // never averaged and never appended. Last is not least — for a Retell trace
    // it is the only source there is, and the whole difference between a
    // production conversation with a verdict and one with a polite silence.
    if (reported === undefined) continue;
    const said = reportedSamplesOf(cataloged, reported);
    if (said.length === 0) continue;
    measured.push({
      measure: cataloged.measure,
      unit: cataloged.unit,
      origin: "reported",
      reportedBy: reported.reportedBy,
      samples: said,
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
 * One of the catalog's eight reductions, computed over a measure's samples.
 *
 * **The whole list, implemented in one place.** The catalog declares which
 * reductions a threshold may ask of a measure; this switch is that list made
 * runnable, exhaustively — a name joining `MEASURE_AGGREGATIONS` without a
 * case here stops the build instead of shipping as a reduction that answers
 * nothing. The surfaces choose what to show and the wire carries what a page
 * needs; the arithmetic never lives anywhere else.
 *
 * **Percentiles are nearest-rank**, exactly as the catalog states them: the
 * p90 of ten measurements is the ninth of them, not an interpolation — a
 * measurement that actually happened, findable in the transcript. The mean is
 * rounded to the nearest whole unit here, once, so two surfaces printing one
 * conversation can never disagree in the last digit; every other reduction
 * answers a sample (or a sum of samples) verbatim.
 *
 * A reduction cites no single span — the samples beside it carry the
 * citations — so it is a number rather than a `Sample`. `undefined` for a
 * measure with no samples, which nothing this module builds ever has,
 * answered rather than assumed for `worstSampleOf`'s exact reason.
 */
export function aggregateOf(
  measured: MeasuredFromSpans,
  aggregation: MeasureAggregation,
): number | undefined {
  const values = measured.samples.map((sample) => sample.value);
  if (values.length === 0) return undefined;
  switch (aggregation) {
    case "mean":
      return Math.round(values.reduce((sum, one) => sum + one, 0) / values.length);
    case "sum":
      return values.reduce((sum, one) => sum + one, 0);
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "p50":
      return nearestRank(values, 50);
    case "p90":
      return nearestRank(values, 90);
    case "p95":
      return nearestRank(values, 95);
    case "p99":
      return nearestRank(values, 99);
  }
}

/** The nearest-rank percentile: the value at rank ⌈p/100 × n⌉ of the sorted
 * samples, so the answer is a measurement that actually happened. */
function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1] as number;
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
      // interval — and it becomes milliseconds through the one conversion this
      // module has, which every derived measure also goes through.
      value: milliseconds(BigInt(span.durationNanoseconds)),
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

/* ------------------------------------------------------------------- *
 * The reported measures: what the platform said, read as the catalog's
 * numbers.
 * ------------------------------------------------------------------- */

/**
 * One cataloged measure's samples out of the platform's reported block, or
 * nothing where the block does not hold that measure.
 *
 * **The name and the unit both have to match, and the unit is not a
 * formality.** A platform that reports its end-to-end latency in seconds under
 * the catalog's own name is reporting something real; reading `2.145` as
 * milliseconds would hand a grader a conversation that answered in two
 * milliseconds, and a two-second bound would pass what it exists to fail. A
 * number in the wrong unit is worse than no number, so such a measurement is
 * skipped in silence and the measure comes back absent — which is a `skipped`
 * check rather than a false pass, and the difference the verdict vocabulary is
 * built on. Converting it instead would be egma inventing a fact about a unit
 * nobody in this repository declared.
 *
 * **A platform-prefixed name never matches**, because no catalog measure is
 * called `retell/llm_latency`. Those entries stay in the block for the day a
 * display asks for them, and are deliberately not folded into the catalog
 * answer beside a stage that means something else.
 *
 * **Every sample cites the root span the block rode in on.** These numbers
 * describe the whole conversation and happened at no single moment inside it,
 * so the root is the only span that can honestly be pointed at — and a verdict
 * citing it opens the trace the measurement is about rather than a turn picked
 * to look precise.
 *
 * **A measurement that runs backwards is not kept, and the rule is the
 * derivation's own.** A real conversation on a real Retell account reports an
 * end-to-end sample of −2103 ms; the derivation above already refuses a
 * negative for the reason that applies here word for word — a wait that ran
 * backwards is not a fast answer, and a number that is wrong is worse than a
 * measurement that is missing. It is worse than harmless in this arm: the worst
 * sample decides a bound, so a negative can never fail one and would sit in the
 * series holding it trivially, then drag every mean and percentile down the day
 * a grader can ask for one. A reported **zero** stays, and the difference is
 * real — zero is what the platform says it measured, not the placeholder pair a
 * zero-width turn would have produced. The block on the payload is untouched by
 * any of this: the writer keeps everything the platform said, and the fold
 * refuses what cannot be true.
 *
 * A measurement whose every value runs backwards contributes nothing, so the
 * measure is absent exactly as it is for one the platform never took.
 *
 * The order is the platform's own, exactly as a timed series is the order it
 * was taken in: the block carries raw measurements rather than a summary, so
 * read forwards it is the conversation read forwards.
 */
function reportedSamplesOf(
  cataloged: CatalogedMeasure,
  reported: ReportedOnTrace,
): readonly Sample[] {
  // The first match wins where a block somehow names one measure twice in one
  // unit. A normalizer maps each of its own stages once, so nothing writes such
  // a block — and the reader stays lenient rather than refusing, exactly as the
  // contract's parse does: a duplicate is one platform's bookkeeping mistake,
  // and answering with the first of two identical-looking series beats
  // answering a customer with nothing.
  const said = reported.measurements.find(
    (measurement) =>
      measurement.measure === cataloged.measure &&
      measurement.unit === cataloged.unit,
  );
  if (said === undefined) return [];
  return said.values
    .filter((value) => value >= 0)
    .map((value) => ({ value, spanId: reported.spanId }));
}

/* ------------------------------------------------------------------- *
 * The derived measures: a framework's own spans, read as the catalog's
 * numbers.
 * ------------------------------------------------------------------- */

/**
 * The measures egma works out from the shapes a recognised framework emits,
 * for a conversation that timed none of them itself.
 *
 * **Why derive at all.** A team points a stock LiveKit agent at egma and
 * watches real conversations arrive, and the one question monitoring exists to
 * answer — is my agent answering fast enough — was `skipped` on every one of
 * them, because the framework times its turns in its own vocabulary and egma
 * only read its own. The durations were there the whole time. Reading them is
 * what turns a polite silence into a verdict.
 *
 * **Read time, not write time.** Nothing new is stored and the door still
 * writes exactly what arrived, so every conversation already in the store gains
 * its measures on the next read rather than on the next ingest.
 *
 * **Recognition rides the door's scope vetting** — see the kinds above. A
 * framework egma does not know files everything as `other`, matches none of
 * this, and derives nothing, which is the honest answer for a conversation egma
 * cannot read.
 *
 * Every rule below is written out beside its measure's name in
 * `packages/metrics/measure-catalog.md`, plainly enough that two
 * readers compute the same number from the same spans.
 */
function derivedFromFrameworkSpans(
  conversation: SpannedConversation,
): ReadonlyMap<string, readonly Sample[]> {
  const turns: TimedSpan[] = [];
  let root: TimedSpan | undefined;

  for (const span of everySpanIn(conversation)) {
    if (span.kind === HUMAN_TURN || span.kind === AGENT_TURN) {
      // **Every turn joins the list, whatever its timings are worth.** What this
      // list carries is the conversational order, and the walk below reads it
      // for who answered whom — so a turn held out of it stops being a barrier
      // between the turns around it, and two people's waits become one. Which
      // measurements a turn is fit to produce is a question for the measure that
      // produces them, one at a time, and never for membership here.
      turns.push(timed(span));
      continue;
    }
    // The earliest parentless span, so a trace holding more than one — a
    // flush whose parent never came reads as a second root — is read from
    // where the conversation actually began: the true root starts before
    // everything that happened inside it.
    if (span.parentSpanId === "") {
      const candidate = timed(span);
      if (root === undefined || candidate.startedAt < root.startedAt) {
        root = candidate;
      }
    }
  }
  turns.sort(byWhenItBegan);

  const derived = new Map<string, readonly Sample[]>();
  put(derived, "turn_response_latency", turnResponseLatency(turns));
  put(derived, "first_response_latency", firstResponseLatency(root, turns));
  put(derived, "agent_speech_duration", agentSpeechDuration(turns));
  return derived;
}

/** A measure with no samples is absent, exactly as it is for a timed one. */
function put(
  derived: Map<string, readonly Sample[]>,
  measure: string,
  samples: readonly Sample[],
): void {
  if (samples.length > 0) derived.set(measure, samples);
}

/**
 * How long the agent took to answer, once for every turn the human took.
 *
 * From the **human turn's end** to the moment the agent's next turn began
 * speaking — its first `speaking` child's start, or the turn's own start for an
 * agent turn that carried no speech, which is what a turn that answered with a
 * tool call looks like. The next agent turn is the next one in the
 * conversation, ordered by when each began, which is the order a transcript
 * reads in.
 *
 * **A measurement that runs backwards is not a slow answer and is not kept.**
 * Turn spans overlap on a real captured call — five neighbouring pairs out of
 * twelve — and the overlap is the framework's turn bookkeeping, not audible
 * talk-over: the same call's speaking spans carry zero seconds of simultaneous
 * audio (`research/voice-agent-interruption-metrics.md`, planning root). A
 * negative latency would drag a mean below zero and make a bound pass that
 * should have failed — a number that is wrong is worse than a measurement that
 * is missing, so the overlapping pair contributes nothing and the turns around
 * it still count.
 *
 * **A zero read off a turn that had no width is two placeholders agreeing, and
 * is not kept either.** Retell reports per-word timings on every spoken turn,
 * and its normalizer has written real turn timestamps from them since commit
 * `cc7b8c9` — but a turn whose words are missing, and every turn stored before
 * that commit, keeps the prior honest fallback: opened at the trace's own
 * start and closed in the same instant, said plainly in
 * `apps/api/src/retell/normalise.ts`. Subtract one such placeholder from the
 * next and the answer is zero, every time, for the arithmetic's own reasons
 * and not the agent's: a series a bound cannot fail, so a trace whose worst
 * wait was really 2145 ms holds a two-second bound with a zero as its
 * rationale, which is the false pass this product exists to kill. A
 * conversation of placeholders therefore derives nothing here and answers
 * from the platform's reported block instead — which is exactly what those
 * stored rows carry.
 *
 * **It is the pair that says so, and never the width alone.** A chat simulation
 * writes turns of no width too — a typed message is one instant and there is
 * nothing to measure a duration of — but at real, distinct instants, so the gap
 * it answers across is observed and every sample of it stands. Only a zero
 * whose own turn also had no width has nothing behind it on either side.
 */
function turnResponseLatency(turns: readonly TimedSpan[]): readonly Sample[] {
  const samples: Sample[] = [];
  for (const [at, turn] of turns.entries()) {
    if (turn.kind !== HUMAN_TURN) continue;
    const answered = answeringSpeech(turns, at);
    if (answered === undefined) continue;
    const latency = milliseconds(answered.startedAt - turn.endedAt);
    if (latency < 0) continue;
    if (latency === 0 && turn.duration === 0n) continue;
    samples.push({ value: latency, spanId: answered.spanId });
  }
  return samples;
}

/**
 * How long the agent took to say anything at all, from the moment the
 * conversation began.
 *
 * The root span is where a conversation begins — the earliest parentless span,
 * the one the whole thing happened inside — and the agent's first word is its
 * first turn's first `speaking` child.
 *
 * **Where the framework wrote no `speaking` spans at all**, the first agent
 * turn's own start stands in: a word-bounded Retell turn begins at its first
 * word, which is the same fact spelled the other way. The fallback is about
 * granularity the emitter lacks, never about the turn — a framework that does
 * write speech makes a speechless first turn honestly unmeasurable, because
 * there a turn with no speech is a turn that never said anything, not a turn
 * whose words went unrecorded.
 *
 * A first agent turn with **neither speech nor width** has nothing measured —
 * a zero-width turn is the Retell normalizer's placeholder, opened at the
 * trace's own start, and reading it would answer a zero nobody waited. This
 * measure is taken once, and one wrong number is the whole of it.
 */
function firstResponseLatency(
  root: TimedSpan | undefined,
  turns: readonly TimedSpan[],
): readonly Sample[] {
  if (root === undefined) return [];
  const first = turns.find((turn) => turn.kind === AGENT_TURN);
  if (first === undefined) return [];
  const speechless = turns.every((turn) => turn.speech.length === 0);
  const spoke = first.speech[0];
  const from =
    spoke ??
    (speechless && first.duration > 0n
      ? { startedAt: first.startedAt, spanId: first.spanId }
      : undefined);
  if (from === undefined) return [];
  const latency = milliseconds(from.startedAt - root.startedAt);
  if (latency < 0) return [];
  return [{ value: latency, spanId: from.spanId }];
}

/**
 * How long the agent spoke for in each of its turns, silence inside the answer
 * excluded — which is what summing the turn's `speaking` children rather than
 * taking the turn's own duration gets: a turn that thought for two seconds and
 * then talked for one spoke for one.
 *
 * One sample per agent turn **that spoke**. A turn with no speech in it did not
 * speak for zero milliseconds; it has no speech duration at all, and a zero
 * would be a measurement of something that never happened.
 *
 * The sample cites the turn rather than one of the children, because the number
 * is the turn's and no single child holds it.
 */
function agentSpeechDuration(turns: readonly TimedSpan[]): readonly Sample[] {
  const samples: Sample[] = [];
  for (const turn of turns) {
    if (turn.kind !== AGENT_TURN || turn.speech.length === 0) continue;
    let spoken = 0n;
    for (const speech of turn.speech) spoken += speech.duration;
    samples.push({ value: milliseconds(spoken), spanId: turn.spanId });
  }
  return samples;
}

/**
 * Where the agent's answer to the human turn at `at` began.
 *
 * The next agent turn's first speech, or that turn's own start when it carried
 * none. `undefined` when nobody answered — the human had the last word, or said
 * something else first.
 *
 * **An agent turn answers only the nearest human turn before it, so the walk
 * stops at the next human turn rather than reading past it.** A caller who says
 * "hello" and then "are you there" before the agent replies has taken two turns
 * and been answered once, and letting the one reply count for both would file
 * the same wait twice — the same number in the series twice over, a worse worst
 * on a page, and, in the limit, a bound failed by a duplicate. The unanswered
 * first turn measures nothing, which is what actually happened: the wait it
 * would have measured ended when the caller spoke again, not when the agent did.
 */
function answeringSpeech(
  turns: readonly TimedSpan[],
  at: number,
): { readonly startedAt: bigint; readonly spanId: string } | undefined {
  for (const turn of turns.slice(at + 1)) {
    if (turn.kind === HUMAN_TURN) return undefined;
    if (turn.kind !== AGENT_TURN) continue;
    return turn.speech[0] ?? { startedAt: turn.startedAt, spanId: turn.spanId };
  }
  return undefined;
}

/**
 * A span as this arithmetic needs it: nanoseconds rather than the two strings
 * a read hands back, and its speech lifted out once rather than per measure.
 */
type TimedSpan = {
  readonly spanId: string;
  readonly kind: string;
  readonly startedAt: bigint;
  readonly endedAt: bigint;
  readonly duration: bigint;
  /** This turn's own `speaking` children, earliest first. */
  readonly speech: readonly {
    readonly startedAt: bigint;
    readonly spanId: string;
    readonly duration: bigint;
  }[];
};

function timed(span: TraceSpan): TimedSpan {
  const startedAt = startedAtNanoseconds(span);
  const duration = BigInt(span.durationNanoseconds);
  return {
    spanId: span.spanId,
    kind: span.kind,
    startedAt,
    endedAt: startedAt + duration,
    duration,
    speech: span.spans
      .filter((child) => child.kind === SPEAKING)
      .map((child) => ({
        startedAt: startedAtNanoseconds(child),
        spanId: child.spanId,
        duration: BigInt(child.durationNanoseconds),
      }))
      .sort((left, right) =>
        left.startedAt < right.startedAt
          ? -1
          : left.startedAt > right.startedAt
            ? 1
            : 0,
      ),
  };
}

/**
 * When a span began, in nanoseconds since the epoch.
 *
 * The store keeps starts to the microsecond and durations to the nanosecond, so
 * this is exactly as precise as what was written: the six fractional digits are
 * read as digits rather than through a `Date`, which holds milliseconds and
 * would round the last three away — and a latency is a difference of two of
 * these, where three lost digits is three lost digits of the answer.
 */
function startedAtNanoseconds(span: TraceSpan): bigint {
  const dot = span.startedAt.indexOf(".");
  if (dot === -1) {
    return (
      BigInt(Math.round(Date.parse(span.startedAt) / 1000)) *
      MICROSECONDS_PER_SECOND *
      NANOSECONDS_PER_MICROSECOND
    );
  }
  const seconds = BigInt(Math.round(Date.parse(`${span.startedAt.slice(0, dot)}Z`) / 1000));
  const fraction = span.startedAt.slice(dot + 1).replace(/[^0-9]/g, "");
  const microseconds = BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  return (
    (seconds * MICROSECONDS_PER_SECOND + microseconds) *
    NANOSECONDS_PER_MICROSECOND
  );
}

/**
 * Nanoseconds as the milliseconds the catalog states every latency in.
 *
 * Floating point on purpose, exactly as a timing span's own duration is: a
 * measure is `862.5ms` and a whole-number division would floor every one of
 * them.
 */
function milliseconds(nanoseconds: bigint): number {
  return Number(nanoseconds) / NANOSECONDS_PER_MILLISECOND;
}

/** Earliest first, on the nanoseconds rather than on the stored strings. */
function byWhenItBegan(left: TimedSpan, right: TimedSpan): number {
  return left.startedAt < right.startedAt
    ? -1
    : left.startedAt > right.startedAt
      ? 1
      : 0;
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
 * and for the span that closes a trace — generic over the span shape, because
 * the walk cares only about the tree and a caller's spans carry more fields
 * than this arithmetic reads. It used to hold a copy of this,
 * docstring and all, which is two implementations of "every span, once" — and
 * the day one of them learned about a third list, the other would quietly stop
 * seeing part of every conversation.
 */
export function* everySpanIn<Span extends { readonly spans: readonly Span[] }>(
  conversation: {
    readonly turns: readonly Span[];
    readonly spans: readonly Span[];
  },
): Generator<Span> {
  const walk = function* (spans: readonly Span[]): Generator<Span> {
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
