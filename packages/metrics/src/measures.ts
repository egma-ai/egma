/**
 * Measure names, units, and span-level definitions used by @egma/metrics.
 * The catalog is code, not a database table. measure-catalog.md documents
 * the same definitions, and contract tests keep the two aligned.
 */

/**
 * Bump when a measure is added, removed, or changes meaning, including POV
 * precedence or span-level definitions. Update measure-catalog.md together.
 * Changing this constant does not select a historical implementation.
 */
export const MEASURE_CATALOG_VERSION = 9;

/**
 * Measures that prefer agent POV when both POVs exist. An empty list prefers
 * persona POV, with agent POV still available as otherPov. Change this policy
 * with the catalog version.
 */
export const AGENT_POV_HEADLINE_MEASURES: readonly string[] = [];

/** Supported reductions of a metric series to one observed number. */
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

/** Which conversations produce a measure at all. The stage latencies come
 * from the agent's platform rather than from egma's own conducting, so a
 * simulation carries them only when the platform's telemetry reaches egma. */
export type MeasureSource =
  | "every simulation"
  | "voice simulations"
  | "the agent's platform";

/**
 * Wire origin: timing_span uses span durations; terminal_fact arrives with
 * simulation completion; platform_telemetry comes from the agent platform
 * as stage spans or reported measurements.
 */
export type MeasureOrigin =
  | "timing_span"
  | "terminal_fact"
  | "platform_telemetry";

/**
 * Closed set of span-level derivation rules. timing_spans_named_for_it uses
 * named timing-span durations; platform_telemetry_carries_it uses framework
 * spans or reported measurements; no_span_carries_it has no trace derivation.
 * The shared measure module handles the rules exhaustively. Missing required
 * metrics cause grading errors, not failed judgments.
 */
export const SPAN_RULES = [
  "timing_spans_named_for_it",
  "no_span_carries_it",
  "platform_telemetry_carries_it",
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
 * They are the same rule with a different name in it, and writing the rule out
 * once per measure is how several copies of one sentence come to disagree.
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
      "how long the agent took to answer: from the last audible sample of the caller's speech in the turn to the first audible sample of the agent's reply as it reaches the caller, once for every turn the agent answered",
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
    measure: "asr_latency",
    unit: "milliseconds",
    taken: "per_turn",
    from: "the agent's platform",
    origin: "platform_telemetry",
    fromSpans: {
      rule: "platform_telemetry_carries_it",
      definition:
        "how long the platform's speech recognition took, as the platform accounts for it: reported per call by Retell (its `asr` stage); no recognised framework span carries it today, so it is never derived",
    },
    means:
      "how long the agent's platform spent turning the caller's speech into text, by the platform's own account",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "llm_latency",
    unit: "milliseconds",
    taken: "per_turn",
    from: "the agent's platform",
    origin: "platform_telemetry",
    fromSpans: {
      rule: "platform_telemetry_carries_it",
      definition:
        "how long the agent's language model took, as the platform accounts for it: the sum of a `turn:agent` span's own model-step children per turn on a recognised framework, or the platform's reported `llm` stage",
    },
    means:
      "how long the agent's platform spent thinking — the language-model step of an answer, by the platform's own account",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "tts_latency",
    unit: "milliseconds",
    taken: "per_turn",
    from: "the agent's platform",
    origin: "platform_telemetry",
    fromSpans: {
      rule: "platform_telemetry_carries_it",
      definition:
        "how long the platform's speech synthesis took, as the platform accounts for it: the sum of a `turn:agent` span's own synthesis-step children per turn on a recognised framework, or the platform's reported `tts` stage",
    },
    means:
      "how long the agent's platform spent turning the answer's text into speech, by the platform's own account",
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
];

/** Every cataloged name, for a refusal that can list what it would have taken. */
export const CATALOGED_MEASURES: readonly string[] = MEASURE_CATALOG.map(
  (cataloged) => cataloged.measure,
);

/**
 * Catalog measures that can be computed from trace evidence. Excludes
 * measures whose values arrive only outside spans or reported measurements.
 */
export const SPAN_DERIVED_MEASURE_CATALOG: readonly CatalogedMeasure[] =
  MEASURE_CATALOG.filter(
    (cataloged) => cataloged.fromSpans.rule !== "no_span_carries_it",
  );

/** The same list as names, for a form's options and a refusal's sentence. */
export const SPAN_DERIVED_MEASURES: readonly string[] =
  SPAN_DERIVED_MEASURE_CATALOG.map((cataloged) => cataloged.measure);

/**
 * The measures that arrive as egma's own timing spans — the emitter contract's
 * half of the catalog, and the only list the ingest door files as `timing` for
 * the simulator's scope. Narrower than `SPAN_DERIVED_MEASURES` on purpose: a
 * stage latency is computable from a trace and gradeable, but nothing of
 * egma's ever emits a timing span named for it, and a door that filed one
 * would be inventing a vocabulary no emitter speaks.
 */
export const TIMING_SPAN_MEASURES: readonly string[] = MEASURE_CATALOG.filter(
  (cataloged) => cataloged.fromSpans.rule === "timing_spans_named_for_it",
).map((cataloged) => cataloged.measure);

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
  "packages/metrics/measure-catalog.md";
