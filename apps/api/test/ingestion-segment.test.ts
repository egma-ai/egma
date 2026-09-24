import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { spanContentHash } from "@egma/db";

import {
  contentHashOf,
  recordFor,
  RECORD_FORMAT_VERSION,
  spanFor,
} from "@egma/ingestion";
import {
  UnreadableSegmentError,
  verifiedSegment,
} from "../src/ingestion/verify.ts";
import {
  groupedByProject,
  millisecondsUntilSeal,
  sealSegment,
  shouldSeal,
  stagedFrameFrom,
  stagedFramePayload,
  type SegmentScope,
} from "@egma/ingestion";
import { openWriteAheadLog } from "@egma/ingestion";
import { aRecord } from "./support/ingestion.ts";

/**
 * Decompress segments independently of the production reader to check format
 * version, project attribution, identities, checksum, and count. Payloads
 * remain customer evidence and may contain customer data.
 */

const SCOPE: SegmentScope = {
  organizationId: "org_01K3XQ7M4E8YB2FVN0H9TZQWER",
  projectId: "prj_01K3XQ7M4E8YB2FVN0H9TZQWES",
};

const OTHER_PROJECT: SegmentScope = {
  organizationId: SCOPE.organizationId,
  projectId: "prj_01K3XQ7M4E8YB2FVN0H9TZQWET",
};

/** The same scope as the local log writes it down. */
const SCOPE_AS_FRAME = {
  organization_id: SCOPE.organizationId,
  project_id: SCOPE.projectId,
} as const;

/** The object as it is read: the header line, then one record per line. */
function opened(body: Uint8Array): {
  readonly header: Record<string, unknown>;
  readonly records: readonly Record<string, unknown>[];
} {
  const lines = gunzipSync(Buffer.from(body)).toString("utf8").split("\n");
  expect(lines[lines.length - 1], "the object ends with a newline").toBe("");
  const [header, ...records] = lines.slice(0, -1);
  return {
    header: JSON.parse(header as string) as Record<string, unknown>,
    records: records.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    ),
  };
}

describe("what a segment is allowed to contain", () => {
  it("holds one project, and two projects get two segments", () => {
    const groups = groupedByProject([
      { scope: SCOPE, record: aRecord({ span_id: "a1" }) },
      { scope: OTHER_PROJECT, record: aRecord({ span_id: "b1" }) },
      { scope: SCOPE, record: aRecord({ span_id: "a2" }) },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.scope).toEqual(SCOPE);
    expect(groups[0]?.records.map((record) => record.span_id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(groups[1]?.scope).toEqual(OTHER_PROJECT);
    expect(groups[1]?.records.map((record) => record.span_id)).toEqual(["b1"]);
  });

  it("carries its version, its scope, its count and its checksum", () => {
    const records = [aRecord({ span_id: "a1" }), aRecord({ span_id: "a2" })];
    const sealed = sealSegment({ scope: SCOPE, records });

    const { header, records: read } = opened(sealed.body);

    expect(header["v"]).toBe(RECORD_FORMAT_VERSION);
    expect(header["segment_id"]).toBe(sealed.segmentId);
    expect(header["organization_id"]).toBe(SCOPE.organizationId);
    expect(header["project_id"]).toBe(SCOPE.projectId);
    expect(header["record_count"]).toBe(2);
    expect(read).toHaveLength(2);

    // The checksum covers the header as well as the records, which is what
    // makes the scope above a fact rather than a label: an object whose
    // `organization_id` had been edited would fail this comparison, and the
    // drainer builds the context it writes under out of exactly that field.
    // A field cannot cover itself, so what is hashed is everything except the
    // checksum, in one fixed order, then the record lines.
    const body = gunzipSync(Buffer.from(sealed.body)).toString("utf8");
    const afterTheHeader = body.slice(body.indexOf("\n") + 1);
    const bound = JSON.stringify({
      organization_id: SCOPE.organizationId,
      project_id: SCOPE.projectId,
      record_count: 2,
      segment_id: sealed.segmentId,
      v: RECORD_FORMAT_VERSION,
    });
    expect(header["content_sha256"]).toBe(
      createHash("sha256")
        .update(`${bound}\n${afterTheHeader}`, "utf8")
        .digest("hex"),
    );
  });

  it("binds the scope it was sealed for, so an edited header cannot be read", () => {
    // The whole point of the digest reaching over the header: a pending object
    // whose tenancy has been rewritten — by a copy, a restore, or a hand — is
    // refused rather than filed under whoever the new name says.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    const lines = gunzipSync(Buffer.from(sealed.body)).toString("utf8").split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    const rewritten = gzipSync(
      Buffer.from(
        [
          JSON.stringify({ ...header, organization_id: "org_somebody_else" }),
          ...lines.slice(1),
        ].join("\n"),
        "utf8",
      ),
    );

    expect(() => verifiedSegment(sealed.key, rewritten)).toThrow(
      UnreadableSegmentError,
    );
  });
});

describe("when a group of staged records stops waiting", () => {
  const BOUNDS = {
    maxBytes: 8_388_608,
    maxRecords: 5_000,
    flushMilliseconds: 500,
  };
  const NOW = 1_755_820_800_000;

  it("does not wait for the timer once a bound is reached", () => {
    expect(
      shouldSeal(
        { records: 5_000, bytes: 400, oldestAtMilliseconds: NOW },
        BOUNDS,
        NOW,
      ),
    ).toBe(true);
    expect(
      shouldSeal(
        { records: 2, bytes: 8_388_608, oldestAtMilliseconds: NOW },
        BOUNDS,
        NOW,
      ),
    ).toBe(true);
  });

  it("never seals an empty group, however long it has been empty", () => {
    const empty = { records: 0, bytes: 0, oldestAtMilliseconds: NOW };

    expect(shouldSeal(empty, BOUNDS, NOW + 100_000)).toBe(false);
    expect(millisecondsUntilSeal(empty, BOUNDS, NOW)).toBeUndefined();
  });
});

describe("a segment rebuilt from a log the last process left behind", () => {
  it("is the same object, under the identity that was written down first", () => {
    // The whole point of persisting the identity before the upload. A process
    // that died between sealing and an answer comes back, reads its own log,
    // and asks the store to create *the same key with the same bytes* — which
    // the store can answer as success rather than as a second object holding
    // evidence that is already there.
    const directory = mkdtempSync(path.join(tmpdir(), "egma-ingestion-seal-"));
    try {
      const records = [aRecord({ span_id: "a1" }), aRecord({ span_id: "a2" })];
      const before = openWriteAheadLog(directory, {
        maxBytes: 1_000_000,
        maxRecords: 1_000,
        maxFileBytes: 65_536,
      });
      for (const record of records) {
        before.append(
          stagedFramePayload({ e: "record", ...SCOPE_AS_FRAME, record }),
        );
      }
      const sealed = sealSegment({ scope: SCOPE, records });
      before.append(
        stagedFramePayload({
          e: "seal",
          segment_id: sealed.segmentId,
          ...SCOPE_AS_FRAME,
          record_count: sealed.header.record_count,
          content_sha256: sealed.header.content_sha256,
        }),
      );
      before.close();

      const after = openWriteAheadLog(directory, {
        maxBytes: 1_000_000,
        maxRecords: 1_000,
        maxFileBytes: 65_536,
      });
      const frames = after
        .staged()
        .map((entry) => stagedFrameFrom(entry.payload));
      const seal = frames.find((frame) => frame.e === "seal");
      const recovered = sealSegment({
        scope: SCOPE,
        records: frames.flatMap((frame) =>
          frame.e === "record" ? [frame.record] : [],
        ),
        segmentId: seal?.e === "seal" ? seal.segment_id : "",
      });

      expect(recovered.key).toBe(sealed.key);
      expect(Buffer.from(recovered.body).equals(Buffer.from(sealed.body))).toBe(
        true,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("what makes two copies of one span the same evidence", () => {
  it("is the same value on the record and on the row it becomes", () => {
    // The two spellings of one span meet here. If they ever disagreed, one side
    // would be deciding that a conflicting account of an immutable identity is
    // an exact replay — so the arithmetic is written once, beside the span
    // type, and this holds the record's way of asking it against it.
    const record = aRecord();

    expect(contentHashOf(record)).toBe(spanContentHash(spanFor(record)));
    expect(recordFor(spanFor(record))).toEqual(record);
  });
});
