import type { FastifyInstance } from "fastify";

import { browserSessionIn } from "../auth/better-auth.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { toWebRequest } from "../http/web-handler.ts";

/**
 * Delete the stored session before expiring the browser cookie, invalidating
 * other copies too. A missing session is a successful no-op. This route has
 * no explicit origin check and relies on the cookie's SameSite policy.
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
