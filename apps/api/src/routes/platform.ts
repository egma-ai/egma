import { platformInstanceId } from "@egma/db";
import type { FastifyInstance } from "fastify";

/**
 * Which egma this is.
 *
 * Two facts and no third: the identifier this deployment minted for itself, and
 * the origin it believes it is reached on. Both are configuration rather than
 * credentials, and nothing here is behind a key — a repository has to be able
 * to ask *before* anybody has signed in, because which platform to sign in to
 * is the question being answered.
 *
 * It is the same contract in cloud and self-hosted deployments, on purpose:
 * `egma/config.yaml` commits this identifier beside the agent, connection and
 * test identifiers the platform owns, and every later command checks that the
 * address it is about to talk to still leads to the same platform. An origin
 * alone could not do that — a different egma served later at the same address
 * would answer to it — so the identifier is the part that binds and the origin
 * is the part a person reads. See ADR-0008.
 *
 * The identifier is read once per process. It is a single row that is written
 * once and never rewritten, so asking the database again on every request would
 * buy nothing but load on the door with the least authentication in front of it.
 */
export async function platformRoutes(
  app: FastifyInstance,
  options: { readonly baseUrl: string },
): Promise<void> {
  let known: string | undefined;

  app.get("/api/platform", async (_request, reply) => {
    known ??= await platformInstanceId();
    return reply.header("cache-control", "no-store").send({
      instance_id: known,
      origin: options.baseUrl.replace(/\/+$/u, ""),
    });
  });
}
