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
 * branch stopped matching. One function per code is what makes the vocabulary
 * countable: this file is the whole list.
 */

function refuse(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message });
}

/** The body could never be written, whatever is there. */
export function invalid(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, 400, "invalid_request", message);
}

/** Who is asking may not, whatever they asked for. */
export function notPermitted(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, 403, "not_permitted", message);
}

/**
 * There is nothing there — and existence is never confirmed to somebody who
 * could not have seen the thing anyway, so another customer's id and a
 * made-up one always get the same sentence.
 */
export function notFound(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, 404, "not_found", message);
}

/** Somebody got there first, or the thing has moved on. */
export function conflict(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, 409, "conflict", message);
}

/** The body was read and what it says cannot be acted on. */
export function unprocessable(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, 422, "unprocessable", message);
}

/**
 * A run over a connection type whose simulator adapter has not shipped.
 *
 * Its own code rather than an `unprocessable`, because the caller's next move
 * is different in kind: nothing about the request can be fixed, and the answer
 * is to run over something else or to wait for the adapter.
 */
export function noAdapter(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, 422, "no_adapter", message);
}
