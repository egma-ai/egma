import { createHash, createHmac } from "node:crypto";

/**
 * Turning a recording's reference into a link a browser can fetch — and
 * nothing else.
 *
 * A voice simulation writes one dual-channel recording and reports an opaque
 * reference to it. The contract has always said what happens next: *resolved by
 * the control plane; never a URL, never carries how to fetch it*. This module is
 * that resolution. It makes a **presigned S3 GET**: a URL carrying its own
 * proof, good for a bounded moment, which the browser then fetches straight from
 * the store. The audio bytes never pass through egma — only the decision to let
 * somebody have them does, and that decision was made by the route above this.
 *
 * ## Why this is written out rather than imported
 *
 * `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` would do this in two
 * lines. It would also be the first large dependency tree in a control plane
 * that carries seven runtime dependencies on purpose — roughly a hundred
 * packages, most of them retry, region-resolution, credential-chain and
 * middleware machinery for a process that will never make an S3 *request* at
 * all. Signing a presigned GET is the narrowest corner of SigV4: one method, no
 * payload to hash, no session token, no credential chain, no clock skew
 * negotiation. It is the corner that fits in one file.
 *
 * The honest objection is that this is security-adjacent code, and hand-written
 * security-adjacent code is usually a bad trade because nothing checks it. What
 * makes the trade acceptable here is that **something does check it, on every
 * run**: a real MinIO refuses a wrong signature, and `recording-store.test.ts`
 * signs against one and fetches. A drift in this file is a red test rather than
 * a link that quietly stops working. The trade and its reasoning are recorded in
 * ticket 02.
 *
 * What is deliberately *not* here: signing anything with a request body,
 * anything with headers beyond `host`, and anything that needs a temporary
 * credential. If egma ever needs one of those, that is the day to buy the tree
 * rather than to grow this file.
 *
 * ## The address this signs for is the browser's, never egma's own
 *
 * A signature covers the host it was made for. The control plane reaches the
 * store on the deployment's internal network — `http://minio:9000` in the
 * compose file — and a browser reaches it somewhere else entirely. Sign for one
 * and fetch from the other, and the store answers `SignatureDoesNotMatch`, which
 * names neither address and is the single most common way a self-hosted object
 * store breaks. So `BlobStore.publicUrl` is *the browser's* address and there is
 * no second one in this process: the control plane never opens a connection to
 * the store at all, so it has no internal endpoint to confuse this with.
 *
 * **A clock is the other way to earn that same nameless refusal.** A signature
 * carries the instant it was made at, and a store rejects one made too far from
 * its own idea of now — so an API container whose clock has drifted from the
 * store's refuses every recording with the identical `SignatureDoesNotMatch`,
 * and nothing anywhere says the word "clock". If recordings stop playing on a
 * deployment where nothing else changed, compare the two clocks first.
 */

/** What the control plane knows about the store recordings live in. */
export type BlobStore = {
  /**
   * The address **a browser** reaches the store at — `EGMA_BLOB_PUBLIC_URL`,
   * and only ever an origin: scheme, host and port. A sub-path is refused where
   * the setting is read, because a signature covers the path it was signed for
   * and the ordinary reverse proxy strips its own prefix before the store sees
   * it.
   */
  readonly publicUrl: string;
  readonly bucket: string;
  /**
   * What to sign for. MinIO ignores it and every signature must still carry
   * one, so a deployment that named none still works.
   */
  readonly region: string;
  /**
   * A **read-only** credential, separate from the write credential the
   * simulator holds. A leaked read credential must not be usable to overwrite a
   * customer's call recording — see the read-only user the compose file's
   * bucket job creates.
   */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/**
 * How long a minted link lives.
 *
 * Long enough to listen to a whole recording and seek around inside it: a voice
 * simulation is bounded by a duration limit measured in minutes, and a browser
 * re-fetches byte ranges as somebody drags the scrubber — a link that died
 * mid-listen would look exactly like a broken player. Short enough that an
 * address copied out of a network tab and pasted into a message stops working
 * the same afternoon.
 *
 * It is a constant rather than a setting because there is no deployment whose
 * answer differs, and a setting nobody has a reason to change is a setting
 * somebody will eventually set to a year. Nothing here enforces a ceiling on
 * `X-Amz-Expires`: **the bound is the store's** — S3 refuses a presigned
 * request over seven days — so a value past that would be refused at fetch
 * time rather than at signing time, which is a worse place to find out.
 */
export const RECORDING_LINK_SECONDS = 15 * 60;

export type SignedLink = {
  readonly url: string;
  /** When the store stops honouring it, so a page can say so rather than guess. */
  readonly expiresAt: Date;
};

/**
 * A reference this side declines to sign at all.
 *
 * Raised rather than answered, because there is no honest link to return: the
 * caller's own refusal sentence is the only correct outcome, and returning
 * something signable would be this module inventing an object.
 */
export class UnsignableReferenceError extends Error {}

/**
 * A reference shaped so that no signature can reach outside the bucket.
 *
 * **The rule that confines a key lives in the simulator and is not copied
 * here.** `confined_key` in `apps/simulator/src/egma_simulator/blob.py` flattens
 * any key that could name something outside the bucket, it is shared between
 * both of that side's stores on purpose, and a second implementation in a second
 * language would be a second chance to get it wrong — worse, a *disagreeing*
 * copy would make a recording unresolvable by the very reference its own
 * simulation reported. So this is not that rule. It is a shape check with two
 * cases and no rewriting.
 *
 * **What it is depth for.** The reference reaches a row through the report door,
 * which is gated by the service token — so whoever holds that token, or anything
 * that ever writes a row without going through the simulator, could store
 * `../another-bucket/x`. The real containment against that is the store's own
 * policy: the read credential is granted `s3:GetObject` on this bucket and
 * nothing else, so a cross-bucket read is refused by the store however the key
 * is shaped. That is the line that actually holds, and it is proved against a
 * real MinIO. This check exists because that line is a *policy* — one JSON
 * document in a compose job — and a deployment that ever widens it would lose
 * the containment with nothing saying so. Two independent reasons a traversal
 * cannot work is the point; neither is redundant while the other is a
 * configuration file.
 */
function refuseAnUnsignableReference(reference: string): void {
  const segments = reference.split("/");
  if (
    reference.startsWith("/") ||
    reference.startsWith("\\") ||
    segments.includes("..") ||
    segments.includes(".")
  ) {
    throw new UnsignableReferenceError(
      `a recording reference cannot start at a separator or walk upwards, ` +
        `and this one does. Nothing egma writes produces such a reference — ` +
        `the simulator confines every key before it reports one — so this row ` +
        `was written by something else.`,
    );
  }
}

/**
 * One recording's reference as a link, ready to hand to a browser.
 *
 * The reference is used as the object key exactly as the simulator reported it,
 * past the shape check above. It is already confined at the seam that wrote it,
 * and it is signed here rather than *rewritten*, because a key this process
 * reshaped would resolve to a different object than the one the simulation says
 * it wrote — which is the same failure as no recording at all, arriving with a
 * link that looks fine.
 *
 * `response-content-type` is asked for on the way out. The simulator writes the
 * object without declaring a type, so the store answers
 * `application/octet-stream`, and a browser handed that on an `<audio>` element
 * may decline to play what it will not name. S3 and MinIO both honour this
 * override on a presigned GET, and it is part of the signature, so nobody can
 * change it after the fact.
 *
 * **The extension decides it, and only `.wav` is claimed.** The one thing that
 * writes these objects writes a WAV and names it `dual-channel.wav`, so the
 * extension is not a guess about the bytes — it is the same fact read from the
 * reference. Anything else gets no override at all rather than a made-up one:
 * this side has not read the bytes, and telling a browser that an unknown
 * object is audio would turn "egma cannot resolve this" into "your recording is
 * corrupt", which sends somebody looking in the wrong place.
 */
export function signedRecordingLink(
  store: BlobStore,
  reference: string,
  options: {
    /** The moment to sign at. A test pins it; nothing else passes it. */
    readonly at?: Date;
    /** Overridden only by the tests that prove a link stops working. */
    readonly expiresInSeconds?: number;
  } = {},
): SignedLink {
  refuseAnUnsignableReference(reference);

  const at = options.at ?? new Date();
  const expiresInSeconds = options.expiresInSeconds ?? RECORDING_LINK_SECONDS;

  return {
    url: presignedObjectUrl({
      store,
      key: reference,
      method: "GET",
      at,
      expiresInSeconds,
      query: reference.toLowerCase().endsWith(".wav")
        ? { "response-content-type": "audio/wav" }
        : {},
    }),
    expiresAt: new Date(at.getTime() + expiresInSeconds * 1000),
  };
}

/**
 * A presigned URL for one object, by the AWS Signature Version 4 query-string
 * scheme.
 *
 * `method` is a parameter because a signature is bound to the verb, and the
 * test that proves the control plane's credential **cannot write** has to be
 * able to sign a `PUT` and watch the store refuse it. Nothing in the product
 * signs anything but a `GET`.
 */
export function presignedObjectUrl(options: {
  readonly store: BlobStore;
  readonly key: string;
  readonly method: "GET" | "PUT";
  readonly at: Date;
  readonly expiresInSeconds: number;
  readonly query?: Readonly<Record<string, string>>;
}): string {
  const { store, key, method, at, expiresInSeconds } = options;

  const address = new URL(store.publicUrl);
  // Path addressing — `<store>/<bucket>/<key>` — rather than the virtual-host
  // style AWS defaults to, for the reason the simulator's client uses it: a
  // MinIO answering at `http://minio:9000` has one name on the deployment's
  // network and no per-bucket name at all, and a link to
  // `http://egma-recordings.minio:9000` would resolve nothing. AWS serves both
  // styles, so a deployment pointed at real S3 pays nothing for this.
  //
  // The path starts at the root, with nothing in front of the bucket. There is
  // no prefix to carry: `EGMA_BLOB_PUBLIC_URL` is refused unless it is an origin
  // and nothing more, so `store.publicUrl` has no path in it to honour.
  const canonicalUri = `/${encodePath(store.bucket)}/${encodePath(key)}`;

  const stamp = timestamps(at);
  const scope = `${stamp.day}/${store.region}/s3/aws4_request`;

  // Everything the signature covers, the store's own parameters and the
  // caller's together. Sorting happens once, below, over the encoded names —
  // a caller's parameter is signed on exactly the same terms as ours.
  const signed: Record<string, string> = {
    ...options.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${store.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp.instant,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = canonicalQueryString(signed);

  // The host as the browser will send it, port included where it is not the
  // scheme's own. `URL.host` is exactly that rule, which is why it is read
  // rather than assembled.
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${address.host}\n`,
    "host",
    // A presigned GET has no body to hash, and the browser fetching it is not
    // going to send one. `UNSIGNED-PAYLOAD` is the literal S3 defines for that.
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp.instant,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(store, stamp.day), stringToSign).toString(
    "hex",
  );

  return `${address.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * The two forms of one instant SigV4 wants: the whole thing, and the day.
 *
 * Written out of the ISO form rather than assembled from the parts, because
 * `toISOString` is already UTC and already zero-padded, and the day has to be
 * the same day the instant is — deriving one from the other is what makes that
 * true by construction rather than by two agreeing calls.
 */
function timestamps(at: Date): { readonly instant: string; readonly day: string } {
  const instant = at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  return { instant, day: instant.slice(0, 8) };
}

/**
 * The signing key: four nested HMACs, each one narrowing what the last can
 * sign for. It is derived per day and per region on purpose — a key that leaked
 * signs nothing outside the day and the service it was derived for.
 */
function signingKey(store: BlobStore, day: string): Buffer {
  const date = hmac(Buffer.from(`AWS4${store.secretAccessKey}`, "utf8"), day);
  const region = hmac(date, store.region);
  const service = hmac(region, "s3");
  return hmac(service, "aws4_request");
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/**
 * The parameters in the one order a signature is computed over: sorted by
 * encoded name, each name and value encoded, joined with `&`.
 *
 * The sort is over the **encoded** names rather than the raw ones, which is
 * what the specification says and is not the same ordering — and it is a
 * difference nobody would notice until the day a parameter arrived with a
 * character that encodes to something ordering differently.
 */
function canonicalQueryString(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** A key as a path: every segment encoded, the separators left as separators. */
function encodePath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

/**
 * Percent-encoding as RFC 3986 defines it, which is not quite what
 * `encodeURIComponent` does.
 *
 * `encodeURIComponent` leaves `!`, `'`, `(`, `)` and `*` alone; RFC 3986 does
 * not list them as unreserved, and AWS's canonicalisation encodes them. A key
 * carrying one would then be signed one way and requested another, and the only
 * symptom would be that recordings with an apostrophe in their name do not play.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
