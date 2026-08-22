import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { spanContentHash } from "@egma/db";
import { isId } from "@egma/ids";

import {
  contentHashOf,
  MalformedRecordError,
  recordFor,
  RECORD_FORMAT_VERSION,
  spanFor,
} from "../src/ingestion/record.ts";
import {
  UnreadableSegmentError,
  verifiedSegment,
} from "../src/ingestion/verify.ts";
import {
  groupedByProject,
  millisecondsUntilSeal,
  PENDING_PREFIX,
  recordBytes,
  sealSegment,
  segmentIdIn,
  shouldSeal,
  stagedFrameFrom,
  stagedFramePayload,
  type SegmentScope,
} from "../src/ingestion/segment.ts";
import { openWriteAheadLog } from "../src/ingestion/write-ahead-log.ts";
import { aRecord } from "./support/ingestion.ts";

/**
 * A pending object, inspected the way an operator would inspect one.
 *
 * The bytes are the contract. Everything downstream of acceptance — the
 * drainer, a repair by hand, a reader written years from now — meets a segment
 * as a compressed file in a bucket and nothing else, so what this suite asserts
 * is what is *in* the file: one version, one project, stable identities, a
 * checksum that holds, a record count that matches, and no field anywhere that
 * a transport credential could occupy.
 *
 * It decompresses and reads rather than calling a reader of our own, on
 * purpose. A reader that agreed with the writer about a mistake would prove
 * nothing, and the mistake this file is here to catch is exactly the kind two
 * halves of one implementation make together.
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

  it("has no field a transport credential could occupy", () => {
    // The property, stated as the shape rather than as a search for strings.
    // Nothing is scrubbed out of a segment and nothing is scanned for
    // credential-looking values — the contract simply has no slot for an
    // authorization header, a service token, a provider key or the store's own
    // credential, so none of them can be written into a bucket by accident.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    const { header, records } = opened(sealed.body);

    expect(Object.keys(header).sort()).toEqual([
      "content_sha256",
      "organization_id",
      "project_id",
      "record_count",
      "segment_id",
      "v",
    ]);
    expect(Object.keys(records[0] as Record<string, unknown>).sort()).toEqual([
      "agent_id",
      "agent_platform",
      "agent_version_id",
      "audio_url",
      "connection_kind",
      "duration_nanoseconds",
      "emitter",
      "ends_trace",
      "environment",
      "kind",
      "name",
      "parent_span_id",
      "payload",
      "persona_version_id",
      "platform_agent_id",
      "platform_agent_name",
      "platform_agent_version",
      "provider_call_id",
      "run_id",
      "source",
      "span_id",
      "started_at_microseconds",
      "status",
      "test_version_id",
      "text",
      "tool_arguments",
      "tool_name",
      "tool_result",
      "trace_id",
      "v",
    ]);
  });

  it("keeps evidence that looks like a credential exactly as it arrived", () => {
    // The transcript does not change because it contains the word `password`,
    // and the tool arguments do not change because a key in them is called
    // `api-key`. Egma removes operational authorization by construction and
    // never by looking at what evidence says.
    const record = aRecord();
    const sealed = sealSegment({ scope: SCOPE, records: [record] });
    const { records } = opened(sealed.body);

    expect(records[0]?.["text"]).toBe(record.text);
    expect(records[0]?.["tool_arguments"]).toBe(record.tool_arguments);
    expect(records[0]?.["tool_result"]).toBe(record.tool_result);
    expect(records[0]?.["payload"]).toBe(record.payload);
    expect(String(records[0]?.["text"])).toContain("password");
    expect(String(records[0]?.["text"])).toContain("Bearer");
  });

  it("carries a 64-bit count as a decimal string, not as a JSON number", () => {
    // A microsecond timestamp through a JSON double comes back a few
    // microseconds away from where it started — invisible in a transcript, and
    // enough to make an exact replay hash differently from the evidence it
    // replays.
    const started = "1755820800123456";
    const sealed = sealSegment({
      scope: SCOPE,
      records: [aRecord({ started_at_microseconds: started })],
    });

    const { records } = opened(sealed.body);
    expect(records[0]?.["started_at_microseconds"]).toBe(started);
    expect(BigInt(String(records[0]?.["started_at_microseconds"]))).toBe(
      1_755_820_800_123_456n,
    );
  });
});

describe("the same segment sealed twice", () => {
  it("is byte-identical, which is what makes a retry answerable", () => {
    const records = [aRecord({ span_id: "a1" }), aRecord({ span_id: "a2" })];
    const first = sealSegment({ scope: SCOPE, records });
    const again = sealSegment({
      scope: SCOPE,
      records,
      segmentId: first.segmentId,
    });

    expect(Buffer.from(again.body).equals(Buffer.from(first.body))).toBe(true);
    expect(again.key).toBe(first.key);
    expect(again.header).toEqual(first.header);
  });

  it("leaves no clock in the compressed bytes", () => {
    // The gzip header carries a modification time, and a compressor that wrote
    // one would make two sealings of one segment differ by the second they
    // happened in — turning every ambiguous retry into an integrity defect.
    // Asserted on the bytes because determinism here is a contract rather than
    // a property of whichever zlib is linked in.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    const header = Buffer.from(sealed.body).subarray(0, 10);

    expect(header.readUInt16BE(0)).toBe(0x1f8b);
    expect(header.readUInt32LE(4), "the gzip modification time").toBe(0);
  });

  it("mints a fresh identity where none was persisted", () => {
    // Identity is minted and written down, never derived from the content. Two
    // sealings of the same evidence are two segments unless a caller says
    // otherwise, because the caller is the only side that knows whether it is
    // retrying.
    const records = [aRecord()];
    const first = sealSegment({ scope: SCOPE, records });
    const second = sealSegment({ scope: SCOPE, records });

    expect(second.segmentId).not.toBe(first.segmentId);
    expect(isId("sgm", first.segmentId)).toBe(true);
  });
});

describe("where a segment lives in the bucket", () => {
  it("is one flat prefix, with the identity and nothing else in the key", () => {
    // Tenancy is inside the sealed object and never in the key. A key that
    // named the tenant would be a second statement of the same fact, and a
    // copied or hand-restored object could then carry one tenancy in its name
    // and another in its body.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });

    expect(sealed.key).toBe(`${PENDING_PREFIX}${sealed.segmentId}.ndjson.gz`);
    expect(sealed.key).not.toContain(SCOPE.organizationId);
    expect(sealed.key).not.toContain(SCOPE.projectId);
    expect(segmentIdIn(sealed.key)).toBe(sealed.segmentId);
    expect(segmentIdIn("something/else.txt")).toBeUndefined();
  });

  it("sorts by mint time, so one listing walks the backlog oldest first", () => {
    const keys = [
      sealSegment({ scope: SCOPE, records: [aRecord()] }).key,
      sealSegment({ scope: SCOPE, records: [aRecord()] }).key,
      sealSegment({ scope: SCOPE, records: [aRecord()] }).key,
    ];

    expect([...keys].sort()).toEqual(keys);
  });
});

describe("when a group of staged records stops waiting", () => {
  const BOUNDS = {
    maxBytes: 8_388_608,
    maxRecords: 5_000,
    flushMilliseconds: 500,
  };
  const NOW = 1_755_820_800_000;

  it("waits for the timer when there is only one small conversation", () => {
    const group = { records: 1, bytes: 400, oldestAtMilliseconds: NOW };

    expect(shouldSeal(group, BOUNDS, NOW + 499)).toBe(false);
    expect(shouldSeal(group, BOUNDS, NOW + 500)).toBe(true);
    expect(millisecondsUntilSeal(group, BOUNDS, NOW + 499)).toBe(1);
    expect(millisecondsUntilSeal(group, BOUNDS, NOW + 500)).toBe(0);
  });

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

  it("measures a record as the bytes the segment will carry", () => {
    // The size bound is spent in the units the object is written in, so a
    // transcript of CJK or emoji costs what it really costs rather than what
    // its length in code units suggests.
    expect(recordBytes(aRecord({ text: "hello" }))).toBeLessThan(
      recordBytes(aRecord({ text: "こんにちは" })),
    );
  });
});

describe("what the local log holds on a segment's behalf", () => {
  it("carries each record's own scope, so a recovered log can be regrouped", () => {
    const staged = { e: "record", ...SCOPE_AS_FRAME, record: aRecord() } as const;
    const back = stagedFrameFrom(stagedFramePayload(staged));

    expect(back).toEqual(staged);
  });

  it("carries the identity a segment was sealed under, before it was uploaded", () => {
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    const seal = {
      e: "seal",
      segment_id: sealed.segmentId,
      ...SCOPE_AS_FRAME,
      record_count: sealed.header.record_count,
      content_sha256: sealed.header.content_sha256,
    } as const;

    expect(stagedFrameFrom(stagedFramePayload(seal))).toEqual(seal);
  });

  it("refuses a frame it does not recognise rather than guessing at one", () => {
    expect(() => stagedFrameFrom(new Uint8Array([0x7b, 0x7d]))).toThrow(
      MalformedRecordError,
    );
    expect(() =>
      stagedFrameFrom(Buffer.from('{"e":"record"}', "utf8")),
    ).toThrow(MalformedRecordError);
    expect(() => stagedFrameFrom(Buffer.from("not json", "utf8"))).toThrow(
      MalformedRecordError,
    );
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
  it("is the same hash for the same record, whatever order it was built in", () => {
    const built = aRecord();
    const rebuilt = Object.fromEntries(
      Object.entries(built).reverse(),
    ) as typeof built;

    expect(contentHashOf(rebuilt)).toBe(contentHashOf(built));
  });

  it("changes when any evidence changes", () => {
    const original = aRecord();

    expect(contentHashOf(aRecord({ text: "something else" }))).not.toBe(
      contentHashOf(original),
    );
    expect(contentHashOf(aRecord({ ends_trace: true }))).not.toBe(
      contentHashOf(original),
    );
  });

  it("is the same value on the record and on the row it becomes", () => {
    // The two spellings of one span meet here. If they ever disagreed, one side
    // would be deciding that a conflicting account of an immutable identity is
    // an exact replay — so the arithmetic is written once, beside the span
    // type, and this holds the record's way of asking it against it.
    const record = aRecord();

    expect(contentHashOf(record)).toBe(spanContentHash(spanFor(record)));
    expect(recordFor(spanFor(record))).toEqual(record);
  });

  it("does not move when only the format version does", () => {
    // A version says how evidence is written down, not what it says. Two
    // segments written under two versions carrying one span's evidence are an
    // exact replay of each other.
    const record = aRecord();

    expect(contentHashOf({ ...record, v: 99 })).toBe(contentHashOf(record));
  });
});
