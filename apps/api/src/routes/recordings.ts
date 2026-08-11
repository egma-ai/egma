import { getSimulation, NotPermittedError } from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import {
  noObjectStore,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";
import {
  signedRecordingLink,
  type BlobStore,
} from "../recordings/signed-link.ts";

/**
 * `GET /api/simulations/:simulationId/recording` — the one route that turns a
 * recording's reference into something a browser can play.
 *
 * The contract has promised this for as long as the reference has existed:
 * *resolved by the control plane; never a URL, never carries how to fetch it*.
 * A voice simulation writes one dual-channel recording — the person calling on
 * one channel, the agent under test on the other, so each can be heard alone
 * when a transcript looks wrong — and reports an opaque reference to it. This is
 * where that reference becomes audible.
 *
 * **Only the decision passes through here.** The answer is a short-lived signed
 * link and the bytes go from the store straight to the browser, which is what
 * makes seeking free: dragging the scrubber is a byte range the store serves,
 * not megabytes of audio re-proxied through a control plane. What egma does is
 * decide whether this reader may hear this recording, and then sign.
 *
 * **One route, two surfaces.** A run's results reach it by simulation id; a
 * transcript reaches it by converting the trace identifier it already holds,
 * because a trace identifier and a simulation identifier are the same number in
 * two forms and the contract carries the conversion. So the transcript surface
 * needs no second endpoint, no new join and no new read.
 *
 * ## Refusal before success
 *
 * The boundary is the **organization** — the only boundary in the product — and
 * it is honoured by the same machinery every other read uses rather than by
 * anything of this route's own: `getSimulation` stamps the caller's own tenancy
 * into the query, so a simulation in somebody else's organization is not a
 * refusal at all, it is simply not there. Four refusals, in this order, and the
 * order is the point:
 *
 * 1. **Not this reader's.** A simulation outside the caller's organization, one
 *    in a project their key does not reach, and an id nobody ever minted all
 *    answer the same sentence. Existence is never confirmed to somebody who
 *    could not have seen the thing anyway.
 * 2. **A chat carries no audio.** The database already forbids a chat row from
 *    holding a recording, so this could be left to fall through to "no
 *    recording" — and it is answered on its own terms instead, because agreeing
 *    with the rule out loud tells a reader that no amount of waiting or
 *    re-running will produce audio here, where "no recording" would suggest it
 *    might.
 * 3. **No recording.** A voice simulation whose call never connected wrote
 *    nothing. So did one whose upload the store refused — the two are
 *    indistinguishable from here, and the spec's Further Notes record that gap
 *    rather than hiding it.
 * 4. **No store configured**, last of the four on purpose. It is the one
 *    refusal that is about the deployment rather than about the request, and
 *    answering it before the three above would let a stranger learn whether a
 *    simulation exists by watching which sentence comes back.
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

export const SIMULATION_RECORDING_PATH =
  "/api/simulations/:simulationId/recording";

/** The path one simulation's recording is resolved at — the client's side. */
export function recordingPathFor(simulationId: string): string {
  return `/api/simulations/${encodeURIComponent(simulationId)}/recording`;
}

/**
 * A simulation nobody may see reads exactly like a simulation nobody started.
 * Another organization's id and a made-up one get the same sentence, because
 * anything else would answer a question the reader was not entitled to ask.
 */
const NO_SUCH_SIMULATION =
  "no simulation of yours has that id. Check the id, or open the run it " +
  "belongs to with GET /api/runs/{run_id}.";

export async function recordingRoutes(
  app: FastifyInstance,
  options: RecordingRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  app.get(SIMULATION_RECORDING_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { simulationId } = request.params as { simulationId: string };

    const simulation = await getSimulation(auth, simulationId);
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
        "this egma has no recording store configured, so a reference cannot " +
          "be resolved into anything a browser can fetch. Set " +
          "EGMA_BLOB_PUBLIC_URL on the api container to the address a browser " +
          "reaches the store at — not the address this container reaches it " +
          "at — with EGMA_BLOB_ACCESS_KEY_ID and EGMA_BLOB_SECRET_ACCESS_KEY " +
          "beside it.",
      );
    }

    const link = signedRecordingLink(options.blob, simulation.recordingReference);

    return reply.send({
      simulation_id: simulation.id,
      // The link, and never the reference: what the reference means is this
      // side's business, and a client that learned to compose one for itself
      // would be a client that breaks the day the deployment moves its store.
      url: link.url,
      // When the store stops honouring it. A client that keeps a results page
      // open for an afternoon needs this to tell "the recording is gone" from
      // "the link went stale" — the second is recoverable by asking again, and
      // a player that could not tell them apart would present a dead scrubber
      // as a broken recording.
      expires_at: link.expiresAt.toISOString(),
      // What band the recording was measured at, carried beside it because two
      // bands are two units: the narrow band a telephone carries strips what an
      // audio grader reads, and a reader listening should know which one they
      // are hearing. Null on a recording written before the measure existed.
      measured_audio_band_hertz: simulation.measuredAudioBandHertz,
      // One person to a channel, which is the whole reason the recording is
      // dual-channel: a reader who cannot tell whether the agent said nothing
      // or the persona talked over it can listen to one side alone.
      channels: { left: "persona", right: "agent" },
    });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
