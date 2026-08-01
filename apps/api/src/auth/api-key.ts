import { createHash, randomBytes } from "node:crypto";

import { resolveApiKey, type AuthContext } from "@egma/db";

/**
 * The secret a terminal holds, and how a request carrying one becomes a
 * context.
 *
 * This is the sibling of `session.ts`, and the whole of the difference is
 * stated in one line of code: nothing here touches the auth provider. egma
 * mints the secret, egma hashes it, egma verifies it against egma's own table.
 * The programmatic path is the high-volume one and the one a customer
 * integrates against, and it is the one a provider swap must not be able to
 * reach.
 */

/**
 * The static prefix every egma secret starts with.
 *
 * It exists so a secret-scanning service can recognise a leaked egma key in a
 * repository, a log or a paste, which only works if the shape never varies:
 * `egma_sk_` and then 43 characters of base64url. Changing it affects only keys
 * minted afterwards, so it is reversible — but every day it stays the same is a
 * day the scanners keep working.
 */
export const API_KEY_SECRET_PREFIX = "egma_sk_";

/**
 * 256 bits of randomness.
 *
 * **A single SHA-256 over it, and no slow hash.** Bcrypt-class hashing exists
 * to protect low-entropy human-chosen passwords against offline brute force,
 * and there is nothing here to brute-force: guessing one of 2^256 secrets is
 * not a thing a machine does. A slow hash would buy no security and would make
 * verification a per-request tax on every call egma serves.
 */
const SECRET_BYTES = 32;

/** Enough of the tail to tell two keys apart in a list, and no more. */
const DISPLAY_SUFFIX_LENGTH = 4;

export type MintedSecret = {
  /** Handed over once, at the moment of creation, and never stored. */
  readonly secret: string;
  /** What goes in the table instead. */
  readonly hash: string;
  readonly prefix: string;
  readonly displaySuffix: string;
};

/** A new secret, and the three things about it that are safe to keep. */
export function mintApiKeySecret(): MintedSecret {
  const secret = `${API_KEY_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return {
    secret,
    hash: hashApiKeySecret(secret),
    prefix: API_KEY_SECRET_PREFIX,
    displaySuffix: secret.slice(-DISPLAY_SUFFIX_LENGTH),
  };
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The secret on a request, if it carries one.
 *
 * `Authorization: Bearer <secret>`, and the prefix has to be egma's — anything
 * else is somebody's session token or a header meant for the provider, and
 * neither is this path's business.
 */
export function apiKeySecretOn(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== "bearer") return null;

  const secret = rest.join("");
  return secret.startsWith(API_KEY_SECRET_PREFIX) ? secret : null;
}

/** A request that arrived with a key, and the context it acts in. */
export type ApiKeyRequest = {
  readonly apiKeyId: string;
  readonly auth: AuthContext;
};

/**
 * Who is asking, which customer, which project and what role — from the key
 * row, and from nothing the client sent.
 *
 * A request with no egma secret on it is nobody here, and says so by answering
 * null rather than by falling back to anything: the browser path is a different
 * resolver, and mixing the two is how a provider ends up on this one.
 */
export async function resolveApiKeyRequest(
  request: Request,
): Promise<ApiKeyRequest | null> {
  const secret = apiKeySecretOn(request);
  if (secret === null) return null;

  const resolved = await resolveApiKey(hashApiKeySecret(secret));
  if (resolved === undefined) return null;

  return { apiKeyId: resolved.apiKeyId, auth: resolved.auth };
}
