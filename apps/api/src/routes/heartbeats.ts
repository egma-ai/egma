import { recordSimulationHeartbeat } from "@egma/db";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import { invalid, notTheService } from "../http/refusals.ts";

/**
 * The heartbeat door: `POST /v1/simulations/:id/heartbeats`, where a
 * conducting simulator says it is still here — and hears the one directive
 * that ever travels back.
 *
 * The gate and the budget arrangements are the claim door's, for the claim
 * door's reasons (`claims.ts` carries them in full): the service token is the
 * whole gate and resolves to no customer, and the group sits outside the
 * per-organization rate limit because a busy run beats every few seconds per
 * conversation from inside egma itself, and must never eat any customer's
 * request budget. Unlike the claim, nothing here watches the socket: a beat
 * is one guarded update, answered briskly, with no hold for a client to
 * abandon.
 *
 * **The answer steers, and `cancel` is its only word.** A beat lands on the
 * claimant's own live row and answers `null` — or `"cancel"` when
 * cancellation was requested, and equally for every row beyond help: an id
 * this egma never issued, another claimant's row, one already terminal. The
 * shipped simulator obeys exactly one directive, and steering it to stop
 * within one beat beats letting it conduct a closed conversation to its
 * duration limit against a customer's real agent. Which is also why there is
 * deliberately no 404 here: "that conversation is not yours to conduct" and
 * "stop conducting it" are the same instruction, and only one of them is a
 * directive the simulator acts on.
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
