import { ping } from "@egma/db";
import Fastify, { type FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  // The container health check polls this every few seconds; logging each poll
  // would bury everything else in `docker compose logs`.
  app.get("/health", { logLevel: "warn" }, async (_request, reply) => {
    try {
      await ping();
    } catch (cause) {
      app.log.error({ err: cause }, "health check could not reach Postgres");
      return reply.code(503).send({ status: "unavailable", postgres: "unreachable" });
    }
    return reply.send({ status: "ok", postgres: "reachable" });
  });

  return app;
}
