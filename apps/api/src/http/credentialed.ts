import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveRequester, type Requester } from "../auth/requester.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { RateLimit } from "./rate-limit.ts";
import { notAuthenticated, tooManyRequests } from "./refusals.ts";
import { toIdentityRequest } from "./web-handler.ts";

/**
 * Authenticate before applying the organization-level rate limit.
 * The encapsulated hook applies both checks to every route in this scope.
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
