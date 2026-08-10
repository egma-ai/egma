import { platformInstanceId } from "@egma/db";
import type { FastifyPluginAsync } from "fastify";

export type PlatformRouteOptions = {
  /** The one browser/API origin configured for this platform. */
  readonly origin: string;
};

/** Public platform facts used before device login and repository binding. */
export const platformRoutes: FastifyPluginAsync<PlatformRouteOptions> = async (
  app,
  options,
) => {
  app.get("/api/platform", async (_request, reply) =>
    reply.send({
      instance_id: await platformInstanceId(),
      origin: options.origin,
    }),
  );
};
