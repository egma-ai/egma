/**
 * The measure catalog and pure metric computation shared by grading and the UI.
 * Inputs are fetched spans and reported measurements; this package performs
 * no store access and does not depend on the data-access module.
 */

export {
  catalogedMeasure,
  isCatalogedMeasure,
  isSpanDerivedMeasure,
  measureAccepts,
  AGENT_POV_HEADLINE_MEASURES,
  CATALOGED_MEASURES,
  MEASURE_AGGREGATIONS,
  MEASURE_CATALOG,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
  SPAN_DERIVED_MEASURE_CATALOG,
  SPAN_DERIVED_MEASURES,
  SPAN_RULES,
  TIMING_SPAN_MEASURES,
  type CatalogedMeasure,
  type MeasureAggregation,
  type MeasureFromSpans,
  type MeasureOrigin,
  type MeasureShape,
  type MeasureSource,
  type SpanRule,
} from "./measures.ts";

export {
  aggregateOf,
  p90Of,
  everySpanIn,
  measuresFromSpans,
  povOfOrigin,
  turnResponseLatencySpanKinds,
  worstSampleOf,
  type MeasuredByOnePov,
  type MeasuredFromSpans,
  type Sample,
  type SpannedConversation,
} from "./from-spans.ts";

export {
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  REPORTED_MEASUREMENTS_PAYLOAD_PATH,
  REPORTED_MEASUREMENTS_VERSION,
  reportedMeasurementsOf,
  reportedMeasurementsPayload,
  type ReportedMeasurement,
  type ReportedMeasurements,
} from "./reported.ts";

export { type ReportedOnTrace, type TraceSpan } from "./spans.ts";
