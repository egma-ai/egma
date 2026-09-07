import {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  NotPermittedError,
  readOrganizationUsage,
  readUsageThisPeriod,
  type EntitlementSource,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { notPermitted } from "../http/refusals.ts";

/**
 * What Egma's work has cost, for the pages that show it: one simulation's
 * providers, and one organization's platform usage this period.
 *
 * **A browser path, not `/v1`, and that is the decision rather than an
 * oversight.** The published contract gains nothing from the billing effort:
 * usage is a product surface Egma's own pages read, and a shape in the public
 * API is a shape Egma has to keep for customers before any of them has asked
 * for one. So it sits beside `/api/me` — its own file, registered beside the
 * other account routes, and outside the operation set that produces OpenAPI
 * and the generated client, which no path prefix can be argued into.
 *
 * It is credentialed on the same terms as every customer read: the context
 * comes from the session or the key, the rate limit is keyed on the
 * organization, and the read itself goes through the data-access module.
 */

export type UsageRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /**
   * The deployment's entitlement source, for the run page's own question:
   * why is this run's queued work waiting. On a deployment with no billing it
   * answers yes without reaching anything, and the page shows nothing.
   */
  readonly entitlements: EntitlementSource;
};

export async function usageRoutes(
  app: FastifyInstance,
  options: UsageRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  app.get("/api/organization/usage", async (request, reply) => {
    const { auth } = requesterOf(request);
    const usage = await readUsageThisPeriod(auth);
    const inference = await readOrganizationUsage(auth, { from: usage.startedAt, to: usage.resetsAt });
    return reply.send({
      inference,
      periodStartedAt: usage.startedAt.toISOString(),
      resetsAt: usage.resetsAt.toISOString(),
      // An ordered list rather than an object, so the page renders three facts
      // in one order on every deployment, and each carries the unit it is
      // counted in rather than a word the page invented for it.
      allowances: ALLOWANCE_KINDS.map((kind) => ({
        kind,
        unit: ALLOWANCE_UNITS[kind],
        used: usage.used[kind],
      })),
    });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
