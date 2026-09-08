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
 * Immutable object containing one project's staged records. Its key is
 * pending/<segment id>.ndjson.gz; organization and project scope live in
 * the header and come from trusted acceptance context.
 *
 * Gzip contains a header followed by canonical NDJSON records. SHA-256 covers
 * the canonical header without content_sha256 plus the record lines, including
 * scope. This detects corruption; it is not authentication against a writer
 * that can replace the object and recompute the digest.
 *
 * Sealing fixes identity, record order, and compressed bytes for upload retries.
 * Tests pin gzip header behavior as part of deterministic serialization.
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

/**
 * Everything the checksum binds: the header without the checksum itself.
 *
 * Its own type so that the one thing which may not be inside the digest is
 * absent by construction rather than deleted by whoever remembers to.
 */
export type SegmentBinding = {
  readonly v: number;
  readonly segment_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly record_count: number;
};

/** The first line of every segment. */
export type SegmentHeader = SegmentBinding & {
  /** SHA-256, lower-case hex. See `segmentChecksum`. */
  readonly content_sha256: string;
};

/**
 * Hash the header in fixed field order followed by canonical record lines.
 * Exclude the checksum field itself.
 */
export function segmentChecksum(
  binding: SegmentBinding,
  recordLines: string,
): string {
  const bound = JSON.stringify({
    organization_id: binding.organization_id,
    project_id: binding.project_id,
    record_count: binding.record_count,
    segment_id: binding.segment_id,
    v: binding.v,
  });
  return createHash("sha256")
    .update(`${bound}\n${recordLines}`, "utf8")
    .digest("hex");
}

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
 * Local log frames use e to distinguish records with scope from seals.
 * Write the seal identity and record count before uploading so crash recovery
 * can retry the same segment.
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
 * Seal a nonempty group when its record, byte, or age bound is reached.
 * The timer ensures low-volume groups do not wait indefinitely for more records.
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
 * Seal ordered records using a new or recovered segment ID. Persist the ID
 * before upload; retries must retain the same records, order, and identity.
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

  const binding: SegmentBinding = {
    v: RECORD_FORMAT_VERSION,
    segment_id: segmentId,
    organization_id: options.scope.organizationId,
    project_id: options.scope.projectId,
    record_count: options.records.length,
  };
  const header: SegmentHeader = {
    ...binding,
    content_sha256: segmentChecksum(binding, body),
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
