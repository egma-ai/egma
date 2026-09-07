import {
  getSimulation,
  NotPermittedError,
  readSimulationUsage,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { notFound, notPermitted } from "../http/refusals.ts";

/**
 * What one simulation cost, for the pages that show it.
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
};

const NO_SUCH_SIMULATION =
  "no simulation of yours has that id. Check the id, or open the run it " +
  "belongs to with GET /v1/runs/{runId}.";

export async function usageRoutes(
  app: FastifyInstance,
  options: UsageRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  /**
   * **Every role may read it.** A run that paused for money has to explain
   * itself to whoever started it, whatever they are allowed to change — so the
   * refusal a `viewer` meets is on the buttons, never on the number.
   */
  app.get("/api/simulations/:simulationId/usage", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { simulationId } = request.params as { simulationId: string };
    const acting = await reachingIn(
      requesterOf(request).auth,
      given(text(query.projectId)),
    );
    if ("refusal" in acting) return refuseActing(reply, acting);

    const simulation = await getSimulation(acting.auth, simulationId);
    if (simulation === undefined) {
      return notFound(reply, NO_SUCH_SIMULATION);
    }
    // An organization-wide credential can find this id across its projects.
    // Once the row is known, the read uses the exact project the row names,
    // because spend is filed inside one.
    const usage = await readSimulationUsage(
      acting.auth.projectId === simulation.projectId
        ? acting.auth
        : { ...acting.auth, projectId: simulation.projectId },
      simulationId,
    );

    return reply.send({
      simulationId,
      amountMicros: usage.amountMicros,
      requests: usage.requests,
      byModel: usage.byModel.map((one) => ({
        provider: one.provider,
        model: one.model,
        unit: one.unit,
        requests: one.requests,
        quantities: one.quantities,
        amountMicros: one.amountMicros,
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
