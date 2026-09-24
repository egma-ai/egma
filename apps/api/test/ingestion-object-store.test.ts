import { createServer } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import {
  pendingObjectStore,
  SegmentIdentityConflictError,
} from "@egma/ingestion";
import { sealSegment } from "@egma/ingestion";
import { aRecord } from "./support/ingestion.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";

/**
 * Use MinIO to verify conditional writes and replay after a failed deletion.
 * Skip when storage cannot start unless EGMA_REQUIRE_OBJECT_STORAGE
 * is set, in which case setup failure must fail the suite.
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
});

describe("an interrupted conditional-create verification", () => {
  it("aborts a stalled existing-object body read inside the caller deadline", async () => {
    let sawVerification: () => void = () => undefined;
    const verificationStarted = new Promise<void>((resolve) => {
      sawVerification = resolve;
    });
    const server = createServer((incoming, response) => {
      incoming.resume();
      if (incoming.method === "PUT") {
        response.writeHead(412, { "content-type": "application/xml" });
        response.end(
          "<Error><Code>PreconditionFailed</Code><Message>already present</Message></Error>",
        );
        return;
      }
      sawVerification();
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": "1000",
      });
      response.flushHeaders();
    });
    await new Promise<void>((listening) => {
      server.listen(0, "127.0.0.1", listening);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the stalled verification store did not take a port");
    }

    try {
      const bucket = pendingObjectStore(
        {
          endpoint: `http://127.0.0.1:${address.port}`,
          bucket: "egma-ingestion",
          region: "us-east-1",
          accessKeyId: "SENTINEL-stalled-get-key-id",
          secretAccessKey: "SENTINEL-stalled-get-secret",
        },
        { requestTimeoutMilliseconds: 2_000 },
      );
      const controller = new AbortController();
      const sealed = sealSegment({ scope: SCOPE, records: [aRecord()] });
      const creating = bucket.create(sealed, { signal: controller.signal });

      await verificationStarted;
      const stoppingAt = Date.now();
      controller.abort();

      await expect(creating).rejects.toThrow();
      expect(Date.now() - stoppingAt).toBeLessThan(500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});

describe.skipIf(!storage.available)("finding what is pending", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

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
