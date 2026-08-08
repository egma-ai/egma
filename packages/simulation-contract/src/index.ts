/**
 * The simulation contract, as TypeScript can hold it.
 *
 * Almost all of this contract is JSON — two schemas under `schemas/`, read by
 * both sides from disk, because the other reader of those bytes is not
 * TypeScript. What is here is what the control plane checks on its own side
 * of the wire: the measure catalog, which a grader's write door refuses an
 * unknown measure against, the spec check every outgoing claim answer passes
 * through before a byte of it is sent, and the report check every arriving
 * document passes through before a byte of it is believed.
 */

export { reportComplaints, specComplaints } from "./documents.ts";

export {
  catalogedMeasure,
  isCatalogedMeasure,
  measureAccepts,
  CATALOGED_MEASURES,
  MEASURE_AGGREGATIONS,
  MEASURE_CATALOG,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
  type CatalogedMeasure,
  type MeasureAggregation,
  type MeasureOrigin,
  type MeasureShape,
  type MeasureSource,
} from "./measures.ts";
