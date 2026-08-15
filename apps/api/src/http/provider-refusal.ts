import type { FastifyReply } from "fastify";

/**
 * What the auth provider refused, said in egma's own vocabulary.
 *
 * Two routes relay to the provider's own HTTP endpoints — signup and the
 * completing half of a password reset — and both then have to turn the
 * provider's answer into egma's. **They must not each invent that translation.**
 * A refusal's code is the contract's spine (ADR-0007): clients branch on it
 * and only on it, so two relays that spelled the same refusal two ways would
 * be two contracts. This module is the one translation,
 * and it is why a rate limit reads the same whichever door met it.
 *
 * **The provider's own spelling of a code never reaches a client.** It writes
 * `PASSWORD_TOO_SHORT`; egma's codes are snake_case, always, so what ships is
 * `password_too_short`. That is not decoration: a code is a promise egma makes
 * about egma, and shipping the vendor's exact spelling would make every code
 * in this API a vendor's word to keep — a provider swap would then be a
 * breaking change for every client rather than a change behind the seam.
 * egma's own refusals travel this same channel already spelled egma's way
 * (`invitation_required` from the signup hooks), and pass through untouched,
 * sentence and all.
 *
 * A code egma cannot recognise as a code is not relayed at all. The caller's
 * fallback is used instead, because a client branching on `error` must never
 * be handed a sentence, a stack frame, or an empty string wearing the shape of
 * a promise.
 *
 * **The provider's sentence is relayed only where it is about the caller.**
 * "Password is too short" describes what somebody typed, and the provider is
 * the one holding that rule, so it goes back word for word. What its body
 * schema writes does not: `[body.email] Invalid email address` names a field in
 * a parser rather than the situation a person is in, and ADR-0007 forbids a
 * refusal generated from validation internals. There is nothing in it to
 * translate, so none of it is relayed — the door's own fallback is what a
 * caller reads, at both doors, without either of them having to remember.
 */

/** How long to wait when the provider refused for rate and said nothing more. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** The shape every code in this API has, and the only shape that is relayed. */
const A_CODE = /^[a-z][a-z0-9_]*$/;

/** The provider's code for a body its own schema refused, whatever the door. */
const GENERATED_FROM_THE_SCHEMA = "validation_error";

export type ProviderRefusal = {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  /** Present only for a refusal about rate, where waiting is the instruction. */
  readonly retryAfterSeconds: number | undefined;
};

/** What a route says when the provider named nothing egma could relay. */
export type RefusalFallback = {
  readonly error: string;
  readonly message: string;
};

/**
 * Reading a refusal off the provider's response.
 *
 * The body is read once and defensively: a provider that answered HTML, an
 * empty body or a proxy's own page is a provider that named no code, which is
 * exactly what the fallback is for.
 */
export async function providerRefusal(
  response: Response,
  fallback: RefusalFallback,
): Promise<ProviderRefusal> {
  const said = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    message?: unknown;
  };

  // Rate is the one refusal the provider decides *before* an endpoint runs, so
  // it names no code at all — and it is the one a person reaches by ordinary
  // impatience rather than by doing anything wrong. It gets egma's own code,
  // egma's own sentence, and the wait in the one header a client already reads.
  if (response.status === 429) {
    const seconds = Number(response.headers.get("x-retry-after"));
    const wait =
      Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds)
        : DEFAULT_RETRY_AFTER_SECONDS;
    return {
      status: 429,
      error: "too_many_requests",
      message:
        `too many requests like this one have come from here. Wait ${wait} ` +
        `seconds and send it again — nothing was refused about what it says.`,
      retryAfterSeconds: wait,
    };
  }

  const code =
    typeof said.code === "string" ? said.code.trim().toLowerCase() : "";

  // A code that names the provider's own body schema, whose sentence names a
  // field inside it. Nothing about either is egma's to ship, so neither is.
  if (code === GENERATED_FROM_THE_SCHEMA) {
    return {
      status: response.status,
      error: fallback.error,
      message: fallback.message,
      retryAfterSeconds: undefined,
    };
  }

  return {
    status: response.status,
    error: A_CODE.test(code) ? code : fallback.error,
    message:
      typeof said.message === "string" && said.message.trim() !== ""
        ? said.message
        : fallback.message,
    retryAfterSeconds: undefined,
  };
}

/** The same refusal, answered. One sender, so the two relays cannot drift. */
export function sendProviderRefusal(
  reply: FastifyReply,
  refusal: ProviderRefusal,
): FastifyReply {
  if (refusal.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(refusal.retryAfterSeconds));
  }
  return reply
    .code(refusal.status)
    .send({ error: refusal.error, message: refusal.message });
}
