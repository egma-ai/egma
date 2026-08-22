import type { FastifyBaseLogger } from "fastify";

import { UnreadableSegmentError, type SegmentDefect } from "./verify.ts";

/**
 * An accepted segment this Egma could not turn into rows, and what is done
 * about it: **nothing is deleted, and an operator is told.**
 *
 * The rule is one sentence and everything here follows from it. *Egma promised
 * this evidence was safe before it ever read it back.* The request was answered
 * `200`, the sender stopped owing the bytes, and the local copy is long gone —
 * so an object that then turns out to be corrupt, to state a version this build
 * does not read, or to disagree with evidence already stored is **Egma's
 * problem, permanently**. It is not a validation failure, because the moment to
 * refuse customer input passed at the door. It is not a reason to delete
 * anything, because deleting it is the one action nobody can undo. The object
 * stays under its key, retained and visible, and a person decides.
 *
 * Automatic deletion of a retained object is deliberately out of scope: the
 * repair or the explicit discard is operational work somebody chooses to do.
 *
 * ## One event and one metric, and the shape of both
 *
 * A defect is reported twice, on purpose, because two different people need it.
 * The **event** is for whoever is going to go and look at the object: it names
 * the key, so it can be found. The **metric** is for whoever is watching a
 * deployment: it carries the reason class and nothing else — no key, no
 * organization, no project, no segment id — because every one of those is
 * unbounded, and an unbounded metric label is how a monitoring system is taken
 * down by the incident it was supposed to report.
 *
 * ## What is never in either
 *
 * No evidence value and no credential. Not a transcript, not a tool argument,
 * not a payload, not an access key. A log line is copied into places a sealed
 * object is not, and the reason this release stopped rewriting evidence is the
 * same reason it must not print it.
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
  /** The trace store refused these rows and would refuse the same bytes again. */
  | "store_refused";

/** The one event name a retained defect is reported under. */
export const RETAINED_DEFECT_EVENT = "ingestion.segment.retained";

/** And the one metric it is counted in, by reason class alone. */
export const RETAINED_DEFECT_METRIC = "ingestion_segment_retained_total";

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

/** What this process has retained, by reason. For the operator surfaces. */
export function retainedDefects(): ReadonlyMap<IngestionDefect, number> {
  return new Map(counted);
}

/** Forget the counts. For a suite that asserts one pass in isolation. */
export function forgetRetainedDefects(): void {
  counted.clear();
}
