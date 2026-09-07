import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * Encrypt provider credentials with AES-256-GCM before storage.
 * connect() supplies the master key, which is not stored in the database.
 * Each write uses a fresh random IV and a v1.<iv>.<ciphertext>.<tag> envelope.
 * The key must be 64 hex characters; generate it with openssl rand -hex 32.
 * Format validation cannot establish that the key was randomly generated.
 */

/** AES-256-GCM: the key is 32 bytes, written as 64 hex characters. */
const KEY_PATTERN = /^[0-9a-f]{64}$/i;

/** GCM's standard nonce size. Random per write; never reused with one key. */
const IV_BYTES = 12;

const VERSION = "v1";

let masterKey: Buffer | undefined;

/**
 * Refuses anything that is not exactly 32 bytes of hex, so a misconfigured
 * deployment is loud at boot rather than quietly under-encrypted. Called by
 * `connect()`; nothing else holds the key.
 */
export function holdMasterKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      "EGMA_ENCRYPTION_KEY must be 32 random bytes written as 64 hex " +
        "characters — `openssl rand -hex 32` makes one. A passphrase has " +
        "the right length and a fraction of the entropy, so it is refused " +
        "rather than accepted quietly.",
    );
  }
  masterKey = Buffer.from(key, "hex");
}

/** Called by `disconnect()`, so a closed process holds nothing. */
export function releaseMasterKey(): void {
  masterKey = undefined;
}

function theMasterKey(): Buffer {
  if (masterKey === undefined) {
    throw new Error(
      "sealing a credential needs the master key, and connect() was given " +
        "none. Set EGMA_ENCRYPTION_KEY and pass it as `encryptionKey`.",
    );
  }
  return masterKey;
}

/**
 * The credentials object as it will be stored: sealed whole, one envelope per
 * row. Sealed as JSON so rotation can only ever replace the whole object —
 * there is no format in which a single field could be edited in place.
 */
export function sealCredentials(credentials: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", theMasterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/**
 * The envelope opened and parsed. GCM authenticates before it decrypts, so a
 * row that was tampered with — or sealed under a different key — fails here
 * loudly rather than replaying garbage to a provider.
 */
export function openCredentials(envelope: string): unknown {
  const [version, iv, ciphertext, tag, ...extra] = envelope.split(".");
  if (
    version !== VERSION ||
    iv === undefined ||
    ciphertext === undefined ||
    tag === undefined ||
    extra.length > 0
  ) {
    throw new Error(
      `a sealed credential looks like ${VERSION}.<iv>.<ciphertext>.<tag>, ` +
        "and this row holds something else; it needs repairing before " +
        "anybody can use it",
    );
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    theMasterKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}
