import {
  appendSpans,
  committedSpans,
  recordProductionEvidenceReceived,
  recordProductionTraces,
  TraceStoreRefusedError,
  type AuthContext,
  type NewSpan,
} from "@egma/db";

import { defectOf, retainedDefect, type IngestionLog } from "./defects.ts";
import type { PendingObjectStore } from "./object-store.ts";
import { contentHashOf, spanFor, type IngestionRecord } from "./record.ts";
import type { SegmentScope } from "./segment.ts";
import { verifiedSegment, type VerifiedSegment } from "./verify.ts";

/**
 * The drainer: pending objects in, query-visible evidence out, and the object
 * gone only once everything that depends on it has happened.
 *
 * A pending object **is** the work record. There is no row saying it exists and
 * no notification anybody has to receive, which is the whole reason this
 * release adds no broker: the bucket already remembers, and remembering is the
 * only thing a broker would have been for. Everything else here follows from
 * that one choice.
 *
 * ## Finding work
 *
 * Two ways, and only one of them is authority. A successful upload hands the
 * key straight over, which is what makes a conversation visible in about a
 * second at the volumes this release serves. And at startup and on an interval
 * the whole pending prefix is listed, **every page of it**, which is what makes
 * that speed optional: an in-process hand-off lost to a crash, a restart, a
 * missed notification or a bug costs latency and never evidence. A listing that
 * stopped at the first page would be worse than no listing at all — it would
 * report a clean backlog while a thousand accepted segments sat behind it.
 *
 * ## The order, which is the whole correctness argument
 *
 * Per object, in this order and no other:
 *
 * 1. **Verify.** Identity, version, scope, compression, checksum, shape.
 * 2. **Check integrity against what is already stored.** A batched probe of the
 *    identities this segment carries. An identity already held with the same
 *    content is an exact replay; one held with *different* content is a defect,
 *    and the object is retained without a single row being written.
 * 3. **Write ClickHouse**, the complete segment, under the segment's own
 *    deduplication token.
 * 4. **Monitoring bookkeeping**, monotone, so a replay cannot wind a customer's
 *    "last heard from" backwards.
 * 5. **The evidence-ready handoff**, which says only that this trace's evidence
 *    is now readable. Not that it is complete, not that a grader applies, not
 *    that anything is scheduled.
 * 6. **Delete.**
 *
 * A failure at any step leaves the object exactly where it is, and the next
 * pass runs the whole object again. That is safe because every step above is
 * idempotent — identity for the rows, `greatest` for the bookkeeping, an upsert
 * that touches nothing already claimed for the handoff — and it is why the
 * delete is last: an object deleted before its handoffs would leave a
 * conversation stored and unreportable, with nothing left to replay from.
 *
 * A failed delete is not special. The object stays, the next scan finds it, and
 * draining it again is a no-op that tries the delete again. **Rediscovery is
 * harmless** is not a hope here; it is the retry.
 *
 * ## Why the handoffs are after the write, and never before
 *
 * The evidence-ready boundary is a promise that the named trace can be read.
 * Raising it before the rows are visible would wake a grader for a conversation
 * it would then read as empty, and an empty conversation judged is worse than
 * one judged late — the verdict looks like an answer.
 *
 * ## One drainer
 *
 * One active drainer per deployment in this release, and no claim, shard or
 * ownership protocol to make several safe. Sequential per object, batched
 * inside one. That is enough for the volume this release serves, and the seam
 * for splitting it later is the role setting rather than a second protocol.
 */

export type DrainerOptions = {
  readonly store: PendingObjectStore;
  readonly log: IngestionLog;
  /** How often the whole pending prefix is listed. The startup scan is extra. */
  readonly scanIntervalMilliseconds: number;
};

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
  stop(): Promise<void>;
};

type Running = {
  readonly options: DrainerOptions;
  /** Keys handed over by a successful upload and not yet tried. */
  readonly hinted: Set<string>;
  timer: NodeJS.Timeout | undefined;
  /** The tail of the pass chain. Passes never overlap. */
  chain: Promise<number>;
  /** A pass that is waiting to start, so callers arriving together share it. */
  waiting: Promise<number> | undefined;
  stopped: boolean;
};

/**
 * The context one segment's effects are written under.
 *
 * Built from the **sealed header** and from nothing else — not from the key,
 * not from anything a caller remembered, not from an attribute on the evidence.
 * A segment states its own organization and project inside the bytes the
 * checksum covers, so this is the one tenancy statement that exists and there
 * is nothing for it to disagree with.
 *
 * `monitoring` for the same reason `claimDueRetellMonitoringAgent` uses it: this
 * names no person, it came from egma's own record of accepted work rather than
 * from a credential, and it opens neither the grading service's capabilities nor
 * the conductor's.
 */
function authFor(scope: SegmentScope): AuthContext {
  return {
    userId: "",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    role: "admin",
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
 * A segment's identities held against what the store already says about them.
 *
 * Answers nothing and throws on a conflict, because there is only one thing to
 * do about one: **stop before writing anything.** A conflicting segment that
 * had written half its rows would have made the defect it reports partly true.
 *
 * A stored row whose content hash is empty is evidence written before the
 * fingerprint existed — the simulation evidence carried through the identity
 * rebuild. It is treated as an exact replay and never as a conflict: the row is
 * there, it is authoritative, and a comparison that cannot be made is not a
 * disagreement.
 */
async function refuseConflictingEvidence(
  auth: AuthContext,
  segment: VerifiedSegment,
): Promise<void> {
  if (segment.records.length === 0) return;

  const held = await committedSpans(
    auth,
    segment.records.map((record) => ({
      traceId: record.trace_id,
      spanId: record.span_id,
    })),
    { window: windowOf(segment.records) },
  );
  if (held.length === 0) return;

  const stored = new Map(
    held.map((one) => [`${one.traceId}/${one.spanId}`, one.contentHash]),
  );
  for (const record of segment.records) {
    const fingerprint = stored.get(`${record.trace_id}/${record.span_id}`);
    if (fingerprint === undefined || fingerprint === "") continue;
    if (fingerprint === contentHashOf(record)) continue;
    throw new IdentityConflictInSegmentError(
      `span ${record.span_id} of trace ${record.trace_id} is already stored ` +
        `with different evidence, so this segment is retained and the stored ` +
        `evidence stays authoritative. A span is immutable: one identity holds ` +
        `one account of one moment, and replacing it would rewrite a record ` +
        `somebody may already have read.`,
    );
  }
}

/** Two accounts of one immutable span. The stored one wins; see the module doc. */
export class IdentityConflictInSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictInSegmentError";
  }
}

/**
 * Which platform's Monitoring state this segment moves, and to when.
 *
 * Gathered per `(platform, selected agent)` rather than per conversation — one
 * segment carrying two hundred calls of one agent is one statement — and the
 * instant comes from **the evidence** rather than from the clock. That is what
 * makes a replay monotone in practice as well as in the merge: a segment
 * drained today carrying yesterday's calls says yesterday, so it cannot move a
 * customer's "last production conversation" forward to a moment nothing
 * happened at.
 */
function monitoringFactsIn(
  records: readonly IngestionRecord[],
): readonly {
  readonly agentPlatform: "retell" | "livekit_agents";
  readonly platformAgentId: string;
  readonly receivedAt: Date;
}[] {
  const latest = new Map<string, { platform: string; agent: string; at: bigint }>();
  for (const record of records) {
    if (record.source !== "production") continue;
    if (record.agent_platform !== "retell" && record.agent_platform !== "livekit_agents") {
      continue;
    }
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
    agentPlatform: one.platform as "retell" | "livekit_agents",
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

  let segment: VerifiedSegment;
  try {
    segment = verifiedSegment(key, await store.read(key));
  } catch (cause) {
    const defect = defectOf(cause);
    if (defect === undefined) {
      // The bucket did not answer. Not a defect and not this object's fault:
      // the next pass reads it again.
      log.warn({ err: cause, key }, "a pending object could not be read");
      return false;
    }
    retainedDefect(log, defect, key, cause);
    return false;
  }

  const auth = authFor(segment.scope);
  const spans: readonly NewSpan[] = segment.records.map(spanFor);

  try {
    await refuseConflictingEvidence(auth, segment);
  } catch (cause) {
    if (cause instanceof IdentityConflictInSegmentError) {
      retainedDefect(log, "identity_conflict", key, cause);
      return false;
    }
    // The probe itself failed — an unreachable store, a query that timed out.
    // Nothing has been written and the object is untouched.
    log.warn({ err: cause, key }, "a segment's identities could not be checked");
    return false;
  }

  try {
    // The complete segment, every time. A replay that wrote only the records it
    // found missing would form different blocks under the same deduplication
    // token, and the token would then suppress the very rows the replay existed
    // to write. Identity is what makes the repeat free; the token only makes it
    // cheap.
    await appendSpans(auth, spans, { segmentId: segment.segmentId });
  } catch (cause) {
    if (cause instanceof TraceStoreRefusedError) {
      // Rows the store has looked at and will refuse forever. Retained rather
      // than replayed into a loop, and never answered to a customer — the
      // request that carried them was accepted long ago.
      retainedDefect(log, "store_refused", key, cause);
      return false;
    }
    log.warn({ err: cause, key }, "a segment did not reach the trace store");
    return false;
  }

  try {
    for (const fact of monitoringFactsIn(segment.records)) {
      await recordProductionEvidenceReceived(auth, fact);
    }
    // Says only that this trace's evidence is readable. Every span goes in,
    // because which of them count is a question this seam already answers —
    // and answering it twice is how two readers of span shape come to disagree.
    await recordProductionTraces(auth, spans);
  } catch (cause) {
    // The rows are visible and the handoffs are not. The object stays, and the
    // replay finishes the missing half: the write it repeats is a no-op.
    log.warn({ err: cause, key }, "a drained segment's handoffs did not finish");
    return false;
  }

  try {
    await store.delete(key);
  } catch (cause) {
    // Everything that depends on this object has happened, so the object is
    // spent. Leaving it costs one more harmless drain when the next scan finds
    // it, which is also what retries the delete.
    log.warn({ err: cause, key }, "a drained segment could not be deleted");
    return false;
  }

  return true;
}

/** Everything discoverable right now, oldest first, one object at a time. */
async function pass(held: Running): Promise<number> {
  const { log, store } = held.options;

  let keys: string[];
  try {
    keys = (await store.list()).map((object) => object.key).sort();
  } catch (cause) {
    log.warn({ err: cause }, "the pending prefix could not be listed");
    keys = [];
  }

  // Anything an upload handed over since the last pass, in case it is newer
  // than the listing. A key that is in both is drained once.
  for (const hinted of held.hinted) {
    if (!keys.includes(hinted)) keys.push(hinted);
  }
  held.hinted.clear();

  let drained = 0;
  for (const key of keys) {
    if (held.stopped) break;
    if (await drainOne(held, key)) drained += 1;
  }
  return drained;
}

/**
 * One pass at a time, and every caller gets a pass that **starts after it
 * asked**.
 *
 * Returning a pass already in flight would be the cheaper answer and the wrong
 * one: that pass has already listed the prefix, so a key that became durable a
 * moment ago is not in it, and a caller told "drained" would have been told
 * about somebody else's work. So a call that arrives mid-pass waits behind it —
 * and every caller that arrives while one is already waiting shares that one,
 * which is what keeps a burst of uploads from becoming a burst of listings.
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
    timer: undefined,
    chain: Promise.resolve(0),
    waiting: undefined,
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
