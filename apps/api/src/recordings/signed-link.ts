import { createHash, createHmac } from "node:crypto";

/**
 * Create a presigned S3 GET URL after the route authorizes recording access.
 * Sign the browser-facing origin; changing the host invalidates the signature.
 * Supports permanent credentials, no request body, and the host header only.
 * recording-store.test.ts verifies signatures against MinIO. If valid links
 * are rejected, check the public origin and the API/store clocks.
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
 * Link lifetime allows playback and range requests while limiting how long
 * a copied URL grants access. Storage enforces its own presigning limits.
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
 * Reject unsafe reference shapes without rewriting object keys. The simulator
 * confines keys before upload; this check also covers rows written elsewhere.
 * Storage policy must independently restrict the read credential to this bucket.
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
        `and this one does. Nothing Egma writes produces such a reference — ` +
        `the simulator confines every key before it reports one — so this row ` +
        `was written by something else.`,
    );
  }
}

/**
 * Sign the validated reference without changing its object key. For .wav,
 * include a signed response-content-type override for browser playback.
 * Other extensions receive no inferred content type.
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
  // Use path-style bucket addressing for MinIO hosts without per-bucket DNS.
  // The configured public URL is an origin; prepend no proxy path.
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
