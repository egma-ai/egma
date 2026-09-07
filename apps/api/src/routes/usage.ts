import {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  allowanceKindOf,
  getRun,
  getSimulation,
  NotPermittedError,
  readQueuedWorkProviders,
  readSimulationUsage,
  readUsageThisPeriod,
  type EntitlementSource,
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
  /**
   * The deployment's entitlement source, for the run page's own question:
   * why is this run's queued work waiting. On a deployment with no billing it
   * answers yes without reaching anything, and the page shows nothing.
   */
  readonly entitlements: EntitlementSource;
};

const NO_SUCH_RUN =
  "no run of yours has that id. Check the id, or list the runs in this " +
  "project with GET /v1/runs.";

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

  /**
   * Why this run's queued work is waiting, if it is waiting for money.
   *
   * **Asked, never stored.** A conversation the claim door refused stays
   * queued and nothing writes the reason down: no shared table gains a column
   * for the cloud, and a stored reason would go stale the moment the month
   * reset, the plan changed or credit arrived. So this asks the deployment the
   * same two questions the claim door asks, about the same run, and answers
   * what a person would be told now.
   *
   * **It is the whole run's answer and not one conversation's**, because the
   * two questions are about a customer and a lane: every conversation in a run
   * goes over one connection, and a spent allowance or an empty balance stops
   * all of them or none of them.
   *
   * Every role may read it, for the reason every role may read the usage: a run
   * that paused for money has to explain itself to whoever started it.
   */
  app.get("/api/runs/:runId/billing-hold", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { runId } = request.params as { runId: string };
    const acting = await reachingIn(
      requesterOf(request).auth,
      given(text(query.projectId)),
    );
    if ("refusal" in acting) return refuseActing(reply, acting);

    const run = await getRun(acting.auth, runId);
    if (run === undefined) return notFound(reply, NO_SUCH_RUN);

    const auth =
      acting.auth.projectId === run.projectId
        ? acting.auth
        : { ...acting.auth, projectId: run.projectId };
    const providers = await readQueuedWorkProviders(auth, runId);
    // A run with nothing queued is waiting for nobody. Asking anyway would
    // show a refusal beside a run that has already finished.
    if (providers.length === 0) {
      return reply.send({ runId, holds: [] });
    }

    const kind = allowanceKindOf({
      modality: run.connectionSnapshot.modality,
      connectionType: run.connectionSnapshot.connectionType,
    });
    const [start, funding] = await Promise.all([
      options.entitlements.mayStart({
        organizationId: auth.organizationId,
        allowances: [kind],
      }),
      options.entitlements.mayPlatformKeyFund({
        organizationId: auth.organizationId,
        providers: [...providers],
      }),
    ]);

    const holds: Record<string, unknown>[] = [];
    if (!start.allowed) {
      for (const refusal of start.refusals) {
        holds.push({
          held: "allowance",
          allowance: refusal.allowance,
          unit: ALLOWANCE_UNITS[refusal.allowance],
          resetsAt: refusal.resetsAt.toISOString(),
          message: refusal.message,
        });
      }
    }
    if (!funding.funded) {
      holds.push({
        held: "funding",
        providers: funding.providers,
        message: funding.message,
      });
    }
    return reply.send({ runId, holds });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
