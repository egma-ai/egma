import type { TraceDetail } from "@egma/db";
import {
  aggregateOf,
  measuresFromSpans,
  povOfOrigin,
  type MeasuredByOnePov,
} from "@egma/metrics";

/**
 * Shared metric response for simulation evidence and production trace reads.
 * @egma/metrics computes samples and reductions from timed, derived, or reported
 * measurements. Mark span-derived values partial when the read is truncated;
 * reported measurements describe the whole trace and are not marked partial.
 */
export function describedMetrics(
  detail: TraceDetail,
): readonly Record<string, unknown>[] {
  return measuresFromSpans(detail).map((measured) => {
    const mean = aggregateOf(measured, "mean");
    const p50 = aggregateOf(measured, "p50");
    const p90 = aggregateOf(measured, "p90");
    return {
      measure: measured.measure,
      unit: measured.unit,
      // False means egma timed it; true means egma did not. Which of the two
      // untimed sources it was — a derivation off the framework's own spans,
      // or a number the platform handed egma — is `reportedBy` below, present
      // only on the second.
      derived: measured.origin !== "timed",
      // Whose account this number is — the persona's, measured off egma's own
      // recording, or the agent's, off its own process. `derived` says which
      // machinery produced it; this says whose conversation it describes, and
      // catalog version 8 makes that the fact that decides whether two numbers
      // may be compared at all.
      pov: povOfOrigin(measured.origin),
      ...(measured.origin === "reported"
        ? { reportedBy: measured.reportedBy }
        : {}),
      samples: measured.samples.map((sample) => sample.value),
      spanIds: measured.samples.map((sample) => sample.spanId),
      // The three reductions a page may lead with: the typical turn (median),
      // the tail the caller feels (p90), and the average. Which one a surface
      // shows is that surface's decision; the arithmetic is only here. The
      // zero fallbacks are unreachable — a measure with no samples is absent
      // from the module's answer — and sent rather than assumed away, because
      // the alternative is a client inventing a figure.
      mean: mean ?? 0,
      p50: p50 ?? 0,
      p90: p90 ?? 0,
      partial: measured.origin === "reported" ? false : detail.truncated,
      // **The second POV, where a conversation has one.** A simulation is
      // measured twice — by egma off its own recording, and by the agent off
      // its own spans — and the two differ by the VAD's detection lag and the
      // playback hop. Both series ride the wire, the headline above and the
      // other here, so a reader can show either and nothing has to average
      // them into a number nobody measured. Absent on every conversation only
      // one POV measured, which is every production trace.
      ...(measured.otherPov === undefined
        ? {}
        : { otherPov: describedPov(measured.otherPov, detail.truncated) }),
    };
  });
}

/** One POV's series on the wire, named the way the headline names its own. */
function describedPov(
  measured: MeasuredByOnePov,
  truncated: boolean,
): Record<string, unknown> {
  return {
    pov: povOfOrigin(measured.origin),
    derived: measured.origin !== "timed",
    ...(measured.origin === "reported"
      ? { reportedBy: measured.reportedBy }
      : {}),
    samples: measured.samples.map((sample) => sample.value),
    spanIds: measured.samples.map((sample) => sample.spanId),
    partial: measured.origin === "reported" ? false : truncated,
  };
}
