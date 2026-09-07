import {
  AGENT_POV_HEADLINE_MEASURES,
  MEASURE_CATALOG,
  type CatalogedMeasure,
  type MeasureAggregation,
} from "./measures.ts";
import type { ReportedOnTrace, TraceSpan } from "./spans.ts";

/**
 * Compute metrics from spans and reported measurements without store access.
 * Keep persona and agent POVs in separate series. Within the agent's POV,
 * derived samples take precedence over reported samples. The measure catalog
 * selects the primary POV; otherPov carries the second series when available.
 * Simulation and production use the same computation over the same inputs.
 */

/**
 * Minimal trace input: transcript turns, other spans, their children, and
 * reported measurements. Each span occurs once across the two trees.
 */
export type SpannedConversation = {
  readonly turns: readonly TraceSpan[];
  readonly spans: readonly TraceSpan[];
  /**
   * Optional measurements reported by the agent platform on the root span.
   * Use them as the agent-POV fallback, not as fabricated timing spans.
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

/**
 * Metric-series POV: timed samples belong to the persona; derived and
 * reported samples belong to the agent. This classifies a series origin,
 * whereas the span emitter column identifies who wrote a span.
 */
export function povOfOrigin(
  origin: MeasuredByOnePov["origin"],
): "persona" | "agent" {
  return origin === "timed" ? "persona" : "agent";
}

/**
 * One measure as **one POV** measured it: the number's provenance and its
 * samples.
 *
 * Split out so the second POV's series can ride beside the first with exactly
 * the fields that describe a series and none of the ones that describe the
 * measure — a measure has one name and one unit whoever measured it.
 */
export type MeasuredByOnePov = {
  /**
   * Origin of this series: timed by the simulator, derived from framework spans,
   * or reported by the agent platform. Distinct from the catalog origin, which
   * describes how the measure can arrive in general.
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
   * Samples in measurement order. Never empty: omit an unmeasured metric so
   * a grader can distinguish missing evidence from a measured zero.
   */
  readonly samples: readonly Sample[];
};

/** One measure, as this conversation's spans carried it. */
export type MeasuredFromSpans = MeasuredByOnePov & {
  readonly measure: string;
  /** The catalog's own unit, so nothing downstream has to look it up again. */
  readonly unit: CatalogedMeasure["unit"];
  /**
   * The other POV's series, when available. Never merge or average it with
   * the primary series; doing so would count a turn twice.
   */
  readonly otherPov?: MeasuredByOnePov | undefined;
};

/**
 * Match both timing kind and measure name. Ingestion validates instrumentation
 * scope before assigning this kind, so a lookalike name alone cannot qualify.
 */
const TIMING = "timing";

/**
 * Ingestion assigns recognized span kinds by instrumentation scope; unknown
 * scopes remain other. Derivations use these vetted kinds. Identify roots
 * by an empty parent ID, since platforms use different root kind names.
 */
const HUMAN_TURN = "turn:human";
const AGENT_TURN = "turn:agent";
const SPEAKING = "speaking";

/**
 * Span kinds needed for turn response latency. Keep all timing spans here;
 * measuresFromSpans selects the measure by name. Fetch the root's reported
 * measurements separately when the reported fallback is needed.
 */
export function turnResponseLatencySpanKinds(): readonly string[] {
  return [TIMING, HUMAN_TURN, AGENT_TURN, SPEAKING];
}
// The stage kinds the door assigns to a recognised framework's own steps —
// LiveKit's llm_node/llm_request family lands as `model`, its tts family as
// `tts` — read here for the platform-stage measures and vetted the same way
// the turn kinds are: by the emitting scope, at the door, never by a name.
const MODEL_STEP = "model";
const SYNTHESIS_STEP = "tts";

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const NANOSECONDS_PER_MICROSECOND = 1_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;

/** Return measured metrics in catalog order, with samples in measurement order. */
export function measuresFromSpans(
  conversation: SpannedConversation,
): readonly MeasuredFromSpans[] {
  const timed = timingSpansByName(conversation);
  const derived = derivedFromFrameworkSpans(conversation);
  const reported = conversation.reported;

  const measured: MeasuredFromSpans[] = [];
  for (const cataloged of MEASURE_CATALOG) {
    const persona = personaPovOf(cataloged, timed);
    const agent = agentPovOf(cataloged, derived, reported);
    // **The catalog version decides which POV a consumer meets first.** Both
    // series ride out where both exist, and the order is the whole of the
    // headline: a `find` by name — which is what the latency grader, the
    // metrics strip and the page's own p90 all do — takes the first.
    const inOrder = AGENT_POV_HEADLINE_MEASURES.includes(cataloged.measure)
      ? [agent, persona]
      : [persona, agent];
    const [headline, other] = inOrder.filter(
      (series): series is MeasuredByOnePov => series !== undefined,
    );
    if (headline === undefined) continue;
    measured.push({
      measure: cataloged.measure,
      unit: cataloged.unit,
      ...headline,
      ...(other === undefined ? {} : { otherPov: other }),
    });
  }
  return measured;
}

/**
 * The persona's POV of one measure: what egma timed itself, off its own
 * recording and its own clock.
 *
 * `undefined` where egma timed nothing, which is every production trace.
 */
function personaPovOf(
  cataloged: CatalogedMeasure,
  timed: ReadonlyMap<string, readonly Sample[]>,
): MeasuredByOnePov | undefined {
  const found = samplesOf(cataloged, timed);
  if (found.length === 0) return undefined;
  return { origin: "timed", reportedBy: "", samples: found };
}

/**
 * Choose derived samples for the agent's POV, falling back to reported ones.
 * Never blend the two. Return undefined when neither provides this measure.
 */
function agentPovOf(
  cataloged: CatalogedMeasure,
  derived: ReadonlyMap<string, readonly Sample[]>,
  reported: ReportedOnTrace | undefined,
): MeasuredByOnePov | undefined {
  const worked = derived.get(cataloged.measure) ?? [];
  if (worked.length > 0) {
    return { origin: "derived", reportedBy: "", samples: worked };
  }
  if (reported === undefined) return undefined;
  const said = reportedSamplesOf(cataloged, reported);
  if (said.length === 0) return undefined;
  return { origin: "reported", reportedBy: reported.reportedBy, samples: said };
}

/**
 * Return the largest sample and its evidence span, retaining the first tie.
 * Return undefined for an empty series; do not substitute zero.
 */
export function worstSampleOf(measured: MeasuredFromSpans): Sample | undefined {
  let worst: Sample | undefined;
  for (const sample of measured.samples) {
    if (worst === undefined || sample.value > worst.value) worst = sample;
  }
  return worst;
}

/**
 * Reduce samples using the catalog's aggregation. Percentiles use nearest
 * rank; the mean rounds to a whole unit. Return undefined for an empty
 * series. Evidence span IDs remain on the samples, not on the aggregate.
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
 * Nearest-rank p90 for grading. Unlike aggregateOf, reject empty series
 * and any nonfinite or negative sample. Missing evidence is a grading error,
 * not a zero. Below ten samples, p90 is the slowest sample.
 */
export function p90Of(measured: MeasuredFromSpans): number | undefined {
  const values: number[] = [];
  for (const sample of measured.samples) {
    if (!Number.isFinite(sample.value) || sample.value < 0) return undefined;
    values.push(sample.value);
  }
  if (values.length === 0) return undefined;
  return nearestRank(values, 90);
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
      // so this arm is what a display asks and no current grader uses.
      return [];
    }
    case "platform_telemetry_carries_it": {
      // Nothing here either, and for the opposite reason: egma's own
      // vocabulary never times a platform stage, so there is no timing span to
      // look up. The samples come later in the chain — derived from a
      // recognised framework's stage spans, or read from the platform's
      // reported block — through the same precedence every measure obeys.
      return [];
    }
  }
}

/* ------------------------------------------------------------------- *
 * The reported measures: what the platform said, read as the catalog's
 * numbers.
 * ------------------------------------------------------------------- */

/**
 * Read reported samples only when both the measure name and unit match.
 * Do not convert unknown units or platform-prefixed names. Keep sample order,
 * discard negative values, and retain reported zeroes. Cite the root span
 * that carried the block; omit a measure with no usable samples.
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
 * Derive metrics at read time from recognized framework span kinds.
 * Unknown scopes produce no derived metrics. Definitions live in
 * measure-catalog.md; no derived values are written back to the store.
 */
function derivedFromFrameworkSpans(
  conversation: SpannedConversation,
): ReadonlyMap<string, readonly Sample[]> {
  const turns: TimedSpan[] = [];
  let root: TimedSpan | undefined;

  for (const span of everySpanIn(conversation)) {
    // **The agent's own spans, and only the agent's.** A simulation stores both
    // accounts of one conversation under one trace id, and egma's account
    // carries transcript turns too — the same exchanges, from egma's side, on
    // egma's own clock. Reading both would measure every wait twice over and
    // each one wrongly: the persona's turns speak no `speaking` spans, so they
    // would sit between the agent's turns as barriers that answer nothing.
    // What egma measured itself is not lost by this — it arrives as timing
    // spans, which are the persona's POV and are read above.
    if (span.pov === "persona") continue;
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
  put(derived, "llm_latency", stageLatency(turns, "modelStepsDuration"));
  put(derived, "tts_latency", stageLatency(turns, "synthesisStepsDuration"));
  return derived;
}

/**
 * Sum stage-step durations within each agent turn, including retries.
 * Emit one sample per turn that contains the stage and cite that turn.
 * A missing stage produces no sample, not zero.
 */
function stageLatency(
  turns: readonly TimedSpan[],
  stage: "modelStepsDuration" | "synthesisStepsDuration",
): readonly Sample[] {
  const samples: Sample[] = [];
  for (const turn of turns) {
    if (turn.kind !== AGENT_TURN) continue;
    const spent = turn[stage];
    if (spent === 0n) continue;
    samples.push({ value: milliseconds(spent), spanId: turn.spanId });
  }
  return samples;
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
 * Measure each human turn's wait for the next answering speech. The starting
 * line is the last speaking child's end, falling back to the turn end when
 * speech timing is unavailable. The finish line is selected by answeringSpeech.
 * VAD detection lag remains in the agent's clock; endpointing commit is later
 * and must not replace an available speaking boundary.
 *
 * Skip continuations and interrupted replies as defined by continuationTurns.
 * Discard negative waits and zero waits from zero-width placeholder turns.
 * Distinct zero-width chat messages still produce valid positive waits.
 */
function turnResponseLatency(turns: readonly TimedSpan[]): readonly Sample[] {
  const samples: Sample[] = [];
  const traceHasNoSpeakingSpans = hasNoSpeakingSpans(turns);
  const continuation = continuationsIn(turns, traceHasNoSpeakingSpans);
  for (const [at, turn] of turns.entries()) {
    if (turn.kind !== HUMAN_TURN) continue;
    // The rest of the previous utterance is not a question of its own, so it
    // opens no wait: the wait it belongs to was opened by the turn that carried
    // the caller's speech, and is measured there.
    if (continuation[at] === true) continue;
    const answered = answeringSpeech(
      turns,
      at,
      traceHasNoSpeakingSpans,
      continuation,
    );
    if (answered === undefined) continue;
    const latency = milliseconds(answered.startedAt - stoppedSpeaking(turn));
    if (latency < 0) continue;
    if (latency === 0 && turn.duration === 0n) continue;
    samples.push({ value: latency, spanId: answered.spanId });
  }
  return samples;
}

/**
 * Measure from the earliest parentless span to the first agent turn's speech.
 * Fall back to that turn's start only if the trace has no speaking spans.
 * A speechless, zero-width turn is a placeholder and produces no sample.
 */
function firstResponseLatency(
  root: TimedSpan | undefined,
  turns: readonly TimedSpan[],
): readonly Sample[] {
  if (root === undefined) return [];
  const first = turns.find((turn) => turn.kind === AGENT_TURN);
  if (first === undefined) return [];
  const traceHasNoSpeakingSpans = hasNoSpeakingSpans(turns);
  const spoke = first.speech[0];
  const from =
    spoke ??
    (traceHasNoSpeakingSpans && first.duration > 0n
      ? { startedAt: first.startedAt, spanId: first.spanId }
      : undefined);
  if (from === undefined) return [];
  const latency = milliseconds(from.startedAt - root.startedAt);
  if (latency < 0) return [];
  return [{ value: latency, spanId: from.spanId }];
}

/**
 * Sum speaking-child durations per agent turn, excluding silence. Cite the
 * turn and omit speechless turns rather than returning a zero duration.
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
 * Find answering speech before the next independent human turn. Skip silent
 * model/tool turns, interrupted replies, and continuation turns. When the
 * trace has no speaking spans, use the first agent turn's start instead.
 * Return undefined if no reply qualifies; one reply cannot answer two
 * independent human turns.
 */
function answeringSpeech(
  turns: readonly TimedSpan[],
  at: number,
  traceHasNoSpeakingSpans: boolean,
  continuation: readonly boolean[],
): { readonly startedAt: bigint; readonly spanId: string } | undefined {
  let silentAnswer:
    | { readonly startedAt: bigint; readonly spanId: string }
    | undefined;
  for (let next = at + 1; next < turns.length; next += 1) {
    const turn = turns[next];
    if (turn === undefined) continue;
    if (turn.kind === HUMAN_TURN) {
      if (continuation[next] === true) continue;
      return traceHasNoSpeakingSpans ? silentAnswer : undefined;
    }
    if (turn.kind !== AGENT_TURN) continue;
    // A false start — the reply the turn after it cut off. It answered nothing,
    // so its speech is not the speech that ends the wait.
    if (continuation[next + 1] === true) continue;
    const speech = turn.speech[0];
    if (speech !== undefined) return speech;
    silentAnswer ??= { startedAt: turn.startedAt, spanId: turn.spanId };
  }
  return traceHasNoSpeakingSpans ? silentAnswer : undefined;
}

/**
 * Mark human turns that continue an earlier utterance instead of opening
 * another measured wait. A continuation has no speaking child, starts inside
 * the preceding agent turn, and closes at or after that interrupted reply.
 * Further speechless human turns immediately after a continuation also qualify.
 * A reply that outlives the human turn is not interrupted. Disable this rule
 * when the trace has no speaking spans; missing speech then proves nothing.
 */
function continuationsIn(
  turns: readonly TimedSpan[],
  traceHasNoSpeakingSpans: boolean,
): readonly boolean[] {
  const continuation: boolean[] = new Array<boolean>(turns.length).fill(false);
  if (traceHasNoSpeakingSpans) return continuation;
  // One pass, earliest first: each answer depends on the turn before it, and
  // the turn before it has already been answered — so a run of flushes reads
  // in one walk, however long a trace the door let in.
  for (const [at, turn] of turns.entries()) {
    if (turn.kind !== HUMAN_TURN || turn.speech.length > 0) continue;
    const before = turns[at - 1];
    if (before === undefined) continue;
    if (before.kind === HUMAN_TURN) {
      // Straight after a continuation: the transcriber flushed the same
      // utterance again before the agent had replied to any of it.
      continuation[at] = continuation[at - 1] === true;
      continue;
    }
    if (before.kind !== AGENT_TURN) continue;
    // Opened while the reply ran, and the reply did not outlive it: cut off by
    // its arrival, not carried on past it.
    continuation[at] =
      turn.startedAt < before.endedAt && before.endedAt <= turn.endedAt;
  }
  return continuation;
}

/** Whether this trace's emitter recorded speech at all. */
function hasNoSpeakingSpans(turns: readonly TimedSpan[]): boolean {
  return turns.every((turn) => turn.speech.length === 0);
}

/**
 * When this speaker stopped being audible in this turn: the end of the turn's
 * last `speaking` child, and the turn's own end where the framework recorded
 * none.
 *
 * The children are held earliest first, so the last of them is the one that
 * ran latest — a caller who paused mid-sentence has several, and it is the last
 * burst that ends the turn's audible speech.
 */
function stoppedSpeaking(turn: TimedSpan): bigint {
  const last = turn.speech.at(-1);
  if (last === undefined) return turn.endedAt;
  return last.startedAt + last.duration;
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
  /** The summed durations of this turn's own model-step children, and of its
   * synthesis-step children — the framework's own account of the thinking and
   * the speaking-preparation inside the turn. Zero where the turn carried
   * none, and a zero is "carried none", never a measurement. */
  readonly modelStepsDuration: bigint;
  readonly synthesisStepsDuration: bigint;
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
  let modelStepsDuration = 0n;
  let synthesisStepsDuration = 0n;
  for (const child of span.spans) {
    if (child.kind === MODEL_STEP) {
      modelStepsDuration += BigInt(child.durationNanoseconds);
    } else if (child.kind === SYNTHESIS_STEP) {
      synthesisStepsDuration += BigInt(child.durationNanoseconds);
    }
  }
  return {
    spanId: span.spanId,
    kind: span.kind,
    startedAt,
    endedAt: startedAt + duration,
    duration,
    modelStepsDuration,
    synthesisStepsDuration,
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
 * Visit transcript turns, other spans, and all descendants exactly once.
 * Shared with grading; generic over the span shape so it needs only the tree.
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
