import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * How a customer's provider credential is sealed before it touches a row, and
 * the one place it is ever unsealed. The whole decision is ADR-0003; the shape
 * of it here:
 *
 * A connection's credential cannot be hashed — egma must replay it to the
 * provider every time a simulation starts — so it is encrypted in this process
 * under a master key that lives beside the process and never in the database.
 * A stolen backup, a misconfigured replica, anyone who can run a query: all of
 * them see ciphertext and hold no key.
 *
 * The stored value is a versioned envelope, `v1.<iv>.<ciphertext>.<tag>`, with
 * a fresh random IV per write. The version stamp is what makes a future
 * algorithm change — or a KMS-wrapped `v2` — a data migration rather than a
 * format guess.
 *
 * The key arrives through `connect()`, the same door the database URL does,
 * and is held privately here. It is 32 random bytes written as 64 hex
 * characters (`openssl rand -hex 32`), and the check below enforces length
 * *and* alphabet rather than presence: a 32-character passphrase has the right
 * byte count and a fraction of the entropy, and must be refused, not accepted
 * quietly.
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
