import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { resolveSession } from "../auth/session.ts";
import { toIdentityRequest } from "../http/web-handler.ts";

/**
 * Where the person holding this session is: who they are, which organization,
 * which projects.
 *
 * The pages hide any level whose cardinality is one, so this returns the lists
 * rather than a chosen one. Somebody with a single organization and a single
 * project sees neither picker — not because a page was told to hide them, but
 * because there is nothing to pick between and the page renders a picker only
 * when there is.
 */
export async function meRoutes(
  app: FastifyInstance,
  options: { readonly provider: SessionIdentityProvider },
): Promise<void> {
  app.get("/api/me", async (request, reply) => {
    const session = await resolveSession(
      options.provider,
      toIdentityRequest(request),
    );

    if (session === null) {
      return reply
        .code(401)
        .send({ error: "not_signed_in", message: "no session on this request" });
    }

    return reply.send({
      user: { id: session.userId, email: session.email },
      organizations: session.organizations,
      projects: session.projects.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
      })),
    });
  });
}
