import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { recordingPathFor } from "../src/routes/recordings.ts";
import { RECORDING_LINK_SECONDS } from "../src/recordings/signed-link.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { aConductedRun, standingOf, type Standing } from "./support/recordings.ts";
import { colleagueOf, request as ask, signUp, type Answer } from "./support/traces.ts";

/**
 * Resolving a recording, over real HTTP against real Postgres.
 *
 * **Refusal before success**, which is the order this file is written in. The
 * boundary is the organization — the only boundary in the product — and audio
 * holds it exactly as every other read does: a reader outside the organization,
 * and a run belonging to another organization, are each proved here rather than
 * assumed from the machinery. Then the two honest absences that must never read
 * as a broken feature: a chat conversation, which carries no audio by schema
 * rule, and a voice conversation whose call never connected.
 *
 * What is deliberately **not** here is whether the link works. A signature is
 * only worth what the store makes of it, so that is proved against a real MinIO
 * in `recording-store.test.ts`, which skips visibly where one cannot be started.
 * This file asserts what the control plane promises: who is refused, and that
 * the link is minted against the address a browser was told to use, for as long
 * as it says.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET",
  url: string,
  key: string,
): Promise<Answer> {
  return ask(api.app, method, url, key);
}

/**
 * A store on an address that is emphatically not this process's own.
 *
 * `browsers.example` is nowhere a container could reach and that is the point:
 * every link this file reads back was signed for the browser's address, and a
 * regression to signing for something internal would show up as a link whose
 * host is not this one.
 */
const A_BROWSERS_STORE = {
  publicUrl: "https://recordings.browsers.example",
  bucket: "egma-recordings",
  region: "us-east-1",
  accessKeyId: "a-read-only-key-id",
  secretAccessKey: "a-read-only-secret",
} as const;

const A_REFERENCE = "sim_01JQ0A2B3C4D5E6F7G8H9J0K/dual-channel.wav";

/** Somebody with a run of two voice conversations, one of which was recorded. */
async function aCustomerWhoHasRecorded(
  label: string,
  options: { readonly store?: boolean; readonly modality?: "voice" | "chat" } = {},
): Promise<{
  who: Standing;
  ada: Awaited<ReturnType<typeof signUp>>;
  run: Awaited<ReturnType<typeof aConductedRun>>;
}> {
  api = await createApi(
    label,
    options.store === false ? {} : { blob: A_BROWSERS_STORE },
  );
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const who = await standingOf(api.app, ada.cookie, "a terminal");
  const run = await aConductedRun(api.app, who, {
    reference: A_REFERENCE,
    ...(options.modality === undefined ? {} : { modality: options.modality }),
  });
  return { who, ada, run };
}

describe("who may hear a recording", () => {
  it("hands the reader of a voice conversation a link to it, and never the reference", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_link");

    const resolved = await request("GET", recordingPathFor(run.heard), who.key);

    expect(resolved.statusCode, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.simulation_id).toBe(run.heard);
    expect(resolved.body.measured_audio_band_hertz).toBe(8000);

    // The link is against the address a browser was given, and it carries its
    // own proof — no key of the reader's, and nothing that would let a client
    // compose a second link for itself.
    const link = new URL(String(resolved.body.url));
    expect(link.origin).toBe(A_BROWSERS_STORE.publicUrl);
    expect(link.pathname).toBe(`/${A_BROWSERS_STORE.bucket}/${A_REFERENCE}`);
    expect(link.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(link.searchParams.get("X-Amz-Credential")).toContain(
      A_BROWSERS_STORE.accessKeyId,
    );
    expect(String(resolved.body.url)).not.toContain(
      A_BROWSERS_STORE.secretAccessKey,
    );
  });

  it("signs against the browser's address and never against this process's own", async () => {
    // The failure this whole setting exists to prevent, held as a test because
    // it cannot be caught by reading: a link signed for the address the API
    // reaches the store at fails from a browser with `SignatureDoesNotMatch`,
    // which names neither address. So the host in the answer is asserted to be
    // the configured browser one, and the internal name the compose file uses
    // is asserted to appear nowhere in it at all.
    const { who, run } = await aCustomerWhoHasRecorded("recording_address");

    const resolved = await request("GET", recordingPathFor(run.heard), who.key);

    expect(new URL(String(resolved.body.url)).host).toBe(
      new URL(A_BROWSERS_STORE.publicUrl).host,
    );
    expect(String(resolved.body.url)).not.toContain("minio:9000");
    expect(String(resolved.body.url)).not.toContain("127.0.0.1");
    expect(String(resolved.body.url)).not.toContain("localhost");
  });

  it("mints a link that expires, and says when", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_expiry");

    const before = Date.now();
    const resolved = await request("GET", recordingPathFor(run.heard), who.key);

    // The store's own copy of the bound, which is the one it enforces.
    const link = new URL(String(resolved.body.url));
    expect(link.searchParams.get("X-Amz-Expires")).toBe(
      String(RECORDING_LINK_SECONDS),
    );

    // And egma's copy of it, which is what lets a page tell "the link went
    // stale" from "the recording is gone" and ask again rather than leaving
    // somebody looking at a scrubber that stopped working.
    const expiresAt = Date.parse(String(resolved.body.expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + RECORDING_LINK_SECONDS * 1000,
    );
    expect(expiresAt).toBeLessThan(
      Date.now() + (RECORDING_LINK_SECONDS + 60) * 1000,
    );
  });

  it("refuses a reader from another organization exactly as it refuses a made-up id", async () => {
    const { run } = await aCustomerWhoHasRecorded("recording_other_org");

    // A whole other customer, with their own organization and their own key.
    const globex = await signUp(api.app, "bob@globex.example", "Globex");

    const theirs = await request("GET", recordingPathFor(run.heard), globex.secret);
    const nobodys = await request(
      "GET",
      recordingPathFor(newId("sim")),
      globex.secret,
    );

    expect(theirs.statusCode).toBe(404);
    // Word for word the same answer. Another customer's id and an id nobody
    // ever minted must be indistinguishable, or the refusal itself confirms
    // that somebody else's recording is there.
    expect(theirs.body).toEqual(nobodys.body);
    expect(String(theirs.body.message)).toContain("no simulation of yours");
  });

  it("refuses a run belonging to another organization, with nothing of it in the answer", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_other_run");
    const globex = await signUp(api.app, "bob@globex.example", "Globex");
    const theirs = await standingOf(api.app, globex.cookie, "their terminal");

    // Globex have a run of their own, so this is two real runs in two real
    // organizations rather than one customer and an empty account.
    const ours = await aConductedRun(api.app, theirs, {
      reference: "sim_globex/dual-channel.wav",
      label: "globex's own",
    });

    const across = await request("GET", recordingPathFor(ours.heard), who.key);
    expect(across.statusCode).toBe(404);
    expect(across.body.url).toBeUndefined();
    expect(JSON.stringify(across.body)).not.toContain("globex");
  });

  it("lets a colleague inside the organization hear it, whatever their role", async () => {
    // The boundary is the organization and nothing narrower — a viewer reads
    // what their colleagues read. Proved beside the refusals so that "outside
    // is refused" cannot quietly become "everybody but the author is refused".
    const { ada, run } = await aCustomerWhoHasRecorded("recording_colleague");
    const bob = await colleagueOf(api.app, ada, "bob@acme.example", "viewer");

    const theirs = await request("GET", recordingPathFor(run.heard), bob.secret);

    expect(theirs.statusCode, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.simulation_id).toBe(run.heard);
  });

  it("refuses an unauthenticated request before it reads anything at all", async () => {
    const { run } = await aCustomerWhoHasRecorded("recording_signed_out");

    const anonymous = await api.app.inject({
      method: "GET",
      url: recordingPathFor(run.heard),
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: "not_authenticated" });
  });
});

describe("what has no recording to hear", () => {
  it("refuses a chat conversation on its own terms, rather than as an empty one", async () => {
    // The database already forbids a chat row from holding audio, so this could
    // be left to fall through to "no recording". It is answered on its own
    // terms because the two mean different things to whoever is reading: no
    // amount of waiting or re-running will produce audio for a chat.
    const { who, run } = await aCustomerWhoHasRecorded("recording_chat", {
      modality: "chat",
    });

    const refused = await request("GET", recordingPathFor(run.heard), who.key);

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `simulation ${run.heard} is a chat conversation, and a chat has no ` +
        `audio to hear. What was said is its transcript; there is no ` +
        `recording of a chat and there never will be.`,
    });
  });

  it("refuses a voice conversation that wrote none, and says which two things that is", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_absent");

    const refused = await request("GET", recordingPathFor(run.silent), who.key);

    expect(refused.statusCode).toBe(404);
    expect(refused.body.error).toBe("not_found");
    // A call that never connected and an upload the store refused are the same
    // absence from here — the spec's Further Notes hold that gap open rather
    // than letting this route pretend to know which one happened.
    expect(String(refused.body.message)).toContain("never connected");
    expect(String(refused.body.message)).toContain("the store refused");
  });

  /**
   * A reference that tries to walk out of the bucket is never signed.
   *
   * **The line that actually holds is the store's**: the read credential is
   * granted `s3:GetObject` on this bucket and nothing else, so a cross-bucket
   * key is refused by MinIO however it is shaped, which
   * `recording-store.test.ts` proves against a real one. This is depth behind
   * that line, because the line is a policy document in a compose job and a
   * deployment that ever widened it would lose the containment with nothing
   * saying so.
   *
   * It is deliberately a **shape check and not a second `confined_key`**. That
   * rule lives once, in the simulator, shared between both of its stores;
   * a second implementation in a second language would be a second chance to
   * get it wrong, and a copy that disagreed would make an honest recording
   * unresolvable by the very reference its own simulation reported.
   */
  it("will not sign a reference that walks out of the bucket", async () => {
    const { who } = await aCustomerWhoHasRecorded("recording_traversal");

    // Written straight onto the row, past the simulator that would have
    // confined it — which is what whoever holds the service token could do, and
    // what any future writer that skipped the simulator would do by accident.
    for (const reference of [
      "../another-bucket/stolen.wav",
      "/etc/passwd",
      "sim_01/../../elsewhere/dual-channel.wav",
    ]) {
      const planted = await aConductedRun(api.app, who, { reference });
      const refused = await request(
        "GET",
        recordingPathFor(planted.heard),
        who.key,
      );

      expect(refused.statusCode, reference).toBe(422);
      expect(String(refused.body.message)).toContain("will not resolve");
      // And nothing signed comes back, so there is no link to try.
      expect(refused.body.url).toBeUndefined();
    }
  });
});

describe("a deployment that named no store", () => {
  it("says which variable to set, and only after every question about the reader", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_no_store", {
      store: false,
    });

    const unresolvable = await request(
      "GET",
      recordingPathFor(run.heard),
      who.key,
    );

    expect(unresolvable.statusCode).toBe(503);
    expect(unresolvable.body.error).toBe("no_object_store");
    expect(String(unresolvable.body.message)).toContain("EGMA_BLOB_PUBLIC_URL");

    // And the configuration answer never leaks existence: a stranger asking
    // about the same simulation still gets the refusal about the reader, not
    // the one about the deployment.
    const globex = await signUp(api.app, "bob@globex.example", "Globex");
    const theirs = await request(
      "GET",
      recordingPathFor(run.heard),
      globex.secret,
    );
    expect(theirs.statusCode).toBe(404);
  });
});

describe("what the run's own results say about audio", () => {
  it("marks which conversations have a recording, and never says where one is", async () => {
    const { who, run } = await aCustomerWhoHasRecorded("recording_run_shape");

    const read = await request("GET", `/api/runs/${run.runId}`, who.key);

    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    const simulations = read.body.simulations as Record<string, unknown>[];
    const heard = simulations.find((one) => one.id === run.heard);
    const silent = simulations.find((one) => one.id === run.silent);

    expect(heard).toMatchObject({ modality: "voice", has_recording: true });
    expect(silent).toMatchObject({ modality: "voice", has_recording: false });

    // The reference itself never travels. It is opaque, it means something only
    // to whoever resolves it, and a page that carried one would be a page whose
    // address could not be shared.
    expect(JSON.stringify(read.body)).not.toContain(A_REFERENCE);
  });
});
