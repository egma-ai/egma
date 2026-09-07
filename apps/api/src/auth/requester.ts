import type { AuthContext, Via } from "@egma/db";

import { resolveApiKeyRequest } from "./api-key.ts";
import type { SessionIdentityProvider } from "./seam.ts";
import { resolveSession } from "./session.ts";

/**
 * Try Egma API-key authentication first. A resolved key bypasses the identity
 * provider; absent or unresolved keys fall through to session authentication.
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
