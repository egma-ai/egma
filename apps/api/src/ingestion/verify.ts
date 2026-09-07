import { gunzipSync } from "node:zlib";

import {
  recordFrom,
  RECORD_FORMAT_VERSION,
  type IngestionRecord,
} from "./record.ts";
import {
  segmentChecksum,
  segmentIdIn,
  type SegmentBinding,
  type SegmentHeader,
  type SegmentScope,
} from "./segment.ts";

/**
 * Verify gzip, header shape/version, key-to-segment identity, checksum, count,
 * and record shape before forming rows. Invalid objects are retained for
 * operator action rather than repaired or partially ingested.
 * The checksum covers header scope but is not an authentication signature.
 * The drainer separately checks project ownership in PostgreSQL.
 */

/** One pending object, opened and checked far enough to be written. */
export type VerifiedSegment = {
  readonly key: string;
  readonly segmentId: string;
  /** From the sealed header, never from the key. */
  readonly scope: SegmentScope;
  readonly records: readonly IngestionRecord[];
};

/**
 * A pending object this Egma will not turn into rows.
 *
 * Always an internal defect and never a customer's mistake — see the module
 * doc. It carries a low-cardinality `reason` beside the sentence so an operator
 * surface can count the kinds without ever putting an object key in a metric
 * label.
 */
export class UnreadableSegmentError extends Error {
  readonly reason: SegmentDefect;
  readonly key: string;

  constructor(reason: SegmentDefect, key: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnreadableSegmentError";
    this.reason = reason;
    this.key = key;
  }
}

/**
 * Why an object could not be read, as a fixed and small set.
 *
 * Fixed because it is a metric label. A reason derived from a message, a key or
 * an error's own text would put an unbounded set of values into a time series,
 * and the first bucket with a thousand damaged objects in it would be the one
 * that took the metrics down.
 */
export type SegmentDefect =
  | "not_a_pending_key"
  | "not_gzip"
  | "no_header"
  | "unsupported_version"
  | "identity_mismatch"
  | "checksum_mismatch"
  | "record_count_mismatch"
  | "malformed_record";

function headerFrom(key: string, line: string): SegmentHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new UnreadableSegmentError(
      "no_header",
      key,
      "this segment's first line is not a JSON header",
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UnreadableSegmentError(
      "no_header",
      key,
      "this segment's first line is not a JSON object",
    );
  }

  const held = parsed as Record<string, unknown>;
  const text = (name: string): string => {
    const value = held[name];
    if (typeof value !== "string" || value === "") {
      throw new UnreadableSegmentError(
        "no_header",
        key,
        `this segment's header has no ${name}`,
      );
    }
    return value;
  };
  const count = held["record_count"];
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new UnreadableSegmentError(
      "no_header",
      key,
      `this segment's header states a record count of ${String(count)}`,
    );
  }
  if (held["v"] !== RECORD_FORMAT_VERSION) {
    throw new UnreadableSegmentError(
      "unsupported_version",
      key,
      `this segment states format version ${String(held["v"])} and this Egma ` +
        `reads ${RECORD_FORMAT_VERSION}. It is left where it is: the ` +
        `deployment that can read it is the one that should.`,
    );
  }

  return {
    v: RECORD_FORMAT_VERSION,
    segment_id: text("segment_id"),
    organization_id: text("organization_id"),
    project_id: text("project_id"),
    record_count: count as number,
    content_sha256: text("content_sha256"),
  };
}

/** One pending object, opened. Every failure is an `UnreadableSegmentError`. */
export function verifiedSegment(key: string, body: Uint8Array): VerifiedSegment {
  const segmentId = segmentIdIn(key);
  if (segmentId === undefined) {
    throw new UnreadableSegmentError(
      "not_a_pending_key",
      key,
      "this key is not one the pending prefix spells",
    );
  }

  let opened: Buffer;
  try {
    opened = gunzipSync(Buffer.from(body));
  } catch (cause) {
    throw new UnreadableSegmentError(
      "not_gzip",
      key,
      "this segment does not decompress",
      { cause },
    );
  }

  const text = opened.toString("utf8");
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) {
    throw new UnreadableSegmentError(
      "no_header",
      key,
      "this segment has no line after its first",
    );
  }
  const header = headerFrom(key, text.slice(0, firstBreak));

  if (header.segment_id !== segmentId) {
    throw new UnreadableSegmentError(
      "identity_mismatch",
      key,
      `this object's key spells segment ${segmentId} and its header states ` +
        `${header.segment_id}`,
    );
  }

  // Everything after the first line, byte for byte as it was hashed — the
  // trailing newline included, because it was written and therefore counted.
  const body_ = text.slice(firstBreak + 1);
  // Rebuilt from the fields checked above rather than re-serialised from what
  // was parsed, so the string hashed here is the string the writer hashed
  // whatever order the object arrived in.
  const binding: SegmentBinding = {
    v: header.v,
    segment_id: header.segment_id,
    organization_id: header.organization_id,
    project_id: header.project_id,
    record_count: header.record_count,
  };
  const digest = segmentChecksum(binding, body_);
  if (digest !== header.content_sha256) {
    throw new UnreadableSegmentError(
      "checksum_mismatch",
      key,
      `this segment hashes to ${digest} and its header states ` +
        `${header.content_sha256}`,
    );
  }

  // A sealed segment always ends its last record with a newline, so the split
  // leaves one empty tail to drop. A segment of no records is a header and
  // nothing after it.
  const lines = body_ === "" ? [] : body_.split("\n").slice(0, -1);
  if (lines.length !== header.record_count) {
    throw new UnreadableSegmentError(
      "record_count_mismatch",
      key,
      `this segment holds ${lines.length} record lines and its header states ` +
        `${header.record_count}`,
    );
  }

  const records: IngestionRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(recordFrom(JSON.parse(line)));
    } catch (cause) {
      throw new UnreadableSegmentError(
        "malformed_record",
        key,
        `this segment's record ${index} is not one this Egma reads: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  return {
    key,
    segmentId,
    scope: {
      organizationId: header.organization_id,
      projectId: header.project_id,
    },
    records,
  };
}
