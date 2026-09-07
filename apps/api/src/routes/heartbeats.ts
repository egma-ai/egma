import { recordSimulationHeartbeat } from "@egma/db";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import { invalid, notTheService } from "../http/refusals.ts";

/**
 * Service-token heartbeat route outside organization rate limits. Return
 * cancel for requested cancellation, unknown simulations, other claimants,
 * or terminal rows; otherwise return null. No long polling.
 */

export type HeartbeatRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
};

export const HEARTBEATS_PATH = "/v1/simulations/:simulationId/heartbeats";

type Body = Record<string, unknown>;

/**
 * The claimant as this door reads it, or the sentence refusing the body. The
 * reader is the simulator's log and whoever is tailing it, so the refusal
 * says what to send instead — and a malformed body is the one thing here
 * that is never answered with a directive, because it is the caller's wiring
 * that is broken, not the conversation.
 */
function claimantOf(body: Body): string | { readonly refusal: string } {
  const claimant = body.claimant;
  if (typeof claimant !== "string" || claimant.trim() === "") {
    return {
      refusal:
        "a heartbeat names its claimant — the same name this simulator " +
        "claimed the simulation under. Send claimant as non-empty text, " +
        'like "egma-simulator-1".',
    };
  }
  if (claimant.trim().length > 200) {
    return {
      refusal:
        "a claimant's name fits in 200 characters; it is a label for telling " +
        "two simulators apart, not a place for anything longer.",
    };
  }
  return claimant.trim();
}

export async function heartbeatRoutes(
  app: FastifyInstance,
  options: HeartbeatRoutesOptions,
): Promise<void> {
  // The gate, as a hook on this scope rather than a line in the route, for
  // the reason the claim door's is one: a route inside this group cannot run
  // unguarded, and a header is all it reads — an unauthenticated request
  // never has its body parsed at all.
  app.addHook("onRequest", async (request, reply) => {
    if (!acceptsServiceToken(request.headers.authorization, options.serviceToken)) {
      return notTheService(reply);
    }
    return undefined;
  });

  /**
   * One beat for one simulation, answering `{ directive: "cancel" | null }`.
   */
  app.post(HEARTBEATS_PATH, async (request, reply) => {
    const claimant = claimantOf((request.body ?? {}) as Body);
    if (typeof claimant !== "string") return invalid(reply, claimant.refusal);

    const { simulationId } = request.params as { simulationId: string };
    const held = await recordSimulationHeartbeat({ simulationId, claimant });

    // A beat with nothing under it — unknown, someone else's, already ended
    // — steers exactly as a requested cancellation does. The seam already
    // answered "there is nothing here for you"; this door's job is to say it
    // in the one word the simulator acts on.
    const directive =
      held === undefined || held.cancelRequested ? "cancel" : null;
    return reply.send({ directive });
  });
}
