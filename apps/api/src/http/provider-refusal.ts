import type { FastifyReply } from "fastify";

/**
 * Translate provider refusals into stable snake_case API codes.
 * Preserve recognized caller-facing messages and Egma hook errors; use the
 * route fallback for invalid codes or validation-internal messages. Signup
 * and password-reset relays share this translation.
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
