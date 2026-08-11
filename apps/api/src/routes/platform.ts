import { platformInstanceId } from "@egma/db";
import type { FastifyPluginAsync } from "fastify";

import type { PhoneReadiness } from "../phone-readiness.ts";

export type PlatformRouteOptions = {
  /** The one browser/API origin configured for this platform. */
  readonly origin: string;
  /**
   * Whether this platform can place a phone call, and what is missing when it
   * cannot. Everything in it is non-secret — see `phone-readiness.ts` — which
   * is what lets it answer here, at the one door that asks for no credential.
   */
  readonly phone: PhoneReadiness;
};

/**
 * Where this contract answers.
 *
 * The CLI reads it at the origin a self-hoster was given, which is the web
 * process rather than this one, so the web rewrites have to carry the same
 * path. It is a constant here so the agreement between the three can be
 * checked rather than remembered.
 */
export const PLATFORM_IDENTITY_PATH = "/api/platform";

/** Public platform facts used before device login and repository binding. */
export const platformRoutes: FastifyPluginAsync<PlatformRouteOptions> = async (
  app,
  options,
) => {
  app.get(PLATFORM_IDENTITY_PATH, async (_request, reply) =>
    reply.send({
      instance_id: await platformInstanceId(),
      origin: options.origin,
      // Two facts, never one: a platform is ready for text work long before
      // anybody has given it a carrier, and a single "ready" that waited for
      // the carrier would make the first-run story impossible to tell.
      phone: {
        state: options.phone.state,
        missing: options.phone.missing,
      },
    }),
  );
};
