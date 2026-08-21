import {
  listGraderLibrary,
  NotPermittedError,
  type LibraryEntry,
} from "@egma/db";
import { isId } from "@egma/ids";
import { graderLibraryOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import { invalid, notPermitted } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";

/**
 * The grader library, as the Library screen reads it: the shelf of definitions
 * a developer picks from.
 *
 * **One verb, and that is the product decision showing through.** There is no
 * create, no edit and no delete here, because v0 ships a small shelf of graders
 * egma maintains rather than an authoring surface asking a team to design
 * judgment logic on their first day. Custom entries land in the same table when
 * authoring arrives, and this same list will answer them beside egma's with the
 * team as their owner.
 *
 * **Owner is the entry's own fact, not this door's.** It is derived from
 * tenancy inside the data-access module — null organization means egma owns it
 * — so a screen showing "egma" and a row belonging to a team can never be the
 * same row. Nothing here computes it and nothing here could override it.
 *
 * The address follows the standing rule: nothing is rooted at a project and the
 * organization is never in a path. A read may filter to a project and does not
 * have to; in a single-project organization nothing ever does.
 */

export type GraderLibraryRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
};

/**
 * One entry as every read of one describes it.
 *
 * The current immutable revision's prompt rides along so a developer can read
 * the words new runs will be judged by; its parameters draw the **Use** form.
 * Older runs keep the revision they pinned. Neither field is a secret — these
 * are egma's published product behaviour.
 */
function described(entry: LibraryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    // "egma" or "organization", from tenancy. The Library screen's Owner
    // column, and the one field on this answer nothing stores.
    owner: entry.owner,
    projectId: entry.projectId,
    version: entry.version,
    prompt: entry.prompt,
    params: entry.params,
    outputDefinition: entry.outputDefinition,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export async function graderLibraryRoutes(
  app: FastifyInstance,
  options: GraderLibraryRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The shelf, newest first, one page at a time.
   *
   * `{ graderLibraryEntries, nextPageToken }` is this list's envelope
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip.
   */
  registerPlatformOperation(app, graderLibraryOperations.listGraderLibrary, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.pageToken);
    if (cursor !== undefined && !isId("grl", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the nextPageToken ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest library entry.`,
      );
    }

    const page = await listGraderLibrary(acting.auth, { cursor });

    return reply.send({
      graderLibraryEntries: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      nextPageToken: page.nextCursor ?? null,
    });
  });

  /**
   * The one refusal this group owns. Reading the library is the `read`
   * permission every role holds, so a caller reaching this is one whose
   * credential names another customer.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
