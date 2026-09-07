/**
 * Agent-platform measurements normalized into the root span payload under
 * egma_normalised.reported_measurements. Store raw samples, not vendor
 * percentiles, so @egma/metrics computes reductions consistently.
 * Use catalog names only for equivalent measures; retain platform-prefixed
 * names for other measurements. Parsing malformed input does not throw.
 */

/**
 * Which shape of this block a writer wrote.
 *
 * Bumped when a field joins, leaves or changes meaning — the discipline every
 * versioned contract in this repository carries, so a reader can tell a block
 * it predates from a block that is broken.
 */
export const REPORTED_MEASUREMENTS_VERSION = 1;

/** One measure as the platform reported it: the raw series, in the catalog's
 * name when the meaning matches and a platform-prefixed one when it does not. */
export type ReportedMeasurement = {
  readonly measure: string;
  /** The unit the values are stated in — the catalog's own word for a
   * catalog-named measure, the platform's honest word otherwise. */
  readonly unit: string;
  /** The individual measurements, in the order the platform reported them.
   * Never empty: a measure the platform did not take is absent instead. */
  readonly values: readonly number[];
};

/** The whole block: who reported, and everything they reported. */
export type ReportedMeasurements = {
  readonly version: typeof REPORTED_MEASUREMENTS_VERSION;
  /** The agent platform that measured — `retell`. This records provider
   * provenance and gives a rationale the correct platform name to print. */
  readonly reportedBy: string;
  readonly measurements: readonly ReportedMeasurement[];
};

/**
 * The block's key inside a span's payload, snake_cased like everything else
 * that rides one. Exported because a normalizer embeds the block under this
 * exact name and the read side looks it up by the same one — two modules
 * spelling it independently is the drift this file exists to rule out.
 */
export const REPORTED_MEASUREMENTS_PAYLOAD_KEY = "reported_measurements";

/** Where the block rides: `payload.egma_normalised.reported_measurements`. */
export const REPORTED_MEASUREMENTS_PAYLOAD_PATH =
  `egma_normalised.${REPORTED_MEASUREMENTS_PAYLOAD_KEY}`;

/**
 * The block a normalizer wants to write, as the payload object it embeds.
 *
 * The inverse of `reportedMeasurementsOf`, kept beside it so the two casings
 * are one file's concern. Returns `undefined` rather than an empty block when
 * there is nothing to report — absence is the honest shape for a trace whose
 * platform measured nothing, and it is what keeps replayed normalisation
 * byte-identical with what was first written.
 */
export function reportedMeasurementsPayload(
  reportedBy: string,
  measurements: readonly ReportedMeasurement[],
): Record<string, unknown> | undefined {
  const kept = measurements.filter((measurement) => measurement.values.length > 0);
  if (kept.length === 0) return undefined;
  return {
    version: REPORTED_MEASUREMENTS_VERSION,
    reported_by: reportedBy,
    measurements: kept.map((measurement) => ({
      measure: measurement.measure,
      unit: measurement.unit,
      values: measurement.values,
    })),
  };
}

/**
 * Parse a supported measurement block without throwing. Skip malformed
 * entries and nonfinite values; preserve other valid samples. Return undefined
 * for an invalid block or one with no usable measurements.
 */
export function reportedMeasurementsOf(
  held: unknown,
): ReportedMeasurements | undefined {
  if (typeof held !== "object" || held === null || Array.isArray(held)) {
    return undefined;
  }
  const block = held as Record<string, unknown>;
  if (block["version"] !== REPORTED_MEASUREMENTS_VERSION) return undefined;
  const reportedBy = block["reported_by"];
  if (typeof reportedBy !== "string" || reportedBy === "") return undefined;
  if (!Array.isArray(block["measurements"])) return undefined;

  const measurements: ReportedMeasurement[] = [];
  for (const entry of block["measurements"]) {
    if (typeof entry !== "object" || entry === null) continue;
    const measurement = entry as Record<string, unknown>;
    const measure = measurement["measure"];
    const unit = measurement["unit"];
    if (typeof measure !== "string" || measure === "") continue;
    if (typeof unit !== "string" || unit === "") continue;
    if (!Array.isArray(measurement["values"])) continue;
    const values = measurement["values"].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (values.length === 0) continue;
    measurements.push({ measure, unit, values });
  }
  if (measurements.length === 0) return undefined;
  return { version: REPORTED_MEASUREMENTS_VERSION, reportedBy, measurements };
}
