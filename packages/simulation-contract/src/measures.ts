/**
 * The measure catalog: every measure a conversation produces, named once, each
 * beside the definition that says how it is computed from the conversation's
 * spans.
 *
 * **A contract document, not a table.** Nothing writes a row to declare a
 * measure and nothing queries for the list — it is a fact about what egma
 * measures, so it lives beside the two schemas that are the other facts about
 * what the simulator emits, and it is read by the control plane the same way the
 * schemas are: at the write door, before anything is stored.
 *
 * The catalog exists because of one failure it rules out. A grader names the
 * measure it reads as a string, and a string that names nothing produces a
 * grader that reads nothing, judges nothing, and is `skipped` forever — green,
 * silent, and wrong. That is the exact false trust egma exists to kill, so the
 * write door refuses a measure this file does not name. A typo is a refusal at
 * the moment it is written rather than a check that quietly never fires.
 *
 * **Each measure now also carries its span-level definition**, which is the
 * second half of the same guarantee. A name pins what a grader may ask for; the
 * definition beside it pins what egma computes when asked — so the dropdown a
 * developer picks from and the arithmetic that answers them are one list read
 * twice, and a measure cannot be offered that nothing knows how to compute.
 * Added 2026-08-14, when latency became a grader egma actually executes: the
 * numbers on the metrics display and the numbers inside the grader are one
 * module's, and this is where that module is told what to compute.
 *
 * `measure-catalog.md` beside this file is the same catalog in prose, for a
 * person deciding what to bound. The two are held to each other by the
 * contract suite: a measure in one and not the other fails the build's tests.
 */

/**
 * Which catalog this is.
 *
 * Bumped when a measure joins, leaves or changes what it means — the same
 * discipline the two JSON schemas carry, for the same reason. A grader stored
 * against version 1 keeps naming what version 1 named, and a version that
 * dropped a measure is a version whose old graders need reading before they are
 * re-pointed.
 *
 * **2** is where every measure gained a span-level definition and the number a
 * grader reads became one derived from the trace rather than one carried
 * separately. No measure joined or left; what each of them *means* is now said
 * precisely enough to compute, which is exactly what this number is for.
 */
export const MEASURE_CATALOG_VERSION = 2;

/**
 * How a measure is reduced to the one number a threshold is applied to.
 *
 * They live here, with the measures, rather than beside the grader that applies
 * them: which reductions make sense is a fact about what was measured — a
 * latency taken every turn has a p90 and a sample rate measured once does not
 * usefully have one — so the catalog is where both halves of "what may a
 * threshold ask" are written down together.
 *
 * A latency grader almost always wants a percentile. A mean hides the one turn
 * that took nine seconds, which is the turn the caller hung up on.
 */
export const MEASURE_AGGREGATIONS = [
  "mean",
  "max",
  "min",
  "sum",
  "p50",
  "p90",
  "p95",
  "p99",
] as const;

export type MeasureAggregation = (typeof MEASURE_AGGREGATIONS)[number];

/**
 * How many times one simulation measures this.
 *
 * `once` is one number for the whole conversation; `per_turn` is a series, one
 * sample per turn. The distinction is what makes an aggregation mean something:
 * every aggregation of a series says something different, and every aggregation
 * of one number is that number.
 */
export type MeasureShape = "once" | "per_turn";

/** Which simulations produce a measure at all. */
export type MeasureSource = "every simulation" | "voice simulations";

/**
 * Where the number comes from on the wire — which is not the same question as
 * what it is called here.
 *
 * `timing_span` measures arrive as their own spans through the trace store's
 * ingest, one per measurement, named for exactly the name in this catalog and
 * with the span's own duration as the number. `terminal_fact` measures arrive
 * on the status transition that ends the simulation, inside its facts, and the
 * control plane records them under the catalog name — so a threshold grader
 * reads one vocabulary whether the number was timed or counted.
 */
export type MeasureOrigin = "timing_span" | "terminal_fact";

/**
 * How a measure is computed from a conversation's spans — the rule, as one of a
 * closed set.
 *
 * **A word rather than prose, because the shared measure module switches on it
 * and the switch is exhaustive.** A rule nothing implements stops the
 * TypeScript build, and a measure whose rule is `no_span_carries_it` is refused
 * at the write door instead of becoming a grader that is `skipped` forever. So
 * the list a form offers, the list a write accepts and the list the module can
 * answer are one list, and no two of them can drift apart.
 *
 * - `timing_spans_named_for_it` — every span the ingest door filed as `timing`
 *   whose name is this measure's own name. The span's own duration **is** the
 *   sample; nothing carries the number a second time, so nothing can disagree
 *   with the interval. A measure taken once has one such span, a per-turn
 *   measure has one per turn, and a conversation that never took it has none.
 * - `no_span_carries_it` — nothing in the trace holds this. It is still a real
 *   measure and still named here; it simply arrives somewhere else, and a
 *   grader may not name it, because a check reading a number that is never
 *   there is a check that can never fire.
 */
export const SPAN_RULES = [
  "timing_spans_named_for_it",
  "no_span_carries_it",
] as const;

export type SpanRule = (typeof SPAN_RULES)[number];

/** One measure's span-level definition: the rule, and the line a person reads. */
export type MeasureFromSpans = {
  readonly rule: SpanRule;
  /**
   * What the rule comes to for this measure, in the one line the catalog
   * document says it in — including, for a measure no span carries, where the
   * number does arrive instead.
   */
  readonly definition: string;
};

/** One measure, as both the write door and a person reading the catalog see it. */
export type CatalogedMeasure = {
  /** The name a grader writes, and the key on the row. */
  readonly measure: string;
  readonly unit: "milliseconds" | "hertz" | "turns";
  readonly taken: MeasureShape;
  readonly from: MeasureSource;
  readonly origin: MeasureOrigin;
  /**
   * How this measure is computed from a trace's spans — pinned here, beside the
   * name, so the catalog is the one place both halves of a measure live.
   */
  readonly fromSpans: MeasureFromSpans;
  /** What it is, in the one line the catalog document says it in. */
  readonly means: string;
  /**
   * The aggregations a threshold may ask of this measure.
   *
   * All eight for every measure today, and stated per measure rather than once
   * for all of them because the day a measure arrives that must never be summed
   * — a rate, a percentage — the refusal belongs in the catalog beside the
   * measure rather than in a rule somebody has to remember.
   */
  readonly aggregations: readonly MeasureAggregation[];
};

/** Every aggregation, which is what every measure named today accepts. */
const EVERY_AGGREGATION: readonly MeasureAggregation[] = MEASURE_AGGREGATIONS;

/**
 * The span-level definition every timing measure shares, said once.
 *
 * All five are the same rule with a different name in it, and writing the rule
 * out five times is how five copies of one sentence come to disagree.
 */
function timedByItsOwnSpan(measure: string): MeasureFromSpans {
  return {
    rule: "timing_spans_named_for_it",
    definition: `every span named \`${measure}\`; each span's own duration is one sample, in nanoseconds on the wire and milliseconds here`,
  };
}

/**
 * Everything egma measures today, in the order the catalog document lists them:
 * the timing measures first, then the counted and measured facts a finished
 * simulation carries.
 */
export const MEASURE_CATALOG: readonly CatalogedMeasure[] = [
  {
    measure: "first_response_latency",
    unit: "milliseconds",
    taken: "once",
    from: "every simulation",
    origin: "timing_span",
    fromSpans: timedByItsOwnSpan("first_response_latency"),
    means:
      "how long the agent took to say anything at all, from the moment the simulation began",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "turn_response_latency",
    unit: "milliseconds",
    taken: "per_turn",
    from: "every simulation",
    origin: "timing_span",
    fromSpans: timedByItsOwnSpan("turn_response_latency"),
    means:
      "how long the agent took to answer, measured once for every turn the persona took",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "time_to_first_word",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_span",
    fromSpans: timedByItsOwnSpan("time_to_first_word"),
    means:
      "the quiet before the agent's first word of an answer, measured out of the audio rather than off a clock",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "agent_speech_duration",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_span",
    fromSpans: timedByItsOwnSpan("agent_speech_duration"),
    means: "how long the agent spoke for, silence inside the answer excluded",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "persona_speech_duration",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_span",
    fromSpans: timedByItsOwnSpan("persona_speech_duration"),
    means:
      "how long egma's own synthetic caller spoke for — what the agent was made to listen to, not anything the agent did",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "turn_count",
    unit: "turns",
    taken: "once",
    from: "every simulation",
    origin: "terminal_fact",
    fromSpans: {
      // Countable from the turn spans, and deliberately not counted from them.
      // The number already arrives on the terminal transition and is read back
      // off the simulation row; a second way to work it out is a second answer,
      // and two counts of one conversation disagreeing is exactly what the one
      // shared module exists to make impossible.
      rule: "no_span_carries_it",
      definition:
        "no span carries it: the simulator counts the turns it conducted and reports the total on the terminal transition, where the simulation row keeps it",
    },
    means: "how many transcript turns the conversation reached, both speakers counted",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "measured_audio_band_hertz",
    unit: "hertz",
    taken: "once",
    from: "voice simulations",
    origin: "terminal_fact",
    fromSpans: {
      rule: "no_span_carries_it",
      definition:
        "no span carries it: the band is heard on the media line and reported on the terminal transition, where the simulation row keeps it beside the recording",
    },
    means:
      "the sample rate the simulator actually heard, negotiated or measured and never copied from configuration",
    aggregations: EVERY_AGGREGATION,
  },
];

/** Every cataloged name, for a refusal that can list what it would have taken. */
export const CATALOGED_MEASURES: readonly string[] = MEASURE_CATALOG.map(
  (cataloged) => cataloged.measure,
);

/**
 * The measures egma computes from a conversation's spans — the shorter list,
 * and the one that matters to anything judging.
 *
 * **Three surfaces read exactly this, which is the point of it existing.** The
 * shared measure module implements it, the **Use** form's dropdown offers it,
 * and the write door accepts it — so a developer cannot pick, and a write
 * cannot store, a measure nothing can answer. A measure named in the catalog
 * but absent here is one that arrives somewhere other than the trace: real,
 * readable where it lands, and not something a grader may bound.
 */
export const SPAN_DERIVED_MEASURE_CATALOG: readonly CatalogedMeasure[] =
  MEASURE_CATALOG.filter(
    (cataloged) => cataloged.fromSpans.rule !== "no_span_carries_it",
  );

/** The same list as names, for a form's options and a refusal's sentence. */
export const SPAN_DERIVED_MEASURES: readonly string[] =
  SPAN_DERIVED_MEASURE_CATALOG.map((cataloged) => cataloged.measure);

/**
 * Whether egma can compute this measure from a conversation's spans.
 *
 * The write door's question. It is narrower than `isCatalogedMeasure` on
 * purpose: a name in the catalog says egma has a number by that name
 * *somewhere*, and only this says a grader reading the trace will find one.
 */
export function isSpanDerivedMeasure(measure: string): boolean {
  const cataloged = BY_NAME.get(measure);
  return (
    cataloged !== undefined &&
    cataloged.fromSpans.rule !== "no_span_carries_it"
  );
}

/** The catalog by name, so a lookup is not a scan of a growing list. */
const BY_NAME = new Map(
  MEASURE_CATALOG.map((cataloged) => [cataloged.measure, cataloged]),
);

/** One measure, or `undefined` for a name the simulator never emits. */
export function catalogedMeasure(
  measure: string,
): CatalogedMeasure | undefined {
  return BY_NAME.get(measure);
}

/**
 * Whether the simulator emits this.
 *
 * The write door's question, asked in the catalog's own words so that no caller
 * has to know the list is an array — and so that the day a measure is deprecated
 * rather than deleted, "still accepted" and "still listed" can differ here and
 * nowhere else.
 */
export function isCatalogedMeasure(measure: string): boolean {
  return BY_NAME.has(measure);
}

/**
 * Whether this measure may be reduced this way. Every measure accepts every
 * aggregation today; the question is asked through the catalog anyway, because a
 * caller that read the list itself is a caller that would keep passing on the
 * day one measure stops accepting one.
 */
export function measureAccepts(
  measure: string,
  aggregation: string,
): boolean {
  const cataloged = BY_NAME.get(measure);
  if (cataloged === undefined) return false;
  return (cataloged.aggregations as readonly string[]).includes(aggregation);
}

/** Where the prose catalog lives, for a refusal that can point somebody at it. */
export const MEASURE_CATALOG_DOCUMENT =
  "packages/simulation-contract/measure-catalog.md";
