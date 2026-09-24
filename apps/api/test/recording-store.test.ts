import { afterAll, describe, expect, it } from "vitest";

import {
  presignedObjectUrl,
  signedRecordingLink,
} from "../src/recordings/signed-link.ts";
import {
  aRecording,
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";

/**
 * Test signed recording reads against MinIO: audio bytes, range requests,
 * wrong-host signatures, expiry, and rejection of writes with the read
 * credential. Skip visibly when the required store cannot start.
 */

const storage: ObjectStorage = await startObjectStorage("api-recordings");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the recording store suite — ${storage.why}\n\n`,
  );
}

afterAll(() => {
  if (storage.available) storage.stop();
});

const A_REFERENCE = "sim_01JQ0A2B3C4D5E6F7G8H9J0K/dual-channel.wav";
const RECORDING = aRecording();

describe.skipIf(!storage.available)("a link against a real store", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  it("is refused when it was signed for a different address", async () => {
    // The whole reason the browser's address is its own setting. This is what a
    // deployment that signed with its internal endpoint gets: not a helpful
    // message about addresses, but `SignatureDoesNotMatch`, which names neither
    // the address that was signed for nor the one that was used.
    await running.put(A_REFERENCE, RECORDING);

    const signedForSomewhereElse = signedRecordingLink(
      { ...running.store, publicUrl: "http://minio:9000" },
      A_REFERENCE,
    );
    const fetchedFromHere = signedForSomewhereElse.url.replace(
      "http://minio:9000",
      running.store.publicUrl,
    );

    const refused = await fetch(fetchedFromHere);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("SignatureDoesNotMatch");

    // And the same reference, signed for the address it will be fetched from,
    // works — so what the store refused was the address and nothing else.
    const right = signedRecordingLink(running.store, A_REFERENCE);
    expect((await fetch(right.url)).status).toBe(200);
  });

  it("stops working when its moment has passed", async () => {
    await running.put(A_REFERENCE, RECORDING);

    // Signed a while ago, for a moment that has been and gone. The expiry is
    // the store's to enforce, and this is the store enforcing it — a copied
    // address is not a permanent way in.
    const stale = presignedObjectUrl({
      store: running.store,
      key: A_REFERENCE,
      method: "GET",
      at: new Date(Date.now() - 120_000),
      expiresInSeconds: 60,
    });

    const refused = await fetch(stale);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Request has expired");
  });

  it("cannot write, however the credential is used", async () => {
    // The reason the control plane holds its own credential rather than the
    // simulator's. A read credential that leaks — out of a log, out of a
    // container, out of a backup — must not be usable to overwrite a customer's
    // call recording, and the only honest way to know is to try.
    await running.put(A_REFERENCE, RECORDING);

    const overwrite = presignedObjectUrl({
      store: running.store,
      key: A_REFERENCE,
      method: "PUT",
      at: new Date(),
      expiresInSeconds: 300,
    });
    const refused = await fetch(overwrite, {
      method: "PUT",
      body: "this is not a recording",
    });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("AccessDenied");

    // Somewhere it has never been, either — a refusal that only covered keys
    // that already exist would leave a leaked credential able to fill the
    // bucket with anything at all.
    const somewhereNew = presignedObjectUrl({
      store: running.store,
      key: "sim_never_conducted/dual-channel.wav",
      method: "PUT",
      at: new Date(),
      expiresInSeconds: 300,
    });
    expect(
      (await fetch(somewhereNew, { method: "PUT", body: "nor is this" })).status,
    ).toBe(403);

    // And the recording is exactly what it was.
    const after = await fetch(signedRecordingLink(running.store, A_REFERENCE).url);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(RECORDING);
  });
});
