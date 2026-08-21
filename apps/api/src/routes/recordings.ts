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
 * `GET /v1/simulations/:simulationId/recording` — the one route that turns a
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
 *
 * **Two of those are settled facts about the conversation and one is a defect,
 * and the codes say which.** `not_found` and `unprocessable` mean there is
 * nothing to hear and there never was — a surface that asks about every
 * conversation it shows may answer them by offering nothing at all. A reference
 * egma will not sign is not that: it answers `unsignable_reference`, because a
 * row carrying something no simulator could have written is a fault, the audio
 * it points at may well exist, and a fault that shares a code with an honest
 * absence goes invisible on exactly the surface that would meet it most.
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
     * **The project the caller named, where it named one.**
     *
     * `getSimulation` narrows by the acting project, and a session's acting
     * project is the organization's first — so this route read the recording of
     * a conversation in the first project and answered *no such conversation*
     * about every other one. The evidence page beside it reads its project and
     * loaded perfectly; only the audio on it went missing, which is the shape
     * that is hardest to notice.
     *
     * **Optional, because one of the two surfaces has no project to name.** A
     * run's evidence page is inside one and says so; a transcript may be a
     * production exchange nobody simulated, on an organization-wide page, and
     * naming none there is the same absent case every other route answers.
     *
     * **`reachingIn`, so that "optional" stays optional.** A simulation id is
     * unique inside the organization; the project narrows the lookup and never
     * chooses it. `actingIn` would turn a naming-none request from a key for
     * the whole organization into *name the project* — a 400 in place of the
     * audio, on the one surface whose whole point is that it need not know.
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
