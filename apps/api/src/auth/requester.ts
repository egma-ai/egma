import type { AuthContext, Via } from "@egma/db";

import { resolveApiKeyRequest } from "./api-key.ts";
import type { SessionIdentityProvider } from "./seam.ts";
import { resolveSession } from "./session.ts";

/**
 * Whoever is on the other end of a request, however they proved it.
 *
 * Two credentials reach egma and they are resolved by two different resolvers,
 * in a deliberate order. **The key is tried first, and a request carrying one
 * never reaches the second branch** — which is what makes the sentence "an
 * API-key request runs no provider code at all" true of the code rather than
 * only of the intention. Falling through to the session resolver would run
 * `resolveIdentity`, and that is the provider.
 */

export type Requester = {
  readonly auth: AuthContext;
  readonly via: Via;
  /** Which key, when it was a key. Absent for a browser. */
  readonly apiKeyId?: string;
};

export async function resolveRequester(
  provider: SessionIdentityProvider,
  request: Request,
): Promise<Requester | null> {
  const key = await resolveApiKeyRequest(request);
  if (key !== null) {
    return { auth: key.auth, via: "api_key", apiKeyId: key.apiKeyId };
  }

  const session = await resolveSession(provider, request);
  if (session?.auth === undefined) return null;
  return { auth: session.auth, via: "session" };
}
