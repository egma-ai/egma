import { getSimulation, NotPermittedError } from "@egma/db";
import { recordingOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { reachingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import {
  noObjectStore,
  notFound,
  notPermitted,
  unprocessable,
  unsignableReference,
} from "../http/refusals.ts";
import {
  signedRecordingLink,
  UnsignableReferenceError,
  type BlobStore,
} from "../recordings/signed-link.ts";

/**
 * Authorize a simulation recording and return a short-lived signed link.
 * Audio bytes and range requests go directly from storage to the browser.
 * Check scoped simulation existence, voice modality, and recording reference
 * before reporting missing storage configuration. Invalid reference shapes
 * use unsignable_reference, distinct from expected audio absence.
 */

export type RecordingRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /**
   * The store, or nothing on a deployment that named none. Handed in rather
   * than read here, because where the store is is one installation's
   * configuration and a route cannot know it.
   */
  readonly blob: BlobStore | undefined;
};

/** The path one simulation's recording is resolved at — the client's side. */
export function recordingPathFor(simulationId: string): string {
  return `/v1/simulations/${encodeURIComponent(simulationId)}/recording`;
}

/**
 * A simulation nobody may see reads exactly like a simulation nobody started.
 * Another organization's id and a made-up one get the same sentence, because
 * anything else would answer a question the reader was not entitled to ask.
 */
const NO_SUCH_SIMULATION =
  "no simulation of yours has that id. Check the id, or open the run it " +
  "belongs to with GET /v1/runs/{runId}.";

export async function recordingRoutes(
  app: FastifyInstance,
  options: RecordingRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  registerPlatformOperation(app, recordingOperations.getSimulationRecording, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { simulationId } = request.params as { simulationId: string };
    const query = (request.query ?? {}) as Record<string, unknown>;

    /**
     * Treat project as an optional resource filter through reachingIn.
     * An explicit browser selection replaces its default project; organization-wide
     * keys can look up a simulation ID without first choosing a project.
     */
    const acting = await reachingIn(auth, given(text(query.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const simulation = await getSimulation(acting.auth, simulationId);
    if (simulation === undefined) return notFound(reply, NO_SUCH_SIMULATION);

    if (simulation.modality === "chat") {
      return unprocessable(
        reply,
        `simulation ${simulation.id} is a chat conversation, and a chat has ` +
          `no audio to hear. What was said is its transcript; there is no ` +
          `recording of a chat and there never will be.`,
      );
    }

    if (simulation.recordingReference === null) {
      return notFound(
        reply,
        `simulation ${simulation.id} has no recording. A voice conversation ` +
          `that never connected wrote none, and so did one whose upload the ` +
          `store refused — the simulator's own log is where the second of ` +
          `those is visible.`,
      );
    }

    if (options.blob === undefined) {
      return noObjectStore(
        reply,
        "this Egma instance has no recording store configured, so a reference cannot " +
          "be resolved into anything a browser can fetch. Set " +
          "EGMA_BLOB_PUBLIC_URL on the api container to the address a browser " +
          "reaches the store at — not the address this container reaches it " +
          "at — with EGMA_BLOB_ACCESS_KEY_ID and EGMA_BLOB_SECRET_ACCESS_KEY " +
          "beside it.",
      );
    }

    // A reference nothing egma writes could have produced — one walking upwards
    // out of the bucket. Answered as a refusal about the row rather than as a
    // fault, because there is no request the caller could send that would fix
    // it and no link that would be honest to hand back.
    let link;
    try {
      link = signedRecordingLink(options.blob, simulation.recordingReference);
    } catch (why) {
      if (!(why instanceof UnsignableReferenceError)) throw why;
      request.log.error(
        { simulationId: simulation.id },
        `simulation ${simulation.id} carries a recording reference Egma will ` +
          `not sign; it did not come from a simulator`,
      );
      return unsignableReference(
        reply,
        `simulation ${simulation.id} points at a recording Egma will not ` +
          `resolve: ${why.message}`,
      );
    }

    return reply.send({
      simulationId: simulation.id,
      // The link, and never the reference: what the reference means is this
      // side's business, and a client that learned to compose one for itself
      // would be a client that breaks the day the deployment moves its store.
      url: link.url,
      // When the store stops honouring it. A client that keeps a results page
      // open for an afternoon needs this to tell "the recording is gone" from
      // "the link went stale" — the second is recoverable by asking again, and
      // a player that could not tell them apart would present a dead scrubber
      // as a broken recording.
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
