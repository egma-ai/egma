import type { FastifyInstance } from "fastify";

import { browserSessionIn } from "../auth/better-auth.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { toWebRequest } from "../http/web-handler.ts";

/**
 * Stopping being somebody.
 *
 * This is the other half of what a browser needs from the seam — `resolveIdentity`
 * says who this is, `revokeSession` ends it — and it goes through the seam rather
 * than at the provider's own sign-out endpoint. Relaying is right for signing up
 * and for the device flow, where the provider owns the mechanics and egma is
 * adding to them; ending a session is a question egma asks the provider, and the
 * seam is what egma asks provider questions through.
 *
 * The session is destroyed where it is actually kept, so it is over for every
 * copy of the cookie rather than for the browser that clicked. Expiring the
 * cookie afterwards is tidiness rather than the mechanism: it names a row that
 * no longer exists, and would resolve to nobody either way.
 *
 * Signing out when nobody is signed in is not a refusal. There is nothing to do
 * and the thing being asked for is already true, and answering 401 would mean a
 * person whose session expired in a tab is told they cannot leave.
 *
 * Nothing here checks where the request came from, because the cookie already
 * does: it is `SameSite=Lax`, so a cross-site form post arrives without it and
 * finds no session to end.
 */
export async function signOutRoutes(
  app: FastifyInstance,
  options: { readonly provider: SessionIdentityProvider },
): Promise<void> {
  app.post("/api/sign-out", async (request, reply) => {
    const carried = browserSessionIn(toWebRequest(request));

    if (carried !== null) {
      await options.provider.revokeSession(carried.token);
      reply.header("set-cookie", carried.expired);
    }

    return reply.send({ signed_out: true });
  });
}
