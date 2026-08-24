import { afterAll, describe, expect, it } from "vitest";

import { recordingPathFor } from "../src/routes/recordings.ts";
import {
  presignedObjectUrl,
  signedRecordingLink,
} from "../src/recordings/signed-link.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  absentObjectStorage,
  aRecording,
  REQUIRE_OBJECT_STORAGE,
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { aConductedRun, standingOf } from "./support/recordings.ts";
import { request as ask, signUp } from "./support/traces.ts";

/**
 * The signature, against a store that judges it.
 *
 * `recordings-routes.test.ts` proves who is refused and what the answer says.
 * None of that can prove the one thing a reader actually needs, which is that
 * the link *works* — a signature is only worth what the store makes of it, and
 * every way this can be got wrong is invisible from inside the process that got
 * it wrong. So this file signs against a real MinIO and fetches:
 *
 * - the recording comes back, as audio, byte for byte;
 * - a **range** of it comes back, which is what seeking is;
 * - a link signed for a different address is refused, which is the failure the
 *   browser-address setting exists to prevent and the reason it exists at all;
 * - a link whose moment has passed is refused, so "the link expires" is the
 *   store's promise rather than egma's claim about it;
 * - and the control plane's credential **cannot write**, which is why it is a
 *   separate credential from the simulator's in the first place.
 *
 * It skips, visibly and with a sentence, where no store can be started. That is
 * ticket 01's pattern and its promise: contributing costs no new infrastructure,
 * and a suite that quietly passed instead would be worth nothing.
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

/**
 * The skip is a kindness to a contributor with no docker, and a lie in a gate.
 *
 * The final handoff run and the browser job in CI both exist to prove that a
 * recording can be signed, fetched and played. Either of them going green
 * because no store could be started would report the opposite of what happened,
 * so those runs say `EGMA_REQUIRE_OBJECT_STORAGE` and a missing store fails
 * loudly with the reason it is missing.
 */
describe("a run that requires an object store", () => {
  const noDocker = "docker would not start minio";

  it("skips with its reason where nobody asked for one", () => {
    expect(absentObjectStorage(noDocker, {})).toEqual({
      available: false,
      why: noDocker,
    });
  });

  it("refuses to skip, and keeps the reason, where a run asked for one", () => {
    expect(() =>
      absentObjectStorage(noDocker, { [REQUIRE_OBJECT_STORAGE]: "1" }),
    ).toThrow(new RegExp(noDocker));
  });

  it("reads an empty or switched-off setting as nobody asking", () => {
    for (const asked of ["", "0", "false", "off"]) {
      expect(
        absentObjectStorage(noDocker, { [REQUIRE_OBJECT_STORAGE]: asked })
          .available,
        `${REQUIRE_OBJECT_STORAGE}=${asked} was read as a request`,
      ).toBe(false);
    }
  });
});

const A_REFERENCE = "sim_01JQ0A2B3C4D5E6F7G8H9J0K/dual-channel.wav";
const RECORDING = aRecording();

describe.skipIf(!storage.available)("a link against a real store", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;

  it("plays back the recording it names, as audio", async () => {
    await running.put(A_REFERENCE, RECORDING);

    const link = signedRecordingLink(running.store, A_REFERENCE);
    const fetched = await fetch(link.url);

    expect(fetched.status, await fetched.clone().text()).toBe(200);
    // The simulator writes the object without declaring a type, so the store
    // would answer `application/octet-stream` and a browser handed that may
    // decline to play what it will not name. The type is asked for in the
    // signed query, so it is part of the signature and nobody can change it.
    expect(fetched.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(RECORDING);
  });

  it("serves a range of it, which is what seeking is", async () => {
    await running.put(A_REFERENCE, RECORDING);

    const link = signedRecordingLink(running.store, A_REFERENCE);
    const middle = await fetch(link.url, { headers: { range: "bytes=44-63" } });

    // 206 and twenty bytes: dragging a scrubber costs a range request, not a
    // whole recording, and that is only true because the browser talks to the
    // store directly rather than through a control plane re-proxying audio.
    expect(middle.status).toBe(206);
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(
      RECORDING.slice(44, 64),
    );
  });

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

/**
 * The whole slice at the route, once: a real run, a real reader, a real store.
 *
 * Everything above signs directly, which is the right seam for the signature
 * itself. This is the one that says the pieces are wired to each other — the
 * route reads the row, mints a link against the configured store, and what comes
 * back plays.
 */
describe.skipIf(!storage.available)("resolving a run's recording end to end", () => {
  const running = storage as Extract<ObjectStorage, { available: true }>;
  let api: TestApi;

  afterAll(async () => {
    await api?.close();
  });

  it("hands a reader a link that fetches the audio", async () => {
    await running.put(A_REFERENCE, RECORDING);

    api = await createApi("recording_end_to_end", {
      blob: running.store,
      traceStore: true,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const who = await standingOf(api.app, ada.cookie, "a terminal");
    const run = await aConductedRun(api.app, who, { reference: A_REFERENCE });

    const resolved = await ask(
      api.app,
      "GET",
      recordingPathFor(run.heard),
      who.key,
    );
    expect(resolved.statusCode, JSON.stringify(resolved.body)).toBe(200);

    const played = await fetch(String(resolved.body.url));
    expect(played.status, await played.clone().text()).toBe(200);
    expect(new Uint8Array(await played.arrayBuffer())).toEqual(RECORDING);
  });
});
