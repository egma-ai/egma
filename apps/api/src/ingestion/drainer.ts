import {
  appendSpans,
  priceUsageSpans,
  committedSpans,
  AGENT_PLATFORMS,
  projectOfOrganizationState,
  recordPulledCallReceived,
  recordProductionTraces,
  recordSimulationTraces,
  TraceStoreRefusedError,
  type AuthContext,
  type AgentPlatform,
  type NewSpan,
} from "@egma/db";
import { mintedAt } from "@egma/ids";
import { metrics as openTelemetryMetrics } from "@opentelemetry/api";

import {
  defectOf,
  isTransientDrainFailure,
  retainedDefect,
  retainedReasonFor,
  type IngestionDefect,
  type IngestionLog,
} from "./defects.ts";
import type { PendingObjectStore } from "@egma/ingestion";
import { contentHashOf, recordFor, spanFor, type IngestionRecord } from "@egma/ingestion";
import { segmentIdIn, type SegmentScope } from "@egma/ingestion";
import { verifiedSegment, type VerifiedSegment } from "./verify.ts";

const meter = openTelemetryMetrics.getMeter("@egma/api/ingestion-drainer");
const objectsDrained = meter.createCounter("egma.ingestion.drain.objects.drained", {
  description: "Pending objects drained and deleted",
});
const drainFailures = meter.createCounter("egma.ingestion.drain.failures", {
  description: "Drain steps that left an object pending to be tried again",
});

/**
 * The backlog as a level rather than an event: how many pending objects have
 * work still owed on them, and how old the oldest is. One active drainer serves
 * a deployment, so the module holds the latest snapshot each pass writes and the
 * gauges read it — the raw numbers the unauthenticated health body does not
 * carry.
 */
let latestBacklog: { pending: number; oldestAgeMilliseconds: number } = {
  pending: 0,
  oldestAgeMilliseconds: 0,
};

meter
  .createObservableGauge("egma.ingestion.drain.pending.count", {
    description: "Pending objects with drain work still owed on them",
  })
  .addCallback((result) => result.observe(latestBacklog.pending));

meter
  .createObservableGauge("egma.ingestion.drain.pending.oldest_age", {
    description: "Age of the oldest pending object with work owed",
    unit: "ms",
  })
  .addCallback((result) =>
    result.observe(latestBacklog.oldestAgeMilliseconds),
  );

/**
 * Drain pending objects sequentially. Full bucket scans recover work missed
 * by upload hints; hints improve latency but are not the work record.
 *
 * For each object: verify its format and scope, check committed fingerprints,
 * write spans, update monitoring and trace records, then delete the object.
 * Known conflicting evidence is retained before writes. Legacy rows without
 * fingerprints stay authoritative and are skipped during insertion.
 *
 * Retryable failures leave the object for another pass. Permanent defects
 * remain for operator repair and are skipped by this process. Follow-up
 * writes must support replay because deletion can fail after they succeed.
 * Production supplies a deployment ownership lock; schema readiness and
 * ownership are checked before draining.
 */

export type DrainerOptions = {
  readonly store: PendingObjectStore;
  readonly log: IngestionLog;
  /** How often the whole pending prefix is listed. The startup scan is extra. */
  readonly scanIntervalMilliseconds: number;
  /**
   * The deployment's one drain claim, asked before every pass.
   *
   * A process that does not hold it lists nothing and writes nothing; it asks
   * again on the next interval, so whoever is holding it can die and be
   * replaced without anybody deciding that. A drainer given none of these owns
   * the prefix unconditionally, which is what a suite driving one process
   * wants and what a deployment must never rely on.
   */
  readonly ownership?:
    | { take(): Promise<boolean>; unlock(): Promise<void> }
    | undefined;
  /**
   * Whether the trace store's own schema is ready, asked before every pass.
   *
   * ClickHouse migrations no longer gate the process — an instance that cannot
   * reach ClickHouse still accepts evidence, which is the whole point of the
   * durable boundary — so the drainer has to ask instead of assume. Writing a
   * segment into a schema that is still being built is how a good object
   * becomes a retained defect for a reason that had nothing to do with it.
   */
  readonly traceStoreReady?: (() => boolean) | undefined;
};

/** Why a drain pass did nothing, when it did nothing on purpose. */
export type DrainStandby = "standby" | "trace_store_migrating";

/**
 * Drain progress for metrics and health detail. Stalled means pending work
 * without progress across consecutive passes; it does not itself make
 * acceptance unavailable.
 */
export type DrainHealth = {
  /** Why this pass did nothing on purpose, or `undefined` when it is draining. */
  readonly standby: DrainStandby | undefined;
  /** Pending objects this process has work to do on, retained defects aside. */
  readonly pending: number;
  /** Age of the oldest such object, in milliseconds, or `0` for none. */
  readonly oldestPendingAgeMilliseconds: number;
  /** Passes in a row that had work and drained nothing of it. */
  readonly consecutiveFailures: number;
  /** Whether the drain is making no progress on work it can see. */
  readonly stalled: boolean;
};

/** A pass that had work and drained none of it this many times is stalled. */
const STALL_AFTER_CONSECUTIVE_FAILURES = 1;

export type Drainer = {
  /**
   * A segment just became durable. A **speed hint**: losing it costs a scan
   * interval and never an object, which is why nothing here answers whether the
   * key was taken.
   */
  wake(key: string): void;
  /**
   * List the whole pending prefix and drain everything in it, then answer how
   * many objects were deleted.
   *
   * The recovery path, and what the interval calls. Also the seam a suite drives
   * when it wants one pass to have finished rather than to have started.
   */
  drainNow(): Promise<number>;
  /**
   * Why this process is not draining, or `undefined` when it is.
   *
   * What the health surface reports as the drain component. `"standby"` is a
   * second `all` or `drain` instance behaving exactly as intended, and is not a
   * failure of anything.
   */
  standingBy(): DrainStandby | undefined;
  /**
   * The drain component as the health surface reads it: the standby reason if
   * any, the pending backlog, and whether the drain is stalled on work it
   * cannot make progress on. The status code turns on none of it.
   */
  health(): DrainHealth;
  stop(): Promise<void>;
};

type Running = {
  readonly options: DrainerOptions;
  /** Keys handed over by a successful upload and not yet tried. */
  readonly hinted: Set<string>;
  /**
   * Retained keys already reported by this process are skipped. Restart
   * clears this set so repaired objects can be checked again.
   */
  readonly retained: Set<string>;
  timer: NodeJS.Timeout | undefined;
  /** The tail of the pass chain. Passes never overlap. */
  chain: Promise<number>;
  /** A pass that is waiting to start, so callers arriving together share it. */
  waiting: Promise<number> | undefined;
  /** Why the last pass did nothing on purpose, for the health surface. */
  standby: DrainStandby | undefined;
  /** Objects the last pass had work to do on, retained defects aside. */
  pending: number;
  /** When the oldest such object was minted, or `undefined` for none. */
  oldestPendingAtMilliseconds: number | undefined;
  /** Passes in a row that had work and drained nothing of it. */
  consecutiveFailures: number;
  stopped: boolean;
};

/** Who the drainer is, wherever a context has to name somebody. */
const INTERNAL_USER = "ingestion-drainer";

/**
 * Build a member/monitoring context from the verified segment header.
 * The drainer checks the project-organization relation in PostgreSQL before
 * writing. Evidence attributes and the object key do not choose scope.
 */
function authFor(scope: SegmentScope): AuthContext {
  return {
    userId: INTERNAL_USER,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    role: "member",
    via: "monitoring",
  };
}

/**
 * Wide enough to hold every span this segment carries, and no wider.
 *
 * Measured off the evidence rather than off the clock, deliberately. The trace
 * store is partitioned by span time, so a probe with no window is a scan of
 * every month a customer ever had — and a window measured from `now` would stop
 * recognising a segment's own evidence the moment the segment was old enough,
 * which is exactly the case a replay is.
 */
function windowOf(records: readonly IngestionRecord[]): {
  readonly from: bigint;
  readonly to: bigint;
} {
  let from = BigInt(records[0]?.started_at_microseconds ?? "0");
  let to = from;
  for (const record of records) {
    const at = BigInt(record.started_at_microseconds);
    if (at < from) from = at;
    if (at > to) to = at;
  }
  // The read is half-open, so the latest span has to be inside it.
  return { from, to: to + 1n };
}

/**
 * Reject conflicts with committed fingerprints before writing any rows.
 * Return identities of legacy rows without hashes so insertion skips them.
 * Exact replays with matching hashes can be written again.
 */
async function refuseConflictingEvidence(
  auth: AuthContext,
  segment: VerifiedSegment,
): Promise<ReadonlySet<string>> {
  const authoritative = new Set<string>();
  if (segment.records.length === 0) return authoritative;

  const held = await committedSpans(
    auth,
    segment.records.map((record) => ({
      traceId: record.trace_id,
      spanId: record.span_id,
    })),
    { window: windowOf(segment.records) },
  );
  if (held.length === 0) return authoritative;

  const stored = new Map(
    held.map((one) => [`${one.traceId}/${one.spanId}`, one.contentHash]),
  );
  for (const record of segment.records) {
    const identity = `${record.trace_id}/${record.span_id}`;
    const fingerprint = stored.get(identity);
    if (fingerprint === undefined) continue;
    if (fingerprint === "") {
      authoritative.add(identity);
      continue;
    }
    if (fingerprint === contentHashOf(record)) continue;
    throw new IdentityConflictInSegmentError(
      `span ${record.span_id} of trace ${record.trace_id} is already stored ` +
        `with different evidence, so this segment is retained and the stored ` +
        `evidence stays authoritative. A span is immutable: one identity holds ` +
        `one account of one moment, and replacing it would rewrite a record ` +
        `somebody may already have read.`,
    );
  }
  return authoritative;
}

/** Two accounts of one immutable span. The stored one wins; see the module doc. */
export class IdentityConflictInSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictInSegmentError";
  }
}

/** A header naming a project that is not its organization's. */
export class ImpossibleTenantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpossibleTenantBindingError";
  }
}

/** A header naming a real project of its organization that has since been archived. */
export class ProjectDeletedAfterAcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeletedAfterAcceptanceError";
  }
}

/**
 * Group production spans by platform and agent, keeping the latest span
 * start time. Using evidence time prevents a replay from advancing monitoring
 * to the time it was drained.
 */
type MonitoringFact = {
  readonly agentPlatform: AgentPlatform;
  readonly platformAgentId: string;
  readonly receivedAt: Date;
};

/** Whether this word is a platform Egma knows how to attribute to. */
function monitored(platform: string): platform is AgentPlatform {
  return (AGENT_PLATFORMS as readonly string[]).includes(platform);
}

function monitoringFactsIn(
  records: readonly IngestionRecord[],
): readonly MonitoringFact[] {
  const latest = new Map<
    string,
    { platform: AgentPlatform; agent: string; at: bigint }
  >();
  for (const record of records) {
    if (record.source !== "production") continue;
    // Asked of the shipped list rather than of two names written out here, so
    // a platform added to Monitoring gets its bookkeeping instead of silently
    // losing it.
    if (!monitored(record.agent_platform)) continue;
    const key = `${record.agent_platform}/${record.platform_agent_id}`;
    const at = BigInt(record.started_at_microseconds);
    const found = latest.get(key);
    if (found === undefined) {
      latest.set(key, {
        platform: record.agent_platform,
        agent: record.platform_agent_id,
        at,
      });
      continue;
    }
    if (at > found.at) found.at = at;
  }

  return [...latest.values()].map((one) => ({
    agentPlatform: one.platform,
    platformAgentId: one.agent,
    // Milliseconds, which is what a timestamp column reads back into.
    receivedAt: new Date(Number(one.at / 1_000n)),
  }));
}

/**
 * One object, all the way through — or left exactly where it was found.
 *
 * Answers whether the object was drained and deleted. A `false` is never a
 * discard: either the object is retained as a defect and reported, or the step
 * that failed is one that passes, and the next pass runs the whole object
 * again.
 */
async function drainOne(held: Running, key: string): Promise<boolean> {
  const { log, store } = held.options;

  /** Leave it where it is, tell an operator, and stop looking at it. */
  const retain = (defect: IngestionDefect, cause: unknown): false => {
    held.retained.add(key);
    retainedDefect(log, defect, key, cause);
    return false;
  };

  /**
   * A step failed for a reason that will pass — the store did not answer, a
   * query timed out, a connection went. The object is left exactly where it is
   * and the next pass runs the whole of it again. Counted, so a store that has
   * gone quiet is a rising number rather than a silence.
   */
  const waitAndTryAgain = (cause: unknown, message: string): false => {
    drainFailures.add(1);
    log.warn({ err: cause, key }, message);
    return false;
  };

  /**
   * The one classification, in one place: a transient cause is waited out, a
   * recognised defect is retained under its own reason, and anything else this
   * build did not expect is retained too rather than looped in silence.
   */
  const classify = (cause: unknown, message: string): false =>
    isTransientDrainFailure(cause)
      ? waitAndTryAgain(cause, message)
      : retain(retainedReasonFor(cause), cause);

  let segment: VerifiedSegment;
  try {
    segment = verifiedSegment(key, await store.read(key));
  } catch (cause) {
    const defect = defectOf(cause);
    if (defect === undefined) {
      // The bucket did not answer. Not a defect and not this object's fault:
      // the next pass reads it again.
      return waitAndTryAgain(cause, "a pending object could not be read");
    }
    return retain(defect, cause);
  }

  const auth = authFor(segment.scope);
  let spans: readonly NewSpan[] = segment.records.map(spanFor);

  // The header binds a project to an organization and the checksum covers that
  // binding, so nothing can have edited it — but a pair that was never real, and
  // a pair archived since the evidence was accepted, are two different failures
  // only Postgres can tell apart. Asked before a row is written, because a write
  // under a pair the control database will not stand behind is one customer's
  // evidence filed under another's name.
  let tenancy: "live" | "deleted" | "absent";
  try {
    tenancy = await projectOfOrganizationState(auth, segment.scope.projectId);
  } catch (cause) {
    return waitAndTryAgain(cause, "a segment's tenancy could not be checked");
  }
  if (tenancy === "absent") {
    return retain(
      "impossible_tenant_binding",
      new ImpossibleTenantBindingError(
        `this segment names project ${segment.scope.projectId} under ` +
          `organization ${segment.scope.organizationId}, and that project is ` +
          `not one of theirs. It is retained: evidence whose customer cannot ` +
          `be established is not evidence to write anywhere.`,
      ),
    );
  }
  if (tenancy === "deleted") {
    return retain(
      "project_deleted",
      new ProjectDeletedAfterAcceptanceError(
        `this segment names project ${segment.scope.projectId} of organization ` +
          `${segment.scope.organizationId}, and that project has since been ` +
          `archived. It is retained: the pair was real when this evidence was ` +
          `accepted, so this is a project removed afterwards rather than a ` +
          `binding that was never real.`,
      ),
    );
  }

  try {
    spans = await priceUsageSpans(auth, spans);
    segment = { ...segment, records: spans.map(recordFor) };
  } catch (cause) {
    return waitAndTryAgain(cause, "usage pricing did not finish; its accepted evidence remains pending");
  }

  let authoritative: ReadonlySet<string>;
  try {
    authoritative = await refuseConflictingEvidence(auth, segment);
  } catch (cause) {
    if (cause instanceof IdentityConflictInSegmentError) {
      return retain("identity_conflict", cause);
    }
    // The probe failed — an unreachable store, a query that timed out — or the
    // window it would build cannot be read: a transient cause is waited out and
    // anything else is retained rather than looped.
    return classify(cause, "a segment's identities could not be checked");
  }

  // The complete segment, every time — save an identity already stored under an
  // empty content hash. That is evidence written before the fingerprint existed,
  // which cannot be compared and so stays authoritative in fact: writing over it
  // is the one thing a plain replacement table would do and the one thing that
  // must not happen.
  const insertable =
    authoritative.size === 0
      ? spans
      : segment.records
          .filter(
            (record) => !authoritative.has(`${record.trace_id}/${record.span_id}`),
          )
          .map(spanFor);

  try {
    // A replay that wrote only the records it found missing would form different
    // blocks under the same deduplication token, and the token would then
    // suppress the very rows the replay existed to write. Identity is what makes
    // the repeat free; the token only makes it cheap.
    await appendSpans(auth, insertable, { segmentId: segment.segmentId });
  } catch (cause) {
    if (cause instanceof TraceStoreRefusedError) {
      // Rows the store has looked at and will refuse forever. Retained rather
      // than replayed into a loop, and never answered to a customer — the
      // request that carried them was accepted long ago.
      return retain("store_refused", cause);
    }
    return classify(cause, "a segment did not reach the trace store");
  }

  try {
    for (const fact of monitoringFactsIn(segment.records)) {
      await recordPulledCallReceived(auth, fact);
    }
    // Says only that this trace's evidence is readable. Every span goes in,
    // because which of them count is a question this seam already answers —
    // and answering it twice is how two readers of span shape come to disagree.
    await recordSimulationTraces(auth, spans);
    await recordProductionTraces(auth, spans);
  } catch (cause) {
    // The rows are visible and the handoffs are not. A transient cause leaves
    // the object to finish the missing half on replay; a value the handoff
    // cannot store — an instant with no readable date — is retained instead of
    // repeated forever.
    return classify(cause, "a drained segment's handoffs did not finish");
  }

  try {
    await store.delete(key);
  } catch (cause) {
    // Everything that depends on this object has happened, so the object is
    // spent. Leaving it costs one more harmless drain when the next scan finds
    // it, which is also what retries the delete.
    return waitAndTryAgain(cause, "a drained segment could not be deleted");
  }

  objectsDrained.add(1);
  return true;
}

/** The minting instant of the oldest key here, or `undefined` for none. */
function oldestMintOf(keys: readonly string[]): number | undefined {
  let oldest: number | undefined;
  for (const key of keys) {
    const id = segmentIdIn(key);
    if (id === undefined) continue;
    let at: number;
    try {
      at = mintedAt(id).getTime();
    } catch {
      continue;
    }
    if (oldest === undefined || at < oldest) oldest = at;
  }
  return oldest;
}

/** Record the backlog this pass leaves behind, for the gauges and for `stalled`. */
function recordBacklog(held: Running, stillPending: readonly string[]): void {
  held.pending = stillPending.length;
  const oldest = oldestMintOf(stillPending);
  held.oldestPendingAtMilliseconds = oldest;
  latestBacklog = {
    pending: stillPending.length,
    oldestAgeMilliseconds: oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
  };
}

/** Everything discoverable right now, oldest first, one object at a time. */
async function pass(held: Running): Promise<number> {
  const { log, store } = held.options;

  // The trace store's readiness is asked before the claim, not after: a process
  // whose store is not ready has no business holding the deployment's one drain
  // claim, and if it is already holding it — a store that was ready and then was
  // not — it lets go here so a healthy instance can take over rather than stand
  // by forever behind a green health check. A hint is worthless without the
  // claim, so it is dropped on either early return; the takeover pass lists the
  // whole prefix anyway.
  if (held.options.traceStoreReady?.() === false) {
    held.standby = "trace_store_migrating";
    held.hinted.clear();
    await held.options.ownership?.unlock();
    return 0;
  }

  // Before the listing, because a process that is not the drainer should not
  // be reading the prefix either: standing by costs one Postgres round trip
  // and nothing else, and it is the ordinary state of a second instance.
  if (held.options.ownership !== undefined) {
    if (!(await held.options.ownership.take())) {
      held.standby = "standby";
      held.hinted.clear();
      return 0;
    }
  }
  held.standby = undefined;

  let keys: string[];
  try {
    keys = (await store.list()).map((object) => object.key).sort();
  } catch (cause) {
    log.warn({ err: cause }, "the pending prefix could not be listed");
    keys = [];
  }

  // Anything an upload handed over since the last pass, in case it is newer
  // than the listing. A key that is in both is drained once. Membership is a
  // set rather than a scan of `keys`, so merging a large standby backlog on a
  // failover does not walk the whole listing once per hint.
  const seen = new Set(keys);
  for (const hinted of held.hinted) {
    if (!seen.has(hinted)) {
      keys.push(hinted);
      seen.add(hinted);
    }
  }
  held.hinted.clear();

  let drained = 0;
  const stillPending: string[] = [];
  for (const key of keys) {
    if (held.stopped) break;
    // The claim is re-asked between objects, not only once a pass: a holder
    // whose connection dies mid-pass must stop rather than walk the rest of the
    // prefix beside whoever takes over. Asking a session that already holds it
    // is one liveness round trip and stacks no second hold.
    if (
      held.options.ownership !== undefined &&
      !(await held.options.ownership.take())
    ) {
      held.standby = "standby";
      break;
    }
    if (held.retained.has(key)) continue;
    if (await drainOne(held, key)) {
      drained += 1;
    } else if (!held.retained.has(key)) {
      // Left where it is for a reason that will pass, so it is still backlog.
      stillPending.push(key);
    }
  }

  recordBacklog(held, stillPending);
  // A pass that had work and moved none of it is a stall: the store it drains
  // into is unreachable, and the drain component says so without the status code
  // turning on it. Any progress, or nothing left owed, clears it.
  if (drained > 0 || stillPending.length === 0) {
    held.consecutiveFailures = 0;
  } else {
    held.consecutiveFailures += 1;
  }
  return drained;
}

/**
 * Serialize drain passes. Calls during a pass share a queued next pass,
 * which lists objects after they called instead of returning an older scan.
 */
function drainNow(held: Running): Promise<number> {
  if (held.waiting !== undefined) return held.waiting;
  const next = held.chain
    .catch(() => 0)
    .then(() => {
      held.waiting = undefined;
      return pass(held);
    });
  held.waiting = next;
  held.chain = next;
  return next;
}

/**
 * Start the one drainer.
 *
 * The startup scan runs immediately rather than after the first interval: a
 * process that has just come back is the process most likely to have a backlog,
 * and making it wait out a scan interval would make every restart cost one.
 */
export function startDrainer(options: DrainerOptions): Drainer {
  const held: Running = {
    options,
    hinted: new Set(),
    retained: new Set(),
    timer: undefined,
    chain: Promise.resolve(0),
    waiting: undefined,
    // Until the first pass has asked, this process has not been told it is the
    // drainer, and reporting that it is would be a guess.
    standby: options.ownership === undefined ? undefined : "standby",
    pending: 0,
    oldestPendingAtMilliseconds: undefined,
    consecutiveFailures: 0,
    stopped: false,
  };

  const again = (): void => {
    if (held.stopped) return;
    held.timer = setTimeout(() => {
      void drainNow(held)
        .catch((cause: unknown) => {
          options.log.error({ err: cause }, "a drain pass did not finish");
        })
        .finally(again);
    }, options.scanIntervalMilliseconds);
    // A shutdown never waits for the next scan; what is pending is in the
    // bucket, and the next start finds it.
    held.timer.unref();
  };

  void drainNow(held)
    .catch((cause: unknown) => {
      options.log.error({ err: cause }, "the startup drain scan did not finish");
    })
    .finally(again);

  return {
    wake(key) {
      if (held.stopped) return;
      held.hinted.add(key);
      // Not awaited and not scheduled behind the interval: the hand-off is what
      // makes a conversation visible in about a second, and a pass already
      // running will be followed by this one.
      void drainNow(held).catch((cause: unknown) => {
        options.log.error({ err: cause }, "a hinted drain did not finish");
      });
    },

    drainNow() {
      return drainNow(held);
    },

    standingBy() {
      return held.standby;
    },

    health() {
      const oldest = held.oldestPendingAtMilliseconds;
      return {
        standby: held.standby,
        pending: held.pending,
        oldestPendingAgeMilliseconds:
          oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
        consecutiveFailures: held.consecutiveFailures,
        // A stall is a drainer that has work and keeps making no progress on it.
        // Standing by or waiting on the store's schema is not a stall — those are
        // this process behaving exactly as intended.
        stalled:
          held.standby === undefined &&
          held.consecutiveFailures >= STALL_AFTER_CONSECUTIVE_FAILURES,
      };
    },

    async stop() {
      held.stopped = true;
      if (held.timer !== undefined) {
        clearTimeout(held.timer);
        held.timer = undefined;
      }
      // Whatever is in flight finishes the object it is on and then stops: the
      // pass checks for a stop between objects, so what a shutdown waits on is
      // one segment and never the backlog.
      await held.chain.catch(() => undefined);
    },
  };
}
