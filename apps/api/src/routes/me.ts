import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { resolveSession } from "../auth/session.ts";
import { toIdentityRequest } from "../http/web-handler.ts";

/**
 * Return session identity, organization membership, and accessible projects
 * for the web app's scope selection.
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
