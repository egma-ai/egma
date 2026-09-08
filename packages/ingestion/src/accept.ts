import {
  OversizeRecordError,
  refuseOversizeRecord,
  refuseUnstorableInstant,
  UnstorableInstantError,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import { metrics as openTelemetryMetrics } from "@opentelemetry/api";
import type { IngestionSettings, IngestionLogger } from "./settings.ts";

import {
  pendingObjectStore,
  SegmentIdentityConflictError,
  type PendingObjectStore,
} from "./object-store.ts";
import {
  LARGEST_STAGEABLE_RECORD_BYTES,
  recordFor,
  type IngestionRecord,
} from "./record.ts";
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

const meter = openTelemetryMetrics.getMeter("@egma/api/ingestion-accept");
const uploadFailures = meter.createCounter("egma.ingestion.upload.failures", {
  description: "Segment uploads that did not reach the ingestion object store",
});
const acknowledgementLatency = meter.createHistogram(
  "egma.ingestion.acknowledgement.latency",
  {
    description: "Time from a record being staged to its segment being durable",
    unit: "ms",
  },
);

/**
 * Accept normalized production or simulation spans under trusted caller scope.
 * A successful response requires every accepted record to be durable in the
 * object store; local staging alone is insufficient.
 *
 * Validate records, append them to the bounded local log, and group by project.
 * Seal on size or time limits. Record the segment identity before uploading
 * so retries use the same object key and bytes.
 *
 * Timeout or backpressure is retryable. Keep staged records for later upload;
 * exporter retries are reconciled by span identity during draining.
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
 * Retryable acceptance failure, such as unavailable object storage or a full
 * local log. Invalid records are reported separately in the acceptance result.
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
  readonly log: IngestionLogger;
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
  /**
   * Uploads of this group's sealed head that have failed since one last
   * succeeded. Zero the moment one does.
   */
  failedAttempts: number;
  /**
   * When this group may be offered to the store again. Always in the past
   * while nothing has failed, which is what makes the ordinary path free of
   * any wait at all.
   */
  nextAttemptAtMilliseconds: number;
};

type Standing = {
  readonly log: WriteAheadLog;
  readonly store: PendingObjectStore;
  readonly bounds: SegmentBounds;
  readonly requestTimeoutMilliseconds: number;
  readonly groups: Map<string, Group>;
  readonly logger: IngestionLogger;
  readonly onSegmentDurable: (segment: SealedSegment) => void;
  /** Aborts an object-store request if the planned-shutdown deadline expires. */
  readonly uploads: AbortController;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  closing: boolean;
};

/**
 * Process-wide acceptance state. A single loop owns the local staging log
 * and object-store connection.
 */
let standing: Standing | undefined;
/** One planned close shared by every caller until the log handle is closed. */
let closingAcceptance: Promise<void> | undefined;

// The local log's live volume as a level, for the scrape that used to read it
// off the unauthenticated health body: bytes spoken for and frames staged, both
// because both bounds bind and either can be the near one. Zero on a process
// holding nothing or with no acceptance loop open.
meter
  .createObservableGauge("egma.ingestion.local_log.bytes", {
    description: "Bytes across every local-log file, sealed ones included",
    unit: "By",
  })
  .addCallback((result) => result.observe(standing?.log.bytes ?? 0));
meter
  .createObservableGauge("egma.ingestion.local_log.records", {
    description: "Frames staged in the local log and not yet released",
  })
  .addCallback((result) => result.observe(standing?.log.records ?? 0));

function keyFor(scope: SegmentScope): string {
  return `${scope.organizationId}/${scope.projectId}`;
}

function groupFor(held: Standing, scope: SegmentScope): Group {
  const key = keyFor(scope);
  const found = held.groups.get(key);
  if (found !== undefined) return found;
  const made: Group = {
    scope,
    waiting: [],
    sealed: [],
    failedAttempts: 0,
    nextAttemptAtMilliseconds: 0,
  };
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
 * Back off failed uploads to avoid retrying a still-due sealed group in a
 * tight loop. Double from the flush interval, capped at the larger of that
 * interval and the request timeout.
 */
function nextAttemptAfter(held: Standing, failedAttempts: number): number {
  const longest = Math.max(
    held.bounds.flushMilliseconds,
    held.requestTimeoutMilliseconds,
  );
  const doubled =
    held.bounds.flushMilliseconds * 2 ** Math.max(0, failedAttempts - 1);
  return Math.min(doubled, longest);
}

/**
 * Take an ordered prefix through the record that reaches a bound.
 * The byte limit may be exceeded by that final record.
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
    await held.store.create(attempt.segment, { signal: held.uploads.signal });
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
      // The store answered, and these records are about to be sealed under an
      // identity of their own. Nothing here says the store will refuse the
      // next one.
      group.failedAttempts = 0;
      group.nextAttemptAtMilliseconds = 0;
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
    // The waiting calls are told at once and keep their own bound: a sender
    // learning about this is not something to make slower. What waits is the
    // *next attempt* on this group, so a store that is refusing is asked again
    // at a pace rather than as fast as it can say no.
    group.failedAttempts += 1;
    group.nextAttemptAtMilliseconds =
      Date.now() + nextAttemptAfter(held, group.failedAttempts);
    uploadFailures.add(1);

    const refusal = new IngestionUnavailableError(
      "this evidence was staged and could not be made durable in the " +
        "ingestion object store. It has not been discarded — send it again.",
      { cause },
    );
    for (const staged of attempt.staged) staged.settled(refusal);
    return;
  }

  group.sealed.shift();
  group.failedAttempts = 0;
  group.nextAttemptAtMilliseconds = 0;
  held.log.release([
    attempt.sealEntry,
    ...attempt.staged.map((staged) => staged.entry),
  ]);
  const durableAt = Date.now();
  for (const staged of attempt.staged) {
    acknowledgementLatency.record(durableAt - staged.stagedAtMilliseconds);
    staged.settled();
  }

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
    // bound and never the whole backlog's. Every unfinished caller still waits
    // for S3 durability or receives a retryable refusal.
    if (held.closing) return;
    if (
      group.sealed.length === 0 &&
      shouldSeal(pendingGroup(group.waiting), held.bounds, now)
    ) {
      seal(held, group);
    }
    // A group whose last attempt failed is left alone until its wait is over.
    // Read from the clock rather than from the pass's own start, because an
    // earlier group's upload may have taken a while to fail.
    if (
      group.sealed.length > 0 &&
      Date.now() >= group.nextAttemptAtMilliseconds
    ) {
      await upload(held, group);
    }
    if (group.waiting.length === 0 && group.sealed.length === 0) {
      held.groups.delete(keyFor(group.scope));
    }
  }
}

/**
 * Wake when the earliest group is due — or at once, where something is already
 * sealed or already over a bound, unless that group is waiting out a failed
 * attempt.
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
        ? Math.max(0, group.nextAttemptAtMilliseconds - now)
        : millisecondsUntilSeal(pendingGroup(group.waiting), held.bounds, now);
    if (wait === undefined) continue;
    soonest = soonest === undefined ? wait : Math.min(soonest, wait);
  }
  if (soonest === undefined) return;

  held.timer = setTimeout(() => {
    held.timer = undefined;
    void tick(held);
  }, soonest);
  // A planned shutdown cancels this timer and performs its own immediate,
  // bounded upload pass over everything still staged.
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
  if (closingAcceptance !== undefined) {
    throw new Error("this process is still closing its acceptance loop");
  }
  const { store } = settings;
  if (store === undefined) return;

  const log = openWriteAheadLog(settings.logDirectory, {
    maxBytes: settings.logMaxBytes,
    maxRecords: settings.logMaxRecords,
    maxFileBytes: settings.segmentMaxBytes,
  });

  const held: Standing = {
    log,
    store: pendingObjectStore(store, {
      requestTimeoutMilliseconds: settings.requestTimeoutMilliseconds,
    }),
    bounds: {
      maxBytes: settings.segmentMaxBytes,
      maxRecords: settings.segmentMaxRecords,
      flushMilliseconds: settings.flushMilliseconds,
    },
    requestTimeoutMilliseconds: settings.requestTimeoutMilliseconds,
    groups: new Map(),
    logger: options.log,
    onSegmentDurable: options.onSegmentDurable ?? (() => undefined),
    uploads: new AbortController(),
    timer: undefined,
    running: undefined,
    closing: false,
  };

  recover(held);
  standing = held;
  // Recovery stamps what it found as already past its flush window, so the
  // first pass seals and uploads it rather than starting its wait again.
  if (held.groups.size > 0) void tick(held);
}

/**
 * Recover records by project in log order, then apply recorded seals to
 * each project's oldest unclaimed records. Verify the count and checksum
 * before reusing a segment ID; mismatches discard only the seal identity.
 * Recovered groups are immediately due for upload.
 */
function recover(held: Standing): void {
  // What is in the log has been waiting since before this process started, so
  // it is stamped as having already waited out a flush window: a record whose
  // wait began again at every restart would be a record a restart loop could
  // hold forever.
  const now = Date.now() - held.bounds.flushMilliseconds;
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

/** The full planned-shutdown window reserved for pending evidence uploads. */
export const ACCEPTANCE_SHUTDOWN_TIMEOUT_MILLISECONDS = 120_000;

function hasPendingEvidence(held: Standing): boolean {
  for (const group of held.groups.values()) {
    if (group.waiting.length > 0 || group.sealed.length > 0) return true;
  }
  return false;
}

/**
 * Finish one shutdown pass. Unlike the standing pass, this seals immediately
 * and keeps trying failed uploads because the local disk ends with this task.
 */
async function flushForShutdown(held: Standing): Promise<number | undefined> {
  let nextAttemptAtMilliseconds: number | undefined;

  for (const group of [...held.groups.values()]) {
    if (group.sealed.length === 0 && group.waiting.length > 0) seal(held, group);
    if (
      group.sealed.length > 0 &&
      Date.now() >= group.nextAttemptAtMilliseconds
    ) {
      await upload(held, group);
    }
    if (group.waiting.length === 0 && group.sealed.length === 0) {
      held.groups.delete(keyFor(group.scope));
      continue;
    }
    const due = group.nextAttemptAtMilliseconds;
    nextAttemptAtMilliseconds =
      nextAttemptAtMilliseconds === undefined
        ? due
        : Math.min(nextAttemptAtMilliseconds, due);
  }

  return nextAttemptAtMilliseconds;
}

/** Wait for the next retry or the one deadline, whichever comes first. */
async function waitDuringShutdown(
  held: Standing,
  untilMilliseconds: number,
): Promise<void> {
  const wait = Math.max(0, untilMilliseconds - Date.now());
  if (wait === 0 || held.uploads.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, wait);
    const signal = held.uploads.signal;

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Stop accepting, then spend one bounded window making staged evidence durable.
 * Local records still present when the deadline expires are not recoverable by
 * a replacement Fargate task; their senders receive a retryable refusal.
 */
async function closeHeldAcceptance(
  held: Standing,
  options: { readonly timeoutMilliseconds?: number } = {},
): Promise<void> {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? ACCEPTANCE_SHUTDOWN_TIMEOUT_MILLISECONDS;
  const deadlineMilliseconds = Date.now() + timeoutMilliseconds;
  const deadline = setTimeout(() => held.uploads.abort(), timeoutMilliseconds);

  try {
    await held.running;
    while (!held.uploads.signal.aborted && hasPendingEvidence(held)) {
      const nextAttemptAtMilliseconds = await flushForShutdown(held);
      if (!hasPendingEvidence(held)) break;
      await waitDuringShutdown(
        held,
        Math.min(
          deadlineMilliseconds,
          nextAttemptAtMilliseconds ?? deadlineMilliseconds,
        ),
      );
    }
  } catch (cause) {
    held.logger.error(
      { err: cause },
      "pending evidence could not finish during planned shutdown",
    );
  } finally {
    clearTimeout(deadline);
    // A caller still awaiting durability is settled now rather than left behind
    // with the task. The sender retry is the recovery path after this point.
    const refusal = new IngestionUnavailableError(
      "this Egma stopped before the ingestion object store confirmed this " +
        "evidence as durable. Send it again.",
    );
    for (const group of held.groups.values()) {
      for (const staged of [
        ...group.sealed.flatMap((sealed) => sealed.staged),
        ...group.waiting,
      ]) {
        staged.settled(refusal);
      }
    }
    held.log.close();
  }
}

export function closeAcceptance(
  options: { readonly timeoutMilliseconds?: number } = {},
): Promise<void> {
  if (closingAcceptance !== undefined) return closingAcceptance;

  const held = standing;
  standing = undefined;
  if (held === undefined) return Promise.resolve();

  held.closing = true;
  if (held.timer !== undefined) {
    clearTimeout(held.timer);
    held.timer = undefined;
  }

  const closing = closeHeldAcceptance(held, options).finally(() => {
    if (closingAcceptance === closing) closingAcceptance = undefined;
  });
  closingAcceptance = closing;
  return closing;
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
 * Accept trusted multi-project batches using separate segments per project.
 * Resolve only after all non-rejected records are durable. A failed request
 * can have partial durable progress; retries retain stable span identities.
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
        // sent it while their request is still open. Two doors: a field over a
        // documented bound, and a span whose instant the store cannot hold —
        // one seals into a segment the drainer then cannot read back.
        refuseOversizeRecord(span);
        refuseUnstorableInstant(span);
      } catch (cause) {
        if (
          cause instanceof OversizeRecordError ||
          cause instanceof UnstorableInstantError
        ) {
          refused.push({ reason: cause.message });
          continue;
        }
        throw cause;
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
 * Bound the wait for all staged records to become durable. A timeout leaves
 * them staged for retry and does not cancel an upload already in progress.
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

/** How much of the local log is spoken for, and whether it will take more. */
export type StagedLoad = {
  /** Bytes across every file the log owns, sealed ones included. */
  readonly bytes: number;
  /** Frames staged and not yet released. */
  readonly records: number;
  /**
   * True when the log cannot fit the readiness reserve or another frame.
   * The reserve covers bounded fields and escaping, not unlimited payloads;
   * a green check does not guarantee that every possible record fits.
   */
  readonly full: boolean;
};

/**
 * Read log usage and capacity through the log's own admission rule.
 * Undefined means no acceptance loop is open, distinct from an empty log.
 */
export function stagedLoad(): StagedLoad | undefined {
  const held = standing;
  if (held === undefined) return undefined;
  const { bytes, records } = held.log;
  return {
    bytes,
    records,
    // Room for the largest record the path will stage, so readiness goes
    // unavailable before the door starts refusing rather than after. On a
    // boundary this fine that is one record early, which is the side to be
    // wrong on: an instance called ready while refusing is one nothing can
    // detect from outside.
    full: !held.log.accepts(LARGEST_STAGEABLE_RECORD_BYTES),
  };
}

/**
 * Test-only view of staged records and their trusted scope across projects.
 * Order is per group, not global arrival order. Do not expose through routes.
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
