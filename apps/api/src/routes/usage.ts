import {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  NotPermittedError,
  readOrganizationUsage,
  readUsageThisPeriod,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { invalid, notPermitted } from "../http/refusals.ts";

/** Organization usage is a shared browser read available to every member. */

export type UsageRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export async function usageRoutes(
  app: FastifyInstance,
  options: UsageRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  app.get("/api/organization/usage", async (request, reply) => {
    const { auth } = requesterOf(request);
    const usage = await readUsageThisPeriod(auth);
    const query = (request.query ?? {}) as Record<string, unknown>;
    let from = usage.startedAt;
    let to = usage.resetsAt;
    if (query.from !== undefined || query.to !== undefined) {
      if (
        typeof query.from !== "string" ||
        typeof query.to !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/u.test(query.from) ||
        !/^\d{4}-\d{2}-\d{2}T/u.test(query.to)
      )
        return invalid(reply, "from and to must both be ISO timestamps");
      from = new Date(query.from);
      to = new Date(query.to);
      if (
        !Number.isFinite(from.getTime()) ||
        !Number.isFinite(to.getTime()) ||
        from >= to
      )
        return invalid(
          reply,
          "from and to must define a valid increasing time period",
        );
    }
    const inference = await readOrganizationUsage(auth, { from, to });
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
