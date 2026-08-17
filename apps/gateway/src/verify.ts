import type { Config } from "./config.ts";

/**
 * The one replaceable thing about how a connection is authenticated.
 *
 * **The gateway asks one question and takes one answer: does this credential
 * authorize a connection, and which organization is it.** Everything about how
 * that answer is reached — a signature this deployment can check without asking
 * anybody, a hashed inference key that only Egma Cloud can recognise — sits
 * behind this interface, which is what keeps the public application from being
 * coupled to any one Cloudflare storage product. It is coupled to none: the
 * gateway stores no keys at all.
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

/**
 * Why a credential did not authorize a connection. Never the credential itself.
 *
 * **`unavailable` is a third answer rather than a kind of refusal, and keeping
 * it apart is the point.** A gateway that cannot reach the store where keys
 * live knows nothing about the credential it was handed — and telling a
 * customer their key is invalid because Egma could not look it up sends them to
 * rotate a key that was fine. One is a 401 and something to fix; the other is a
 * 503 and something to wait out.
 */
export type Refusal = {
  readonly refused: "absent" | "not-recognized" | "unavailable";
};

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
 * The static prefix an internal gateway credential starts with.
 *
 * Written here and in the control plane's own `managed-deployment.ts`, which is
 * the one duplication in this format and an unavoidable one: the two halves are
 * two deployables, one of which runs on Cloudflare Workers and cannot import a
 * package that speaks to Postgres. The deterministic suite mints with one and
 * checks with the other, which is what keeps the two spellings honest.
 */
export const INTERNAL_CREDENTIAL_PREFIX = "egma_ig_";

/** The identifier an internal credential is recorded under. Never a key. */
export const INTERNAL_CREDENTIAL_ID = "egma-internal";

function base64urlToBytes(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hosted Egma's own credential: **the organization, and a signature over it
 * made with a key only the control plane and this gateway hold.**
 *
 * `egma_ig_<payload>.<signature>`, where the payload names the organization and
 * the second the credential stops being good.
 *
 * **The organization travels inside the signature, which is what keeps it out
 * of a caller's hands.** The rule the whole design rests on is that no header,
 * query value, path or body may say which organization a connection acts for.
 * This does not bend it: what a caller presents is one opaque credential, and
 * an organization is read out of it only after the signature has proved this
 * deployment wrote it. Edit the organization and the signature stops matching;
 * hold no signing key and there is no organization you can name at all.
 *
 * **Nothing is exchanged and nothing is stored.** There is no round trip to get
 * one and no row per organization to keep — which is exactly why a hosted user
 * pastes nothing, and why this is not a per-simulation grant: it authenticates
 * the connection and hands back no provider credential, because it has none.
 */
export function internalCredentialVerifier(config: Config): Verifier {
  return {
    async verify(credential: string | null): Promise<Verified> {
      if (credential === null || credential === "") return { refused: "absent" };
      if (!credential.startsWith(INTERNAL_CREDENTIAL_PREFIX)) {
        return { refused: "not-recognized" };
      }
      const secret = config.internalCredentialKey;
      if (secret === undefined) return { refused: "not-recognized" };

      const [encoded, signature] = credential
        .slice(INTERNAL_CREDENTIAL_PREFIX.length)
        .split(".");
      if (encoded === undefined || signature === undefined) {
        return { refused: "not-recognized" };
      }

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const expected = bytesToBase64url(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)),
      );
      if (!sameSecret(signature, expected)) return { refused: "not-recognized" };

      const bytes = base64urlToBytes(encoded);
      if (bytes === null) return { refused: "not-recognized" };
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return { refused: "not-recognized" };
      }
      if (typeof payload !== "object" || payload === null) {
        return { refused: "not-recognized" };
      }

      const said = payload as Record<string, unknown>;
      const organizationId = said["o"];
      const expires = said["x"];
      if (typeof organizationId !== "string" || organizationId === "") {
        return { refused: "not-recognized" };
      }
      // Expiry is checked *after* the signature, deliberately: a caller must not
      // be able to learn anything about the shape of a payload they could not
      // have signed.
      if (typeof expires !== "number" || expires * 1000 <= Date.now()) {
        return { refused: "not-recognized" };
      }

      return { organizationId, inferenceKeyId: INTERNAL_CREDENTIAL_ID };
    },
  };
}

/** What Egma Cloud answers when it recognises an inference key. */
type Validated = {
  readonly organization_id?: unknown;
  readonly inference_key_id?: unknown;
};

/**
 * A real inference key, validated where inference keys actually live.
 *
 * **The gateway keeps no key store, and this is the decision that says so.**
 * Egma Cloud minted the key, hashed it and holds its lifecycle, so Egma Cloud
 * is asked whether it is still good — one small request when a connection
 * opens, never per audio frame. Two things fall out of that and both are
 * promises this product makes. There is no cache, so **revocation is effective
 * for the very next connection**. And there is no copy of anybody's key in
 * Cloudflare, so no Cloudflare storage product is part of the authentication
 * story and swapping one changes nothing here.
 *
 * The cost is honest and worth writing down: a connection cannot open while
 * Egma Cloud is unreachable. That is answered as `unavailable` rather than as a
 * refusal, so a customer is told to wait rather than told their key is bad.
 */
export function cloudInferenceKeyVerifier(
  config: Config,
  /** Injected so a test can drive the real verifier against a real local door. */
  request: typeof fetch = fetch,
): Verifier {
  return {
    async verify(credential: string | null): Promise<Verified> {
      if (credential === null || credential === "") return { refused: "absent" };
      const where = config.validationUrl;
      if (where === undefined) return { refused: "unavailable" };

      let answer: Response;
      try {
        answer = await request(where, {
          method: "POST",
          headers: {
            // The credential travels in the same header it arrived in, so there
            // is exactly one name for it on both sides of Egma.
            "egma-inference-key": credential,
            // No body at all: validation is content-free. Egma Cloud is asked
            // whether a credential is good and whose it is, and is told nothing
            // about the simulation, the persona or the model behind the ask.
            "content-length": "0",
          },
          signal: AbortSignal.timeout(config.validationTimeoutMs),
        });
      } catch {
        return { refused: "unavailable" };
      }

      if (answer.status === 401 || answer.status === 403) {
        return { refused: "not-recognized" };
      }
      if (!answer.ok) return { refused: "unavailable" };

      let said: Validated;
      try {
        said = (await answer.json()) as Validated;
      } catch {
        return { refused: "unavailable" };
      }

      const organizationId = said.organization_id;
      const inferenceKeyId = said.inference_key_id;
      if (
        typeof organizationId !== "string" ||
        organizationId === "" ||
        typeof inferenceKeyId !== "string" ||
        inferenceKeyId === ""
      ) {
        return { refused: "unavailable" };
      }
      return { organizationId, inferenceKeyId };
    },
  };
}

/**
 * The two authentication stories, asked in order, as one verifier.
 *
 * **Cheapest and most certain first.** An internal credential is a signature
 * this deployment can check on its own, so it costs nothing and cannot be
 * confused with anything else — its prefix says what it is. Anything that is
 * not one is an inference key, and that is the ask that leaves the isolate.
 *
 * `unavailable` outranks `not-recognized` in the composed answer, for the
 * reason it exists at all: if any verifier could not find out, the honest
 * answer about the credential is that nobody knows.
 */
export function eitherVerifier(verifiers: readonly Verifier[]): Verifier {
  return {
    async verify(credential: string | null): Promise<Verified> {
      let worst: Refusal = { refused: "absent" };
      for (const verifier of verifiers) {
        const verified = await verifier.verify(credential);
        if (isAuthenticated(verified)) return verified;
        if (verified.refused === "unavailable") worst = verified;
        else if (worst.refused === "absent") worst = verified;
      }
      return worst;
    },
  };
}

/**
 * The verifier a deployment runs: hosted Egma's own signed credentials, and
 * every organization's inference keys.
 *
 * One function rather than a choice each host makes, because both hosts run one
 * gateway and a difference between them would be a difference nobody tests.
 */
export function deployedVerifier(
  config: Config,
  request: typeof fetch = fetch,
): Verifier {
  return eitherVerifier([
    internalCredentialVerifier(config),
    cloudInferenceKeyVerifier(config, request),
  ]);
}
