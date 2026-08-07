/**
 * The measure catalog: every measure a simulation produces, named once.
 *
 * **A contract document, not a table.** Nothing writes a row to declare a
 * measure and nothing queries for the list — it is a fact about what the
 * simulator emits, so it lives beside the two schemas that are the other facts
 * about what the simulator emits, and it is read by the control plane the same
 * way the schemas are: at the write door, before anything is stored.
 *
 * The catalog exists because of one failure it rules out. A `metric_threshold`
 * grader names the measure it reads as a string, and a string that names nothing
 * produces a grader that reads nothing, judges nothing, and is `skipped` forever
 * — green, silent, and wrong. That is the exact false trust egma exists to kill,
 * so the write door refuses a measure this file does not name. A typo is a
 * refusal at the moment it is written rather than a check that quietly never
 * fires.
 *
 * `measure-catalog.md` beside this file is the same catalog in prose, for a
 * person deciding what to threshold. The two are held to each other by the
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
 */
export const MEASURE_CATALOG_VERSION = 1;

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
 * `timing_event` measures arrive as their own report events, one per
 * measurement, under exactly the name in this catalog. `terminal_fact` measures
 * arrive on the status transition that ends the simulation, inside its facts,
 * and the control plane records them under the catalog name — so a threshold
 * grader reads one vocabulary whether the number was timed or counted.
 */
export type MeasureOrigin = "timing_event" | "terminal_fact";

/** One measure, as both the write door and a person reading the catalog see it. */
export type CatalogedMeasure = {
  /** The name a `metric_threshold` grader writes, and the key on the row. */
  readonly measure: string;
  readonly unit: "milliseconds" | "hertz" | "turns";
  readonly taken: MeasureShape;
  readonly from: MeasureSource;
  readonly origin: MeasureOrigin;
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
 * Everything the simulator measures today, in the order the catalog document
 * lists them: the timing measures first, then the counted and measured facts a
 * finished simulation carries.
 */
export const MEASURE_CATALOG: readonly CatalogedMeasure[] = [
  {
    measure: "first_response_latency",
    unit: "milliseconds",
    taken: "once",
    from: "every simulation",
    origin: "timing_event",
    means:
      "how long the agent took to say anything at all, from the moment the simulation began",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "turn_response_latency",
    unit: "milliseconds",
    taken: "per_turn",
    from: "every simulation",
    origin: "timing_event",
    means:
      "how long the agent took to answer, measured once for every turn the persona took",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "time_to_first_word",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_event",
    means:
      "the quiet before the agent's first word of an answer, measured out of the audio rather than off a clock",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "agent_speech_duration",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_event",
    means: "how long the agent spoke for, silence inside the answer excluded",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "persona_speech_duration",
    unit: "milliseconds",
    taken: "per_turn",
    from: "voice simulations",
    origin: "timing_event",
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
    means: "how many transcript turns the conversation reached, both speakers counted",
    aggregations: EVERY_AGGREGATION,
  },
  {
    measure: "measured_audio_band_hertz",
    unit: "hertz",
    taken: "once",
    from: "voice simulations",
    origin: "terminal_fact",
    means:
      "the sample rate the simulator actually heard, negotiated or measured and never copied from configuration",
    aggregations: EVERY_AGGREGATION,
  },
];

/** Every cataloged name, for a refusal that can list what it would have taken. */
export const CATALOGED_MEASURES: readonly string[] = MEASURE_CATALOG.map(
  (cataloged) => cataloged.measure,
);

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
