import { platformFacts, platformInstanceId } from "@egma/db";
import type { FastifyPluginAsync } from "fastify";

import type { PhoneReadiness } from "../phone-readiness.ts";
import { platformReadiness } from "../platform-readiness.ts";

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
  app.get(PLATFORM_IDENTITY_PATH, async (_request, reply) => {
    // Read from the store on every request rather than held from start, which
    // is the whole point of the settings living there: an operator who supplies
    // a missing key stops being `setup required` at once, without a restart.
    // It is a select and never an insert, on the identity read's own reasoning
    // — this door is public and anybody who can reach the platform may knock as
    // often as they like.
    const setup = platformReadiness(await platformFacts(), options.phone);

    return reply.send({
      instance_id: await platformInstanceId(),
      origin: options.origin,
      // What the whole platform is still missing, in the words a person would
      // use, and never a secret — see `platform-readiness.ts`.
      setup: { state: setup.state, missing: setup.missing },
      // Two facts, never one: a platform is ready for text work long before
      // anybody has given it a carrier, and a single "ready" that waited for
      // the carrier would make the first-run story impossible to tell.
      phone: {
        state: options.phone.state,
        missing: options.phone.missing,
      },
    });
  });
};
