import {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  getSimulation,
  NotPermittedError,
  readSimulationUsage,
  readUsageThisPeriod,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { notFound, notPermitted } from "../http/refusals.ts";

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

  /**
   * How much of each allowance this organization has used this period.
   *
   * **The organization, and no project.** An allowance belongs to the customer
   * the way membership and API keys do, so this route names no project and
   * takes none — a settings page that reached it through a project-scoped door
   * would be saying a month of usage belongs to whichever project happened to
   * be selected, and somebody would eventually believe it.
   *
   * **On every deployment, and to every role.** A self-hoster reads the same
   * three numbers against no limit at all; a member reads them because a run
   * that paused for money has to explain itself to whoever started it.
   */
  app.get("/api/organization/usage", async (request, reply) => {
    const { auth } = requesterOf(request);
    const usage = await readUsageThisPeriod(auth);
    return reply.send({
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
