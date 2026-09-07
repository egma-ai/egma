import { UnreadableTraceQueryError } from "@egma/db";
import { metrics as openTelemetryMetrics } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";

import { UnreadableSegmentError, type SegmentDefect } from "./verify.ts";

/**
 * Retain accepted objects that cannot be drained; repair or discard requires
 * operator action. Log the object key and reason without evidence values or
 * credentials. Metrics use only the bounded reason class, never object or
 * customer identifiers.
 */

/**
 * The little of a logger this path uses, named rather than taken whole.
 *
 * Draining reports two things — something was left behind, and something did
 * not work this time — so it asks for two methods. Fastify's own logger
 * satisfies it without being mentioned at a call site, and nothing here can
 * quietly start depending on a child logger, a level or a serializer.
 */
export type IngestionLog = Pick<FastifyBaseLogger, "warn" | "error">;

/** How a defect is named wherever it is counted. One stable, low-cardinality set. */
export type IngestionDefect =
  | SegmentDefect
  /**
   * The store already holds one of these spans with different content. The
   * stored evidence stays authoritative and this object is retained; see
   * `drainer.ts` for why the first account wins.
   */
  | "identity_conflict"
  /**
   * The header names a project that is not its organization's. The checksum
   * covers that binding, so the pair is the one the segment was sealed with —
   * and it is a pair the control database has never agreed to.
   */
  | "impossible_tenant_binding"
  /**
   * The header names a project that was this organization's and has since been
   * archived. The pair was real when the evidence arrived, so this is a project
   * removed after acceptance rather than a binding that could never exist — a
   * different fact for an operator, and one whose evidence is still retained.
   */
  | "project_deleted"
  /** The trace store refused these rows and would refuse the same bytes again. */
  | "store_refused"
  /**
   * A span begins at an instant the trace store cannot hold, so the read probe
   * that guards every replay cannot build a window around it. The door refuses
   * such a record before staging; one that reached a segment another way is
   * retained here.
   */
  | "unstorable_instant"
  /**
   * A defect this build did not recognise the shape of. Retained and counted
   * rather than retried in silence, so an accepted segment that cannot be
   * drained is always a number an operator can see rather than one more GET
   * every scan.
   */
  | "internal_defect";

/** The one event name a retained defect is reported under. */
export const RETAINED_DEFECT_EVENT = "ingestion.segment.retained";

/** And the one metric it is counted in, by reason class alone. */
export const RETAINED_DEFECT_METRIC = "ingestion_segment_retained_total";

const meter = openTelemetryMetrics.getMeter("@egma/api/ingestion");

/**
 * Retained objects as a series, by reason class and nothing else — the raw
 * count the unauthenticated health body does not carry. The reason class is the
 * one label, for the same reason the log line is the only place a key appears:
 * a key, an organization or a segment id is an unbounded label, and the first
 * bucket full of damaged objects would be the one that took the metrics down.
 */
const retainedDefectTotal = meter.createCounter("egma.ingestion.segment.retained", {
  description: "Accepted segments retained as internal defects, by reason class",
});

/** How many retained objects this process has seen, by reason. */
const counted = new Map<IngestionDefect, number>();

/**
 * Report one retained object.
 *
 * Called where the drainer gives up on an object and leaves it, which is every
 * place it cannot make progress that is not simply *not yet*. A store that is
 * unreachable is not a defect and is not reported here — the object is pending,
 * the next pass takes it, and counting that as retained would turn a ClickHouse
 * restart into a page about corrupt evidence.
 */
export function retainedDefect(
  log: IngestionLog,
  defect: IngestionDefect,
  key: string,
  cause: unknown,
): void {
  counted.set(defect, (counted.get(defect) ?? 0) + 1);
  retainedDefectTotal.add(1, { reason: defect });
  log.error(
    {
      event: RETAINED_DEFECT_EVENT,
      metric: RETAINED_DEFECT_METRIC,
      reason: defect,
      key,
      // The error's own class, which is a bounded set of names this codebase
      // wrote. Never its message: a message can carry a store's echo of a row.
      errorName: cause instanceof Error ? cause.name : typeof cause,
    },
    "an accepted segment could not be drained and has been retained for repair",
  );
}

/** The reason class one unreadable object is counted under. */
export function defectOf(cause: unknown): IngestionDefect | undefined {
  return cause instanceof UnreadableSegmentError ? cause.reason : undefined;
}

/**
 * Classify retryable drain failures by string error codes, known connection
 * messages, or timeout/network error names, including wrapped causes.
 * Callers handle known permanent error classes first. This is a heuristic;
 * a code alone does not prove that an error will resolve.
 */
export function isTransientDrainFailure(cause: unknown): boolean {
  for (
    let error: unknown = cause, depth = 0;
    error !== null && typeof error === "object" && depth < 8;
    depth += 1
  ) {
    if (
      error instanceof Error &&
      /not connected to (?:ClickHouse|Postgres)/.test(error.message)
    ) {
      return true;
    }
    const held = error as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof held.code === "string") return true;
    if (
      typeof held.name === "string" &&
      /Timeout|Abort|Network|Connection/.test(held.name)
    ) {
      return true;
    }
    if (held.cause === error) break;
    error = held.cause;
  }
  return false;
}

/**
 * The reason class a retained drain failure is counted under, when its own
 * block has not already named a more precise one.
 *
 * An instant the store cannot hold is named as such — it reaches the drainer as
 * the read probe refusing to build a window, or the row encoder refusing the
 * value — and everything else this build did not recognise is an internal
 * defect. Both are retained; the reason is what an operator reads.
 */
export function retainedReasonFor(cause: unknown): IngestionDefect {
  if (cause instanceof UnreadableTraceQueryError || cause instanceof RangeError) {
    return "unstorable_instant";
  }
  return "internal_defect";
}

/** What this process has retained, by reason. For the operator surfaces. */
export function retainedDefects(): ReadonlyMap<IngestionDefect, number> {
  return new Map(counted);
}

/** Forget the counts. For a suite that asserts one pass in isolation. */
export function forgetRetainedDefects(): void {
  counted.clear();
}
