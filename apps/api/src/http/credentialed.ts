import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveRequester, type Requester } from "../auth/requester.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { RateLimit } from "./rate-limit.ts";
import { notAuthenticated, tooManyRequests } from "./refusals.ts";
import { toIdentityRequest } from "./web-handler.ts";

/**
 * Everything that has to be true before a route with a customer's data in it
 * runs, as one hook rather than as a line every route remembers to write.
 *
 * Two things happen here and the order between them is the point. A request is
 * turned into a context first, because until then there is no organization —
 * and the rate limit is keyed on the organization, not on the credential, so
 * that rotating a key cannot reset a budget. Then the budget is checked. A
 * route inside this scope can only ever run for somebody, somewhere, within
 * their allowance.
 *
 * It is a hook on an encapsulated scope rather than a wrapper each route calls,
 * for the same reason the tenancy predicates live inside the data-access module:
 * a caller cannot forget what a caller cannot do.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the hook below, and therefore present on every route under it. */
    requester: Requester | null;
  }
}

export type CredentialedOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

/**
 * The requester on a request that got past the hook. Routes call this instead
 * of reading the optional field, so the invariant is stated once.
 */
export function requesterOf(request: FastifyRequest): Requester {
  const requester = request.requester;
  if (requester === null) {
    throw new Error(
      "a credentialed route ran without a requester, which the hook makes impossible",
    );
  }
  return requester;
}

/**
 * Applied by calling it from inside a route plugin rather than by registering
 * it beside one, so that the hook and the routes it protects share a scope and
 * a route cannot end up outside it by accident.
 */
export function credentialed(
  app: FastifyInstance,
  options: CredentialedOptions,
): void {
  app.decorateRequest("requester", null);

  app.addHook("onRequest", async (request, reply) => {
    // Headers and a URL, and deliberately no body: who is calling is answered
    // from a bearer token or a session cookie. `onRequest` runs before Fastify
    // parses anything, which makes that claim structural rather than a habit —
    // an unauthenticated request never has its body read at all, no schema
    // anybody adds later can answer ahead of the 401, and in front of the
    // ingest door the body is somebody's telemetry, where copying it for a
    // question that will never read it is the most expensive thing on the
    // path.
    const requester = await resolveRequester(
      options.provider,
      toIdentityRequest(request),
    );

    if (requester === null) {
      return notAuthenticated(reply);
    }

    const verdict = options.rateLimit.reached(requester.auth.organizationId);
    if (!verdict.allowed) {
      return tooManyRequests(reply, verdict.retryAfterSeconds);
    }

    request.requester = requester;
    return undefined;
  });
}
