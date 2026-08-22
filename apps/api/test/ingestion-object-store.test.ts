import { afterAll, describe, expect, it } from "vitest";

import {
  pendingObjectStore,
  SegmentIdentityConflictError,
} from "../src/ingestion/object-store.ts";
import { PENDING_PREFIX, sealSegment } from "../src/ingestion/segment.ts";
import { aRecord } from "./support/ingestion.ts";
import {
  BUCKET,
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";

/**
 * The ingestion bucket, against a store that answers for itself.
 *
 * There is no fake here for the reason there is none for recordings: every
 * question this module asks is one only a store can answer. Whether
 * `If-None-Match: *` really refuses a second write, whether a listing really
 * hands back a continuation token, whether a policy confined to one prefix
 * really refuses a key outside it — a stand-in would agree with whatever this
 * code believed about all three, and the belief is the thing under test.
 *
 * It skips, visibly and with a sentence, where no store can be started, and a
 * run that sets `EGMA_REQUIRE_OBJECT_STORAGE` gets a red line instead. That is
 * the recording suite's arrangement and its promise: contributing costs no new
 * infrastructure.
 */

const storage: ObjectStorage = await startObjectStorage("api-ingestion");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the ingestion bucket suite — ${storage.why}\n\n`,
  );
}

afterAll(() => {
  if (storage.available) storage.stop();
});

const SCOPE = {
  organizationId: "org_01K3XQ7M4E8YB2FVN0H9TZQWER",
  projectId: "prj_01K3XQ7M4E8YB2FVN0H9TZQWES",
};

describe.skipIf(!storage.available)("a segment reaching the bucket", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;
  const bucket = pendingObjectStore(running.ingestStore);

  it("creates the object, and reads back exactly the bytes it sealed", async () => {
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });

    expect(await bucket.create(sealed)).toBe("created");
    expect(
      Buffer.from(await bucket.read(sealed.key)).equals(
        Buffer.from(sealed.body),
      ),
    ).toBe(true);

    await bucket.delete(sealed.key);
  });

  it("answers a retry of the same segment as success, not as a second object", async () => {
    // The ambiguous upload: the store took the object and the answer never
    // arrived. The retry asks to create the same key with the same bytes, and
    // what it must not do is fail — the work is done — or write a second
    // object holding the same evidence.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });

    expect(await bucket.create(sealed)).toBe("created");
    expect(await bucket.create(sealed)).toBe("present");
    expect(
      (await bucket.list()).filter((object) => object.key === sealed.key),
    ).toHaveLength(1);

    await bucket.delete(sealed.key);
  });

  it("refuses different bytes under one identity, and keeps what is already there", async () => {
    // An internal defect and never a sender's problem: identities are minted
    // by Egma, so two different sealings claiming one is a fault here. The
    // first thing that arrived stays, untouched, because it is the evidence
    // that was accepted.
    const first = sealSegment({ scope: SCOPE, records: [aRecord()] });
    const second = sealSegment({
      scope: SCOPE,
      records: [aRecord({ text: "different evidence altogether" })],
      segmentId: first.segmentId,
    });

    expect(await bucket.create(first)).toBe("created");
    await expect(bucket.create(second)).rejects.toBeInstanceOf(
      SegmentIdentityConflictError,
    );
    expect(
      Buffer.from(await bucket.read(first.key)).equals(Buffer.from(first.body)),
    ).toBe(true);

    await bucket.delete(first.key);
  });

  it("puts no credential of its own in the object", async () => {
    // The store's credential is in this process and must not be in the spool.
    // The record contract has no field for one, so this is the belt to that
    // brace: the bytes are searched for the two values that would prove
    // otherwise.
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    await bucket.create(sealed);

    const held = Buffer.from(await bucket.read(sealed.key)).toString("latin1");
    expect(held).not.toContain(running.ingestStore.accessKeyId);
    expect(held).not.toContain(running.ingestStore.secretAccessKey);

    await bucket.delete(sealed.key);
  });
});

describe.skipIf(!storage.available)("finding what is pending", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  it("follows every listing page, so a backlog cannot hide behind the first", async () => {
    // The failure this rules out is quiet and expensive: a recovery scan that
    // reads one page reports a clean prefix while everything after it sits
    // there. The page size is forced small rather than the bucket filled, but
    // the pagination it exercises is the store's own.
    const bucket = pendingObjectStore(running.ingestStore, {
      listingPageSize: 1,
    });
    const sealed = [
      sealSegment({ scope: SCOPE, records: [aRecord({ span_id: "a1" })] }),
      sealSegment({ scope: SCOPE, records: [aRecord({ span_id: "a2" })] }),
      sealSegment({ scope: SCOPE, records: [aRecord({ span_id: "a3" })] }),
    ];
    for (const segment of sealed) await bucket.create(segment);

    const found = await bucket.list();
    expect(found.map((object) => object.key).sort()).toEqual(
      sealed.map((segment) => segment.key).sort(),
    );
    for (const object of found) {
      expect(object.key.startsWith(PENDING_PREFIX)).toBe(true);
      expect(object.bytes).toBeGreaterThan(0);
    }

    for (const segment of sealed) await bucket.delete(segment.key);
    expect(await bucket.list()).toEqual([]);
  });

  it("is harmless to rediscover a segment a deletion did not remove", async () => {
    // Deletion is the one step that can fail after everything else succeeded.
    // What must hold is that the next listing finds the object again and that
    // handling it a second time costs nothing: the same identity and the same
    // bytes are already there, so the upload path answers `present` and the
    // replay is a no-op.
    const bucket = pendingObjectStore(running.ingestStore);
    const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
    await bucket.create(sealed);

    expect(
      (await bucket.list()).map((object) => object.key),
    ).toContain(sealed.key);
    expect(await bucket.create(sealed)).toBe("present");

    await bucket.delete(sealed.key);
    expect((await bucket.list()).map((object) => object.key)).not.toContain(
      sealed.key,
    );

    // And deleting it again is not an error, so a retry after an answer that
    // never arrived does not become a failure of its own.
    await expect(bucket.delete(sealed.key)).resolves.toBeUndefined();
  });
});

describe.skipIf(!storage.available)("what the ingestion credential cannot reach", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  it("cannot touch a key outside the pending prefix", async () => {
    // The confinement is the policy, and a policy is one document in a compose
    // file. Proved against the store rather than read out of the document,
    // because the document is only worth what the store makes of it.
    const bucket = pendingObjectStore(running.ingestStore);

    await expect(bucket.delete("elsewhere/not-a-segment")).rejects.toThrow();
    await expect(bucket.read("elsewhere/not-a-segment")).rejects.toThrow();
  });

  it("cannot reach the recordings bucket at all", async () => {
    // The two workloads share one MinIO and share nothing else. A leak of the
    // ingestion credential must not be a way to read, replace or delete a
    // customer's call recording.
    const recordings = pendingObjectStore({
      ...running.ingestStore,
      bucket: BUCKET,
    });

    await expect(recordings.list()).rejects.toThrow();
  });
});
