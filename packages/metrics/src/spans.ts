/**
 * Minimal stored-span fields needed for metric computation. Kept structural
 * so the data-access module can supply richer rows without a reverse dependency.
 */

import type { ReportedMeasurement } from "./reported.ts";

/**
 * One span as the measure module reads it: identity, kind, when it began, how
 * long it ran, and the spans beneath it. Timing fields are strings because
 * that is how the trace read answers them — RFC 3339 to the microsecond for
 * the start, nanoseconds as decimal text for the duration — and parsing them
 * is this package's own careful job.
 */
export type TraceSpan = {
  readonly spanId: string;
  /** As it arrived. `""` on a root, and that emptiness is how a root is
   * recognised — by its place in the tree, never by a kind word each platform
   * spells its own way. */
  readonly parentSpanId: string;
  /**
   * Span POV, used to keep the agent and persona evidence separate.
   * Absent emitter is treated as agent POV for older span shapes.
   */
  readonly pov?: "persona" | "agent" | undefined;
  readonly name: string;
  readonly kind: string;
  readonly startedAt: string;
  readonly durationNanoseconds: string;
  readonly spans: readonly TraceSpan[];
};

/**
 * What an agent platform reported about a conversation, as the trace read
 * lifted it off the root span: who reported, the measurements themselves, and
 * the span the block rode in on — which is the span every reported sample
 * cites, there being no narrower event to point at.
 */
export type ReportedOnTrace = {
  readonly spanId: string;
  readonly reportedBy: string;
  readonly measurements: readonly ReportedMeasurement[];
};
