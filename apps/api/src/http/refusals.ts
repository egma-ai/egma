import type { FastifyReply } from "fastify";

/**
 * The refusal vocabulary of this API, written once.
 *
 * Every refusal is `{ error, message }`: a stable snake_case code a client
 * branches on, and a plain sentence saying what happened and what to do next.
 * The codes are contract and never change; the sentences improve deliberately.
 *
 * These live in one module because a code is a promise. A route group that
 * spelled its own `{ error: "not_permitted" }` would be free to spell it
 * `not-permitted` on a Tuesday, and nothing would notice until a client's
 * branch stopped matching. `CODES` below is the whole vocabulary and the only
 * place a code is spelled beside its status; everything that answers a refusal
 * — the senders here, the door's two in `credentialed.ts`, and the agent
 * group's refusal values — derives from it, so an unlisted code cannot
 * compile, let alone ship.
 */

export const CODES = {
  invalid_request: 400,
  not_authenticated: 401,
  not_permitted: 403,
  not_found: 404,
  conflict: 409,
  name_taken: 409,
  unprocessable: 422,
  no_adapter: 422,
  too_many_requests: 429,
} as const;

export type RefusalCode = keyof typeof CODES;

function refuse(
  reply: FastifyReply,
  error: RefusalCode,
  message: string,
): FastifyReply {
  return reply.code(CODES[error]).send({ error, message });
}

/** The body could never be written, whatever is there. */
export function invalid(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "invalid_request", message);
}

/** Who is asking may not, whatever they asked for. */
export function notPermitted(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "not_permitted", message);
}

/**
 * There is nothing there — and existence is never confirmed to somebody who
 * could not have seen the thing anyway, so another customer's id and a
 * made-up one always get the same sentence.
 */
export function notFound(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "not_found", message);
}

/** Somebody got there first, or the thing has moved on. */
export function conflict(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "conflict", message);
}

/** A name a living thing in the same place already holds. */
export function nameTaken(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "name_taken", message);
}

/** The body was read and what it says cannot be acted on. */
export function unprocessable(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "unprocessable", message);
}

/**
 * A run over a connection type whose simulator adapter has not shipped.
 *
 * Its own code rather than an `unprocessable`, because the caller's next move
 * is different in kind: nothing about the request can be fixed, and the answer
 * is to run over something else or to wait for the adapter.
 */
export function noAdapter(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "no_adapter", message);
}

/**
 * No session and no usable key. Written here so the door in `credentialed.ts`
 * and this list can never disagree about the one sentence every group behind
 * the door answers with.
 */
export function notAuthenticated(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this request carried no session and no usable API key. " +
      "Sign in, or send Authorization: Bearer with an egma key.",
  );
}

/**
 * No usable service token, on the routes egma's own simulator claims work
 * through. The same code as the door above and a different sentence, because
 * the caller's next move is different in kind: no sign-in and no customer key
 * can ever open this one — the deployment's own secret is the whole gate.
 */
export function notTheService(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this route hands out simulation work and answers only to egma's own " +
      "simulator. Send Authorization: Bearer with the deployment's " +
      "EGMA_SIMULATOR_SERVICE_TOKEN — the same value the api and simulator " +
      "containers were started with. A customer API key can never open it.",
  );
}

/**
 * A bearer wearing the service prefix that is not this deployment's secret, on
 * the one door that serves the service token beside customer credentials. Its
 * own sentence because the general one would say "sign in", and the reader is
 * a simulator's log: the prefix means this was never a customer key, and the
 * fix is the token, not a session.
 */
export function wrongServiceToken(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this bearer starts egma_st_ and is not this deployment's " +
      "EGMA_SIMULATOR_SERVICE_TOKEN. The api and simulator containers read " +
      "the same value — restart whichever holds a stale one. A customer key " +
      "starts egma_sk_ and files under its own account instead.",
  );
}

/** The organization's request budget is spent; the header says when to retry. */
export function tooManyRequests(
  reply: FastifyReply,
  retryAfterSeconds: number,
): FastifyReply {
  reply.header("retry-after", String(retryAfterSeconds));
  return refuse(
    reply,
    "too_many_requests",
    "this organization has made too many requests. The budget belongs " +
      "to the organization, so a new key will not reset it.",
  );
}
