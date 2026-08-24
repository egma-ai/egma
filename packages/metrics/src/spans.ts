/**
 * The slice of a stored conversation this package reads.
 *
 * **Structural on purpose, and narrower than the store's own span row.** The
 * measure module computes over exactly these fields; everything else a trace
 * read carries — text, audio references, tool payloads — is a display's
 * business, not arithmetic's. Declaring only what is read keeps the store's
 * fuller span shape assignable here without this package depending on the
 * data-access module, which depends on this one.
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
