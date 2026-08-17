import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Whether this delivery was signed with this connection's key.
 *
 * Retell signs the body with the account's API key — HMAC-SHA256, written as
 * hex — and sends it in `x-retell-signature`. So verification is also
 * *identification*: an event names an agent, several switched-on connections
 * can name that agent, and the one whose key signs the body is the one the
 * event belongs to. Nothing else about the delivery is trusted to say whose it
 * is.
 *
 * **The raw bytes are what is checked**, never a re-serialisation of the parsed
 * body. Two JSON documents can mean the same thing and differ by a space, and
 * the signature is over one of them.
 *
 * The comparison is constant-time. A signature check that returns early on the
 * first wrong character tells whoever is guessing how much of their guess was
 * right, which is the whole of how such a check is broken.
 */

/** Retell's header, and the only place a signature is read from. */
export const RETELL_SIGNATURE_HEADER = "x-retell-signature";

/** What Retell puts in front of the digest, when it puts anything. */
const VERSIONED = /^v[0-9]+=/u;

export function signRetellBody(body: string, apiKey: string): string {
  return createHmac("sha256", apiKey).update(body, "utf8").digest("hex");
}

export function verifyRetellSignature(
  body: string,
  apiKey: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined) return false;

  // Both forms are accepted because both are in the wild: the bare digest, and
  // the versioned `v=<digest>` prefix Retell's own helper writes.
  const offered = signature.trim().replace(VERSIONED, "").replace(/^v=/u, "");
  if (!/^[0-9a-f]+$/iu.test(offered)) return false;

  const expected = signRetellBody(body, apiKey);
  const a = Buffer.from(offered.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch rather than answering, and a
  // signature of the wrong length is simply wrong.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
