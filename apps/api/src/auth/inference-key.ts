import { createHash, randomBytes } from "node:crypto";

import type { IncomingHttpHeaders } from "node:http";

/**
 * The secret a self-hosted deployment presents at the Egma model gateway, and
 * how a request carrying one is read.
 *
 * The sibling of `api-key.ts`, and the whole of the difference is what the
 * secret opens. A product key resolves to a person, their current role and a
 * project, and every ordinary Egma door takes one. This one resolves to an
 * organization and opens exactly one thing.
 *
 * **A different prefix and a different table, which is what makes the two
 * unmixable.** `apiKeySecretOn` requires `egma_sk_` and looks in `api_key`;
 * this requires `egma_ik_` and looks in `inference_key`. So an inference key
 * offered at a product route is not refused by a rule somebody wrote — it is
 * not found, because nothing there ever looks where it lives.
 */

/**
 * The static prefix every inference key starts with.
 *
 * It exists for `egma_sk_`'s reason: a fixed shape is what lets a
 * secret-scanning service recognise a leaked Egma credential in a repository, a
 * log or a paste. `ik` for inference key, one letter apart from `sk` in the
 * name and a whole table apart in what it opens.
 */
export const INFERENCE_KEY_SECRET_PREFIX = "egma_ik_";

/**
 * The header an inference key travels in, from a self-hosted deployment and
 * from the gateway alike.
 *
 * The same name the gateway's own slot uses, so there is exactly one spelling
 * of "here is an inference key" anywhere in Egma. Deliberately not
 * `Authorization: Bearer`: that header is the product's, an inference key is
 * not a product credential, and a value in the product's slot is a value some
 * later door might try to resolve.
 */
export const INFERENCE_KEY_HEADER = "egma-inference-key";

/** 256 bits of randomness. A single SHA-256 over it, for `api-key.ts`'s reason. */
const SECRET_BYTES = 32;

/** Enough of the tail to tell two keys apart in a list, and no more. */
const DISPLAY_SUFFIX_LENGTH = 4;

export type MintedInferenceKey = {
  /** Handed over once, at the moment of creation, and never stored. */
  readonly secret: string;
  /** What goes in the table instead. */
  readonly hash: string;
  readonly prefix: string;
  readonly displaySuffix: string;
};

export function mintInferenceKeySecret(): MintedInferenceKey {
  const secret = `${INFERENCE_KEY_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return {
    secret,
    hash: hashInferenceKeySecret(secret),
    prefix: INFERENCE_KEY_SECRET_PREFIX,
    displaySuffix: secret.slice(-DISPLAY_SUFFIX_LENGTH),
  };
}

export function hashInferenceKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The inference key on a request, if it carries one in the one slot it may.
 *
 * A value that is not shaped like one answers `null` rather than being tried:
 * a product key sent here is somebody pointing the wrong credential at the
 * right door, and hashing it to look it up in a table it is not in would be
 * spending a query to reach the same answer.
 */
export function inferenceKeySecretOn(headers: IncomingHttpHeaders): string | null {
  const offered = headers[INFERENCE_KEY_HEADER];
  const written = typeof offered === "string" ? offered.trim() : "";
  if (written === "") return null;
  return written.startsWith(INFERENCE_KEY_SECRET_PREFIX) ? written : null;
}
