/**
 * The simulation contract, as TypeScript can hold it.
 *
 * Almost all of this contract is JSON — two schemas under `schemas/`, read by
 * both sides from disk, because the other reader of those bytes is not
 * TypeScript. What is here is what the control plane checks on its own side
 * of the wire: the measure catalog, which a grader's write door refuses an
 * unknown measure against, the spec check every outgoing claim answer passes
 * through before a byte of it is sent, the report check every arriving
 * document passes through before a byte of it is believed, and the one
 * derivation that turns a simulation id into the trace its spans are filed
 * under.
 */

export { reportComplaints, specComplaints } from "./documents.ts";

export {
  simulationIdOfTrace,
  traceIdOfSimulation,
} from "./trace-identity.ts";

export {
  bannedWordIn,
  BANNED_MOCK_TOOL_WORDS,
  type BannedWord,
  type BannedWordFound,
} from "./vocabulary.ts";

export {
  catalogedMeasure,
  isCatalogedMeasure,
  isSpanDerivedMeasure,
  measureAccepts,
  CATALOGED_MEASURES,
  MEASURE_AGGREGATIONS,
  MEASURE_CATALOG,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
  SPAN_DERIVED_MEASURE_CATALOG,
  SPAN_DERIVED_MEASURES,
  SPAN_RULES,
  type CatalogedMeasure,
  type MeasureAggregation,
  type MeasureFromSpans,
  type MeasureOrigin,
  type MeasureShape,
  type MeasureSource,
  type SpanRule,
} from "./measures.ts";
