import type { Config } from "./config.ts";

/**
 * The one replaceable thing about how a connection is authenticated.
 *
 * **The gateway asks one question and takes one answer: does this credential
 * authorize a connection, and which organization is it.** Everything about how
 * that answer is reached — a static secret today, a hashed inference key in a
 * store tomorrow, a signed service assertion for hosted egma beside it — sits
 * behind this interface, which is what keeps the public application from being
 * coupled to one Cloudflare storage product.
 *
 * The answer names the organization. **Nothing else in the gateway may.** A
 * header, a query value, a path or a body can no more change it than they can
 * change the provider's address, because no other code reads an organization
 * from anywhere: it arrives here and travels as this value.
 */

/** What a verifier answers when the credential is good. */
export type Authenticated = {
  readonly organizationId: string;
  /**
   * Which credential authorized this connection, as an identifier and never as
   * the credential. It is on the operational record so that a leaked key can be
   * traced to the connections it opened without the record holding the key.
   */
  readonly inferenceKeyId: string;
};

/** Why a credential did not authorize a connection. Never the credential itself. */
export type Refusal = { readonly refused: "absent" | "not-recognized" };

export type Verified = Authenticated | Refusal;

export function isAuthenticated(verified: Verified): verified is Authenticated {
  return !("refused" in verified);
}

export type Verifier = {
  /**
   * Asked once, when an HTTP request or a WebSocket opens — never per audio
   * frame. That is what makes revocation effective for the next connection
   * rather than for the next frame, and it is the reason a long simulation does
   * not pay for authentication on its hot path.
   */
  verify(credential: string | null): Promise<Verified>;
};

/**
 * Are two secrets the same, without saying how far they agreed.
 *
 * A comparison that stops at the first difference leaks the shared prefix to
 * anybody who can time it. `crypto.subtle.timingSafeEqual` is not on the web
 * platform, so this is the ordinary constant-time loop over the bytes, with the
 * length folded into the answer rather than short-circuiting on it.
 */
function sameSecret(offered: string, expected: string): boolean {
  const a = new TextEncoder().encode(offered);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  const width = Math.max(a.length, b.length);
  for (let index = 0; index < width; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * The verifier a preview deploys: one organization-scoped secret, held in the
 * deployment's own secret store and compared against what the caller offered.
 *
 * **It stores nothing and issues nothing.** Creating, showing, hashing and
 * revoking inference keys is the store the managed-access work builds later,
 * and building half of it here would be a second place keys live. What this
 * proves is the shape: the gateway authenticates per connection, derives the
 * organization from the credential and from nowhere else, and refuses without
 * saying anything about what it holds.
 */
export function staticSecretVerifier(config: Config): Verifier {
  return {
    async verify(credential: string | null): Promise<Verified> {
      if (credential === null || credential === "") return { refused: "absent" };
      if (!sameSecret(credential, config.organizationSecret)) {
        return { refused: "not-recognized" };
      }
      return {
        organizationId: config.organizationId,
        inferenceKeyId: config.inferenceKeyId,
      };
    },
  };
}
