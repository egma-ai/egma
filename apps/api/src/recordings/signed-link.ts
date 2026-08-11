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
 */

/** What the control plane knows about the store recordings live in. */
export type BlobStore = {
  /**
   * The address **a browser** reaches the store at, scheme and host and port —
   * `EGMA_BLOB_PUBLIC_URL`. A path is honoured, for the deployment that puts
   * the store behind a reverse proxy on a sub-path.
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
 * somebody will eventually set to a year.
 */
export const RECORDING_LINK_SECONDS = 15 * 60;

export type SignedLink = {
  readonly url: string;
  /** When the store stops honouring it, so a page can say so rather than guess. */
  readonly expiresAt: Date;
};

/**
 * One recording's reference as a link, ready to hand to a browser.
 *
 * The reference is used as the object key exactly as the simulator reported it.
 * It is already confined at the seam that wrote it — the simulator flattens any
 * key that could name something outside its bucket — and it is signed here
 * rather than re-checked, because a key this process rewrote would resolve to a
 * different object than the one the simulation says it wrote.
 *
 * `response-content-type` is asked for on the way out. The simulator writes the
 * object without declaring a type, so the store answers
 * `application/octet-stream`, and a browser handed that on an `<audio>` element
 * may decline to play what it will not name. S3 and MinIO both honour this
 * override on a presigned GET, and it is part of the signature, so nobody can
 * change it after the fact.
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
  const basePath = address.pathname.replace(/\/+$/u, "");
  const canonicalUri = `${basePath}/${encodePath(store.bucket)}/${encodePath(key)}`;

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
