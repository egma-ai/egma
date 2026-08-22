import {
  OversizeRecordError,
  refuseOversizeRecord,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

import type { IngestionSettings } from "../config.ts";
import {
  pendingObjectStore,
  SegmentIdentityConflictError,
  type PendingObjectStore,
} from "./object-store.ts";
import { recordFor, type IngestionRecord } from "./record.ts";
import {
  groupedByProject,
  millisecondsUntilSeal,
  recordBytes,
  sealSegment,
  shouldSeal,
  stagedFramePayload,
  stagedFrameFrom,
  type SealedSegment,
  type SegmentBounds,
  type SegmentScope,
} from "./segment.ts";
import {
  IngestionBackpressureError,
  openWriteAheadLog,
  type StagedEntry,
  type WriteAheadLog,
} from "./write-ahead-log.ts";

/**
 * Acceptance: the one place evidence becomes Egma's problem.
 *
 * Every path that takes production or simulation evidence ends here — the two
 * branches of the OTLP door and, in-process, the Retell poller. There is one
 * seam because there is one promise, and a promise made twice is a promise two
 * pieces of code can disagree about: **nothing is answered as accepted until it
 * is durable in the object store.** Not when it is normalized, not when it
 * reaches the local log, not when a row is written somewhere.
 *
 * ## What a caller hands over, and what it may not
 *
 * Normalized spans, plus the organization and project **the credential resolved
 * to**. Tenancy is a parameter here and is never read out of evidence: a record
 * has no field that could name a tenant, and a segment is sealed for the scope
 * this module was told, so an attribute claiming an organization decides
 * nothing even in principle.
 *
 * ## The order, and why every step is where it is
 *
 * 1. **Refuse what will not fit.** A record over a documented field bound is
 *    refused by name before anything is staged, and reported back so the door
 *    can put it in OTLP partial success. Refusing after acceptance would mean
 *    telling a sender their evidence landed and then dropping it.
 * 2. **Append to the local log.** Length-framed and checksummed, so a crash
 *    leaves complete records recoverable and a torn tail recognisable. The log
 *    is bounded; over the bound it refuses, and a refusal is retryable rather
 *    than a silent discard of something older.
 * 3. **Group by project and wait for company.** One segment belongs to exactly
 *    one project. A group seals when it reaches a size bound or when the flush
 *    timer expires, whichever comes first — the timer is what a low-volume
 *    deployment lives on, and the size bound is what stops one segment growing
 *    without one.
 * 4. **Seal, then record the identity, then upload.** The segment id is minted
 *    and written into the log *before* the upload starts, so an upload whose
 *    answer was lost is retried against the same key with the same bytes. That
 *    is the whole idempotency story, and it only works in that order.
 * 5. **Answer.** The call resolves when every segment carrying its records is
 *    durable, and refuses retryably otherwise. Records stay staged either way:
 *    a refusal is *not yet*, never *gone*.
 *
 * ## A refusal is retryable, and staging survives it
 *
 * `IngestionUnavailableError` means the object store did not confirm durability
 * inside the request's bound, or the local log will take no more. Both are
 * conditions that pass. The route answers `503`, the exporter retries, and the
 * staged copy is uploaded by whichever attempt gets there first — span identity
 * is stable, so the two meeting is a replay rather than a duplicate.
 */

/**
 * One evidence group: trusted scope, and the spans filed under it.
 *
 * The scope is an `AuthContext` rather than a bare pair because the caller has
 * already resolved one and re-deriving tenancy from two loose strings is how
 * the two come apart. Only the organization and the project are read.
 */
export type EvidenceGroup = {
  readonly auth: AuthContext;
  readonly spans: readonly NewSpan[];
};

/** One record this side will not store, and the sentence the sender is owed. */
export type RefusedRecord = {
  readonly reason: string;
};

/** What one acceptance call did. */
export type Acceptance = {
  /** Records staged and made durable. */
  readonly accepted: number;
  /**
   * Records refused before staging, with a reason each. Never a partial store:
   * a refused record left no trace anywhere.
   */
  readonly refused: readonly RefusedRecord[];
};

/**
 * Evidence could not be made durable **yet**.
 *
 * The one refusal this module raises, and it is deliberately one: an object
 * store that did not answer in time and a local log that is full are the same
 * news to a sender — *not now, send it again* — and answering them differently
 * would give an exporter two behaviours to implement for one situation. It is
 * never raised for anything a sender did; bad input is refused as a rejected
 * record and reported in the response body.
 */
export class IngestionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IngestionUnavailableError";
  }
}

/** What the standing acceptance loop is told when it is opened. */
export type AcceptanceOptions = {
  readonly settings: IngestionSettings;
  readonly log: FastifyBaseLogger;
  /**
   * Told the moment a segment is durable, so a drainer in the same process can
   * start on it without waiting for its own scan.
   *
   * A **speed hint and never the recovery authority**: a listener that throws,
   * blocks or is simply not there costs nothing, because the pending prefix is
   * the durable work record and a full scan finds every object whatever
   * happened here.
   */
  readonly onSegmentDurable?: (segment: SealedSegment) => void;
  /** Stands in for the real bucket client in the suites that fault it. */
  readonly store?: PendingObjectStore;
};

/** One record staged in the log, and the call waiting on it. */
type Staged = {
  readonly scope: SegmentScope;
  readonly record: IngestionRecord;
  readonly entry: StagedEntry;
  /** Uncompressed NDJSON cost, for the segment's size bound. */
  readonly bytes: number;
  readonly stagedAtMilliseconds: number;
  readonly durable: Promise<void>;
  settled(cause?: unknown): void;
};

/** One segment sealed and not yet durable. Retried as it is, never re-sealed. */
type Sealed = {
  readonly segment: SealedSegment;
  readonly staged: readonly Staged[];
  /** The frame in the log that recorded this identity before the upload began. */
  readonly sealEntry: StagedEntry;
};

/** One project's staged records, and whatever it has already sealed. */
type Group = {
  readonly scope: SegmentScope;
  waiting: Staged[];
  sealed: Sealed[];
};

type Standing = {
  readonly log: WriteAheadLog;
  readonly store: PendingObjectStore;
  readonly bounds: SegmentBounds;
  readonly requestTimeoutMilliseconds: number;
  readonly groups: Map<string, Group>;
  readonly logger: FastifyBaseLogger;
  readonly onSegmentDurable: (segment: SealedSegment) => void;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  closing: boolean;
};

/**
 * The one standing acceptance loop, or nothing on a process that never opened
 * one.
 *
 * Module-level for the same reason the trace store's client is: acceptance owns
 * a local log directory and a bucket connection, and two of them in one process
 * would be two logs staging the same evidence with neither knowing about the
 * other. A caller asks for acceptance rather than being handed one, so no route
 * can be given the wrong one.
 */
let standing: Standing | undefined;

function keyFor(scope: SegmentScope): string {
  return `${scope.organizationId}/${scope.projectId}`;
}

function groupFor(held: Standing, scope: SegmentScope): Group {
  const key = keyFor(scope);
  const found = held.groups.get(key);
  if (found !== undefined) return found;
  const made: Group = { scope, waiting: [], sealed: [] };
  held.groups.set(key, made);
  return made;
}

/** A promise somebody else settles, with nothing left to report it unhandled. */
function stagedFor(
  scope: SegmentScope,
  record: IngestionRecord,
  entry: StagedEntry,
  stagedAtMilliseconds: number,
): Staged {
  let settle: (cause?: unknown) => void = () => undefined;
  const durable = new Promise<void>((resolve, reject) => {
    settle = (cause?: unknown) => {
      if (cause === undefined) resolve();
      else reject(cause);
    };
  });
  // A call that has already given up on its bound is gone before this settles,
  // and a rejection nobody is listening for is reported as a process-level
  // fault. The caller's own `await` still sees the rejection; this only says
  // that the runtime has heard about it too.
  durable.catch(() => undefined);
  return {
    scope,
    record,
    entry,
    bytes: recordBytes(record),
    stagedAtMilliseconds,
    durable,
    settled: (cause?: unknown) => {
      settle(cause);
    },
  };
}

/**
 * How much of a group goes into the next segment.
 *
 * Everything waiting, unless a bound is reached partway — in which case the
 * record that reached it goes in and the rest wait for the next one. Crossing a
 * bound by one record is deliberate and is why the bound sits under the trace
 * store's own insert bound: holding that record back instead would make a
 * segment's bytes depend on what arrived after it, and a retry that re-grouped
 * the same records would then seal different bytes under an identity that has
 * already been recorded.
 */
function takeForSegment(
  waiting: readonly Staged[],
  bounds: SegmentBounds,
): readonly Staged[] {
  let bytes = 0;
  for (const [index, staged] of waiting.entries()) {
    bytes += staged.bytes;
    if (index + 1 >= bounds.maxRecords || bytes >= bounds.maxBytes) {
      return waiting.slice(0, index + 1);
    }
  }
  return waiting;
}

/** What a group looks like to the sealing rule. */
function pendingGroup(waiting: readonly Staged[]): {
  readonly records: number;
  readonly bytes: number;
  readonly oldestAtMilliseconds: number;
} {
  return {
    records: waiting.length,
    bytes: waiting.reduce((sum, staged) => sum + staged.bytes, 0),
    oldestAtMilliseconds: waiting[0]?.stagedAtMilliseconds ?? 0,
  };
}

/**
 * Seal one segment out of a group, recording its identity in the log first.
 *
 * The seal frame is written before the upload and released with it, so what
 * survives a crash is exactly the set of identities whose upload never
 * finished — which is what recovery needs and nothing more.
 */
function seal(held: Standing, group: Group): void {
  const taking = takeForSegment(group.waiting, held.bounds);
  if (taking.length === 0) return;

  const segment = sealSegment({
    scope: group.scope,
    records: taking.map((staged) => staged.record),
  });

  const sealEntry = held.log.append(
    stagedFramePayload({
      e: "seal",
      segment_id: segment.segmentId,
      organization_id: group.scope.organizationId,
      project_id: group.scope.projectId,
      record_count: segment.header.record_count,
      content_sha256: segment.header.content_sha256,
    }),
  );

  group.waiting = group.waiting.slice(taking.length);
  group.sealed.push({ segment, staged: taking, sealEntry });
}

/**
 * Upload the oldest sealed segment of a group, and let its records go once the
 * store has it.
 *
 * `sync()` first, so what reaches the bucket was on this disk before it left —
 * which is what makes recovery after an ambiguous upload find the same records
 * and reach for the same identity.
 */
async function upload(held: Standing, group: Group): Promise<void> {
  const attempt = group.sealed[0];
  if (attempt === undefined) return;

  held.log.sync();

  try {
    await held.store.create(attempt.segment);
  } catch (cause) {
    if (cause instanceof SegmentIdentityConflictError) {
      // One identity holding two different sets of bytes, which is this side's
      // defect and never a sender's. The stored object is left exactly as it
      // is, and this attempt's identity is abandoned rather than retried into:
      // the records are evidence and go back in front of everything still
      // waiting, to be sealed under an identity of their own, while the seal
      // frame that named the abandoned one is released because it now
      // describes nothing.
      held.logger.error(
        { err: cause, segmentId: attempt.segment.segmentId },
        "a sealed segment collided with a different object under its own identity",
      );
      group.sealed.shift();
      group.waiting = [...attempt.staged, ...group.waiting];
      held.log.release([attempt.sealEntry]);
      return;
    }

    // Anything else is *not yet*: the store was unreachable, slow, or refused
    // the moment rather than the bytes. Nothing is released, the sealed segment
    // stays where it is with its identity intact, and every call waiting on it
    // is told to try again.
    held.logger.error(
      { err: cause, segmentId: attempt.segment.segmentId },
      "a sealed segment did not reach the ingestion bucket",
    );
    const refusal = new IngestionUnavailableError(
      "this evidence was staged and could not be made durable in the " +
        "ingestion object store. It has not been discarded — send it again.",
      { cause },
    );
    for (const staged of attempt.staged) staged.settled(refusal);
    return;
  }

  group.sealed.shift();
  held.log.release([
    attempt.sealEntry,
    ...attempt.staged.map((staged) => staged.entry),
  ]);
  for (const staged of attempt.staged) staged.settled();

  try {
    held.onSegmentDurable(attempt.segment);
  } catch (cause) {
    // A wake-up hint, and the pending prefix is the work record. A listener
    // that fails costs a scan interval and never an object.
    held.logger.warn(
      { err: cause, segmentId: attempt.segment.segmentId },
      "the in-process drain hint refused a durable segment",
    );
  }
}

/** One pass: every group that has something sealed or something due. */
async function flush(held: Standing): Promise<void> {
  const now = Date.now();
  for (const group of [...held.groups.values()]) {
    // A stop that arrived mid-pass takes effect at the next group rather than
    // after all of them, so what a shutdown can wait on is one upload's request
    // bound and never the whole backlog's. Nothing is lost by stopping here:
    // every record is framed on the disk and the next start recovers it.
    if (held.closing) return;
    if (
      group.sealed.length === 0 &&
      shouldSeal(pendingGroup(group.waiting), held.bounds, now)
    ) {
      seal(held, group);
    }
    if (group.sealed.length > 0) await upload(held, group);
    if (group.waiting.length === 0 && group.sealed.length === 0) {
      held.groups.delete(keyFor(group.scope));
    }
  }
}

/**
 * Wake when the earliest group is due — or at once, where something is already
 * sealed or already over a bound.
 *
 * One timer for every group rather than one each: the answer is the smallest
 * wait any of them wants, and the pass that follows looks at all of them.
 */
function schedule(held: Standing): void {
  if (held.closing) return;
  if (held.timer !== undefined) {
    clearTimeout(held.timer);
    held.timer = undefined;
  }

  const now = Date.now();
  let soonest: number | undefined;
  for (const group of held.groups.values()) {
    const wait =
      group.sealed.length > 0
        ? 0
        : millisecondsUntilSeal(pendingGroup(group.waiting), held.bounds, now);
    if (wait === undefined) continue;
    soonest = soonest === undefined ? wait : Math.min(soonest, wait);
  }
  if (soonest === undefined) return;

  held.timer = setTimeout(() => {
    held.timer = undefined;
    void tick(held);
  }, soonest);
  // A shutdown never waits on a flush that has not happened; what is staged is
  // on the disk and the next start picks it up.
  held.timer.unref();
}

/** One pass at a time, and another scheduled behind it. */
function tick(held: Standing): Promise<void> {
  if (held.running !== undefined) return held.running;
  const pass = flush(held)
    .catch((cause: unknown) => {
      held.logger.error({ err: cause }, "an acceptance flush did not finish");
    })
    .finally(() => {
      held.running = undefined;
      schedule(held);
    });
  held.running = pass;
  return pass;
}

/**
 * Open the standing acceptance loop, recovering whatever the last stop staged.
 *
 * A deployment that has named no ingestion store opens nothing, and every
 * acceptance call then refuses retryably — which is the honest answer: without
 * a bucket there is nowhere for evidence to become durable, and a door that
 * answered success would be promising something no part of this process can
 * keep.
 */
export function openAcceptance(options: AcceptanceOptions): void {
  const { settings } = options;
  if (standing !== undefined) {
    throw new Error("this process already has a standing acceptance loop");
  }
  if (settings.store === undefined && options.store === undefined) {
    return;
  }

  const log = openWriteAheadLog(settings.logDirectory, {
    maxBytes: settings.logMaxBytes,
    maxRecords: settings.logMaxRecords,
    maxFileBytes: settings.segmentMaxBytes,
  });

  const held: Standing = {
    log,
    store:
      options.store ??
      pendingObjectStore(
        // Checked immediately above: one of the two is present.
        settings.store as NonNullable<IngestionSettings["store"]>,
        { requestTimeoutMilliseconds: settings.requestTimeoutMilliseconds },
      ),
    bounds: {
      maxBytes: settings.segmentMaxBytes,
      maxRecords: settings.segmentMaxRecords,
      flushMilliseconds: settings.flushMilliseconds,
    },
    requestTimeoutMilliseconds: settings.requestTimeoutMilliseconds,
    groups: new Map(),
    logger: options.log,
    onSegmentDurable: options.onSegmentDurable ?? (() => undefined),
    timer: undefined,
    running: undefined,
    closing: false,
  };

  recover(held);
  standing = held;
  // What was recovered has been waiting since before this process started, so
  // it does not wait out a flush window as well.
  if (held.groups.size > 0) void tick(held);
}

/**
 * Everything the previous process staged and did not finish, back in the
 * groups it was staged in.
 *
 * Records first, then the seals that claimed them. A seal frame names a count
 * rather than a list of identities, and it does not need to name one: records
 * are appended in arrival order and a segment always takes the oldest of its
 * project, so the first unclaimed `record_count` of that project *are* the ones
 * it sealed. The checksum recorded beside the count is what proves that pairing
 * — where it does not match, the identity is abandoned rather than reused,
 * because an identity uploaded with bytes other than the ones already under it
 * is exactly the integrity defect this whole path exists to rule out.
 */
function recover(held: Standing): void {
  const now = Date.now();
  const seals: {
    readonly frame: {
      readonly segment_id: string;
      readonly organization_id: string;
      readonly project_id: string;
      readonly record_count: number;
      readonly content_sha256: string;
    };
    readonly entry: StagedEntry;
  }[] = [];

  for (const entry of held.log.staged()) {
    let frame;
    try {
      frame = stagedFrameFrom(entry.payload);
    } catch (cause) {
      // A frame this version cannot read is left where it is and reported. It
      // passed its checksum, so the bytes are whole; what they are not is
      // anything this build knows how to stage.
      held.logger.error(
        { err: cause, file: entry.file, offset: entry.offset },
        "a staged frame in the local ingestion log could not be read",
      );
      continue;
    }

    if (frame.e === "record") {
      const scope: SegmentScope = {
        organizationId: frame.organization_id,
        projectId: frame.project_id,
      };
      groupFor(held, scope).waiting.push(
        stagedFor(scope, frame.record, entry, now),
      );
      continue;
    }
    seals.push({ frame, entry });
  }

  for (const { frame, entry } of seals) {
    const group = groupFor(held, {
      organizationId: frame.organization_id,
      projectId: frame.project_id,
    });
    const taking = group.waiting.slice(0, frame.record_count);
    const segment =
      taking.length === frame.record_count
        ? sealSegment({
            scope: group.scope,
            records: taking.map((staged) => staged.record),
            segmentId: frame.segment_id,
          })
        : undefined;

    if (segment === undefined || segment.header.content_sha256 !== frame.content_sha256) {
      held.logger.error(
        { segmentId: frame.segment_id },
        "a recorded segment identity no longer matches the records it named",
      );
      held.log.release([entry]);
      continue;
    }

    group.waiting = group.waiting.slice(frame.record_count);
    group.sealed.push({ segment, staged: taking, sealEntry: entry });
  }
}

/** Stop the standing loop. Nothing staged is deleted and nothing is uploaded. */
export async function closeAcceptance(): Promise<void> {
  const held = standing;
  standing = undefined;
  if (held === undefined) return;

  held.closing = true;
  if (held.timer !== undefined) {
    clearTimeout(held.timer);
    held.timer = undefined;
  }
  await held.running;
  held.log.close();
}

/** What a call was told when this process accepts nothing. */
const NO_ACCEPTANCE =
  "this Egma has no ingestion object store configured, so there is nowhere " +
  "for evidence to become durable. Nothing was stored.";

/**
 * Stage one credential's evidence and answer when it is durable.
 *
 * The ordinary path, and the one both the customer OTLP branch and the Retell
 * poller take: one trusted scope, one project, one segment unless the bounds
 * cut it.
 */
export function acceptEvidence(
  spans: readonly NewSpan[],
  options: { readonly auth: AuthContext },
): Promise<Acceptance> {
  return acceptEvidenceForProjects([{ auth: options.auth, spans }]);
}

/**
 * Stage several projects' evidence in one call and answer when **every** one of
 * them is durable.
 *
 * The trusted simulator service batch, which may carry resources belonging to
 * more than one project. Each project gets a segment of its own — evidence from
 * two projects may not share a durable object — and the call succeeds only when
 * all of them have landed. A partial answer would tell the sender the whole
 * batch was accepted while one project's evidence sat in a log; the groups that
 * did land are replayed by the retry, which stable span identity makes a no-op.
 */
export async function acceptEvidenceForProjects(
  groups: readonly EvidenceGroup[],
): Promise<Acceptance> {
  const held = standing;
  if (held === undefined) throw new IngestionUnavailableError(NO_ACCEPTANCE);

  const refused: RefusedRecord[] = [];
  const staging: { readonly scope: SegmentScope; readonly record: IngestionRecord }[] =
    [];

  for (const group of groups) {
    const { organizationId, projectId } = group.auth;
    if (projectId === undefined) {
      throw new Error("evidence is accepted under a project-scoped context");
    }
    const scope: SegmentScope = { organizationId, projectId };

    for (const span of group.spans) {
      try {
        // Before anything is staged, so a record Egma will not store never
        // enters the log, never rides a segment, and is reported to whoever
        // sent it while their request is still open.
        refuseOversizeRecord(span);
      } catch (cause) {
        if (!(cause instanceof OversizeRecordError)) throw cause;
        refused.push({ reason: cause.message });
        continue;
      }
      staging.push({ scope, record: recordFor(span) });
    }
  }

  if (staging.length === 0) return { accepted: 0, refused };

  const now = Date.now();
  const waiting: Staged[] = [];
  // Grouped before the first append so that the log holds one project's
  // records together, which is the order a segment seals them in.
  for (const grouped of groupedByProject(staging)) {
    for (const record of grouped.records) {
      let entry: StagedEntry;
      try {
        entry = held.log.append(
          stagedFramePayload({
            e: "record",
            organization_id: grouped.scope.organizationId,
            project_id: grouped.scope.projectId,
            record,
          }),
        );
      } catch (cause) {
        if (!(cause instanceof IngestionBackpressureError)) throw cause;
        // Everything already appended by this call stays staged and will be
        // uploaded; nothing older is discarded to make room. The sender is told
        // to send the whole request again, and the part that did land is a
        // replay of itself.
        schedule(held);
        throw new IngestionUnavailableError(
          "this Egma is holding as much staged evidence as it is allowed to " +
            "and cannot take more right now. Nothing already staged has been " +
            "discarded — send this again.",
          { cause },
        );
      }
      const staged = stagedFor(grouped.scope, record, entry, now);
      groupFor(held, grouped.scope).waiting.push(staged);
      waiting.push(staged);
    }
  }

  schedule(held);
  await durableWithin(held, waiting);
  return { accepted: waiting.length, refused };
}

/**
 * Wait for every staged record of one call, and no longer than the request is
 * allowed to be held open.
 *
 * The bound is the whole reason this is not a plain `Promise.all`: a store that
 * has stopped answering would otherwise hold a request open for as long as the
 * client's own timeout, and the sender would learn nothing it could act on. On
 * the bound the records stay staged and the sender is told to retry, which is
 * the one answer that is true whichever way the upload in flight ends.
 */
async function durableWithin(
  held: Standing,
  waiting: readonly Staged[],
): Promise<void> {
  let bound: NodeJS.Timeout | undefined;
  const overdue = new Promise<never>((_resolve, reject) => {
    bound = setTimeout(() => {
      reject(
        new IngestionUnavailableError(
          `this evidence was staged and was not durable in the ingestion ` +
            `object store within ${held.requestTimeoutMilliseconds}ms. It has ` +
            `not been discarded — send it again.`,
        ),
      );
    }, held.requestTimeoutMilliseconds);
    bound.unref();
  });

  try {
    await Promise.race([
      Promise.all(waiting.map((staged) => staged.durable)),
      overdue,
    ]);
  } finally {
    if (bound !== undefined) clearTimeout(bound);
  }
}

/**
 * Every record staged and not yet durable, oldest first.
 *
 * The write-readiness surface and the suites that prove a refusal kept its
 * evidence both need to be able to say what is still in hand, and reading the
 * log's frames back is the only answer that cannot drift from what is on the
 * disk.
 */
export function stagedEvidence(): readonly {
  readonly scope: SegmentScope;
  readonly record: IngestionRecord;
}[] {
  const held = standing;
  if (held === undefined) return [];
  const found: { scope: SegmentScope; record: IngestionRecord }[] = [];
  for (const group of held.groups.values()) {
    for (const staged of [
      ...group.sealed.flatMap((sealed) => sealed.staged),
      ...group.waiting,
    ]) {
      found.push({ scope: staged.scope, record: staged.record });
    }
  }
  return found;
}
