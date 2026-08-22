import { createHash } from "node:crypto";
import { gzipSync, constants as zlibConstants } from "node:zlib";

import { newId } from "@egma/ids";

import {
  canonicalRecordJson,
  recordFrom,
  MalformedRecordError,
  RECORD_FORMAT_VERSION,
  type IngestionRecord,
} from "./record.ts";

/**
 * The unit that crosses the acceptance boundary: one project's staged records,
 * sealed into one immutable object.
 *
 * A segment is what makes group commit possible and what makes the object store
 * a spool rather than a second trace archive. It is sealed once — identity,
 * bytes and checksum all fixed at the same instant — and after that it is only
 * uploaded, read and deleted. Nothing appends to a sealed segment and nothing
 * rewrites one, which is what lets an ambiguous upload be retried against the
 * same key with the same bytes and be *success* rather than a second object
 * holding the same evidence.
 *
 * ## One project, and the reason tenancy is not in the key
 *
 * Records are grouped by the `(organization, project)` the **authenticated
 * request** resolved to, never by anything an evidence attribute claimed. Two
 * projects never share an object, so a segment cannot leak one tenant's
 * evidence into another's read.
 *
 * That scope is written **inside** the sealed object and the key carries only
 * the segment's identity — `pending/<segment id>.ndjson.gz`, one flat prefix.
 * A key that named the tenant would be a second statement of the same fact, and
 * two statements can disagree: a renamed, copied or hand-restored object would
 * then carry one tenancy in its name and another in its body, and whichever the
 * drainer believed would be a coin toss. There is one statement, it is sealed
 * with the evidence, and the checksum covers it.
 *
 * The flat prefix is also what makes recovery one paginated listing rather than
 * a walk of a tree whose shape nobody can enumerate. Segment ids sort by mint
 * time, so that listing is oldest-first for free.
 *
 * ## The bytes
 *
 * Gzip-compressed NDJSON. The first line is the header — format version,
 * segment identity, trusted scope, record count and the checksum of everything
 * after it. Then one canonical record per line.
 *
 * The header cannot cover itself, so `content_sha256` is over the **record
 * lines only**, uncompressed, exactly as they are written. A reader
 * decompresses, splits off the first line, hashes the rest and compares. That
 * is a check on the evidence rather than on the compression, so it still holds
 * if a store or a proxy ever re-encodes the transfer.
 *
 * **The compressed object is deterministic for one sealed segment**, which is
 * what makes "same identity, same bytes" a fact a retry can be judged against
 * rather than a hope. Two things buy that: the record order is fixed at seal
 * time, and gzip is asked for one fixed level with the modification-time field
 * of its header left at zero. Node writes that field as zero and has no option
 * to write anything else — so `ingestion-segment.test.ts` asserts the header
 * bytes directly, because determinism here is a contract and not a detail of
 * whichever zlib is linked in.
 */

/**
 * The one prefix pending objects live under.
 *
 * A constant rather than a setting: it is a published storage contract, and a
 * setting would let two deployments reading one bucket disagree about where the
 * work is — one of them would scan an empty prefix and report a clean backlog.
 */
export const PENDING_PREFIX = "pending/";

/** One sealed segment's key. Identity and nothing else; see the module doc. */
export function pendingKeyFor(segmentId: string): string {
  return `${PENDING_PREFIX}${segmentId}.ndjson.gz`;
}

/** A segment id read back out of a key, or `undefined` for a key of another shape. */
export function segmentIdIn(key: string): string | undefined {
  if (!key.startsWith(PENDING_PREFIX) || !key.endsWith(".ndjson.gz")) {
    return undefined;
  }
  return key.slice(PENDING_PREFIX.length, -".ndjson.gz".length);
}

/**
 * Whose evidence this is, as trusted Egma authentication or internal Retell
 * state resolved it — never as an attribute on the evidence claimed it.
 */
export type SegmentScope = {
  readonly organizationId: string;
  readonly projectId: string;
};

/** The first line of every segment. */
export type SegmentHeader = {
  readonly v: number;
  readonly segment_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly record_count: number;
  /** SHA-256, lower-case hex, over the uncompressed record lines. */
  readonly content_sha256: string;
};

/** One sealed segment: its identity, its key and its immutable bytes. */
export type SealedSegment = {
  readonly segmentId: string;
  readonly key: string;
  readonly scope: SegmentScope;
  readonly header: SegmentHeader;
  readonly body: Uint8Array;
};

/** One record staged in the local log, carrying the scope it was accepted in. */
export type StagedRecord = {
  readonly scope: SegmentScope;
  readonly record: IngestionRecord;
};

/**
 * What the local log holds, as one line of JSON per frame.
 *
 * Two kinds, told apart by `e`. A `record` frame is one accepted record and the
 * scope it was accepted in — the scope travels with each record rather than in
 * a side table, so a log recovered after a crash can be regrouped by project
 * without anything else having survived. A `seal` frame is written **before**
 * the upload it belongs to and says which records became which segment, so a
 * retry after an ambiguous upload reaches for the identity that was already
 * chosen instead of minting a second one for the same evidence.
 */
export type StagedFrame =
  | {
      readonly e: "record";
      readonly organization_id: string;
      readonly project_id: string;
      readonly record: IngestionRecord;
    }
  | {
      readonly e: "seal";
      readonly segment_id: string;
      readonly organization_id: string;
      readonly project_id: string;
      readonly record_count: number;
      readonly content_sha256: string;
    };

/** One staged record as the bytes the local log frames. */
export function stagedFramePayload(frame: StagedFrame): Uint8Array {
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/** And back, refusing anything this version does not recognise. */
export function stagedFrameFrom(payload: Uint8Array): StagedFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new MalformedRecordError("a staged frame is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedRecordError("a staged frame is a JSON object");
  }
  const held = parsed as Record<string, unknown>;
  const required = (key: string): string => {
    const value = held[key];
    if (typeof value !== "string" || value === "") {
      throw new MalformedRecordError(`a staged frame has no ${key}`);
    }
    return value;
  };

  if (held["e"] === "record") {
    return {
      e: "record",
      organization_id: required("organization_id"),
      project_id: required("project_id"),
      record: recordFrom(held["record"]),
    };
  }
  if (held["e"] === "seal") {
    const count = held["record_count"];
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new MalformedRecordError(
        `a staged seal states a record count of ${String(count)}`,
      );
    }
    return {
      e: "seal",
      segment_id: required("segment_id"),
      organization_id: required("organization_id"),
      project_id: required("project_id"),
      record_count: count as number,
      content_sha256: required("content_sha256"),
    };
  }
  throw new MalformedRecordError(
    `a staged frame states a kind this version does not know: ${String(held["e"])}`,
  );
}

/**
 * Staged records, grouped into the segments they may be sealed into.
 *
 * Order inside a group is arrival order, and it is load-bearing: it is what
 * fixes the bytes of a sealed segment, so a retry that re-groups the same
 * records produces the same object rather than a second one that only differs
 * in line order. Groups come back in the order their first record arrived, so a
 * flush that can only send one segment sends the oldest project's.
 */
export function groupedByProject(
  staged: readonly StagedRecord[],
): readonly { readonly scope: SegmentScope; readonly records: readonly IngestionRecord[] }[] {
  const groups = new Map<string, { scope: SegmentScope; records: IngestionRecord[] }>();
  for (const one of staged) {
    const key = `${one.scope.organizationId}/${one.scope.projectId}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { scope: one.scope, records: [one.record] });
    } else {
      group.records.push(one.record);
    }
  }
  return [...groups.values()];
}

/** When a group of staged records stops waiting for company. */
export type SegmentBounds = {
  /** Uncompressed NDJSON bytes. Under the store's insert bound; see config. */
  readonly maxBytes: number;
  readonly maxRecords: number;
  /** How long the oldest record in a group waits for a second one. */
  readonly flushMilliseconds: number;
};

/** What a standing loop knows about one project's waiting records. */
export type PendingGroup = {
  readonly records: number;
  /** Uncompressed bytes of the canonical record lines waiting. */
  readonly bytes: number;
  /** When the oldest record in this group was staged. */
  readonly oldestAtMilliseconds: number;
};

/**
 * Whether this group should be sealed now.
 *
 * A pure function of the group and the clock, so the rule is testable without a
 * timer and the standing loop that calls it holds no rule of its own. Either
 * bound reached is enough, and the time bound is what a low-volume deployment
 * lives on: one conversation's spans must not wait for a batch that will never
 * fill.
 *
 * Reaching a size bound seals a segment that has **already crossed** it by at
 * most one record. That is deliberate — the alternative is to hold the record
 * that crossed the bound back into the next segment, which makes the bytes of a
 * segment depend on what arrived after it, and a retry that re-groups the same
 * records would then seal different bytes. The bound is set far enough under
 * the store's own insert bound to absorb one record.
 */
export function shouldSeal(
  group: PendingGroup,
  bounds: SegmentBounds,
  nowMilliseconds: number,
): boolean {
  if (group.records === 0) return false;
  if (group.records >= bounds.maxRecords) return true;
  if (group.bytes >= bounds.maxBytes) return true;
  return nowMilliseconds - group.oldestAtMilliseconds >= bounds.flushMilliseconds;
}

/**
 * How long until this group has to be sealed, for a loop deciding when to wake.
 *
 * `0` where it is already due and `undefined` where there is nothing waiting.
 * Kept beside `shouldSeal` and derived from the same fields, because a loop
 * that slept on one rule and sealed on another would hold a low-volume
 * deployment for a whole scan interval and nothing would say why.
 */
export function millisecondsUntilSeal(
  group: PendingGroup,
  bounds: SegmentBounds,
  nowMilliseconds: number,
): number | undefined {
  if (group.records === 0) return undefined;
  if (shouldSeal(group, bounds, nowMilliseconds)) return 0;
  return Math.max(
    0,
    group.oldestAtMilliseconds + bounds.flushMilliseconds - nowMilliseconds,
  );
}

/** The uncompressed byte cost of one record, for the size bound above. */
export function recordBytes(record: IngestionRecord): number {
  return Buffer.byteLength(canonicalRecordJson(record), "utf8") + 1;
}

/**
 * Seal one project's records into one immutable object.
 *
 * The identity is minted here and returned, so the caller writes it into the
 * local log before the upload starts and hands the same value to every retry.
 * A caller replaying a seal it already recorded passes that identity back in,
 * and the same records in the same order then produce the same bytes. An
 * identity chosen after an upload could not do that: the one moment it is
 * needed is the moment nobody knows whether the upload happened.
 */
export function sealSegment(options: {
  readonly scope: SegmentScope;
  readonly records: readonly IngestionRecord[];
  /** A previously persisted identity, for a retry. Absent mints a new one. */
  readonly segmentId?: string;
}): SealedSegment {
  const segmentId = options.segmentId ?? newId("sgm");
  const lines = options.records.map((record) => canonicalRecordJson(record));
  const body = `${lines.join("\n")}\n`;

  const header: SegmentHeader = {
    v: RECORD_FORMAT_VERSION,
    segment_id: segmentId,
    organization_id: options.scope.organizationId,
    project_id: options.scope.projectId,
    record_count: options.records.length,
    content_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };

  return {
    segmentId,
    key: pendingKeyFor(segmentId),
    scope: options.scope,
    header,
    body: gzipSync(Buffer.from(`${JSON.stringify(header)}\n${body}`, "utf8"), {
      // One fixed level, so two sealings of one segment cannot differ by the
      // compressor's mood. The gzip header's modification-time field is the
      // other half of determinism and Node writes it as zero with no option to
      // do otherwise; the segment suite asserts those bytes rather than trust
      // it.
      level: zlibConstants.Z_BEST_COMPRESSION,
    }),
  };
}
