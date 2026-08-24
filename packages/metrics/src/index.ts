/**
 * Egma's observed metrics: the catalog that names what is measured, and the
 * one shared measure module that computes it.
 *
 * A metric measures and a grader judges. This package is the measuring half,
 * whole: the versioned measure catalog (`measure-catalog.md` beside this
 * source, `measures.ts` as the constant), the arithmetic that reads a
 * conversation's spans and answers the catalog's numbers, and the neutral
 * reported-measurements block an agent platform's own numbers arrive in. One
 * computation path serves the metrics display and the grading service, for a
 * simulation and a production trace alike — so the number on a page and the
 * number a verdict was decided by are the same arithmetic, and a second
 * implementation anywhere would be a second answer about one conversation.
 *
 * It reaches nothing: rows a caller already fetched go in, numbers come out.
 * No driver, no `AuthContext`, no dependency on the data-access module — the
 * data-access module depends on this.
 */

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

export {
  everySpanIn,
  meanOf,
  measuresFromSpans,
  worstSampleOf,
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
