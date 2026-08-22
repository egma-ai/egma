import {
  listGraderDefinitions,
  NotPermittedError,
  UnprocessableInputError,
  type GraderDefinition,
} from "@egma/db";
import { isId } from "@egma/ids";
import { graderLibraryOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import { invalid, notPermitted, unprocessable } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";

/**
 * The shared grader-definition library.
 *
 * This read exposes identity and ownership. Executable prompts, source code,
 * model choices, and output contracts stay inside the trusted grader service.
 */

export type GraderLibraryRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
};

const PAGE_SIZE = 100;

function described(entry: GraderDefinition): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    owner: entry.owner,
    projectId: entry.projectId,
    scopeEditable: entry.scopeEditable,
    currentDefinitionVersion: entry.currentDefinitionVersion,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

function pageAfter(
  all: readonly GraderDefinition[],
  cursor: string | undefined,
): {
  readonly items: readonly GraderDefinition[];
  readonly next: string | null;
} {
  let start = 0;
  if (cursor !== undefined) {
    const index = all.findIndex((one) => one.id === cursor);
    if (index < 0) {
      throw new UnprocessableInputError(
        "pageToken is not a cursor from this grader library",
      );
    }
    start = index + 1;
  }
  const items = all.slice(start, start + PAGE_SIZE);
  return {
    items,
    next:
      start + items.length < all.length ? (items.at(-1)?.id ?? null) : null,
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

  registerPlatformOperation(
    app,
    graderLibraryOperations.listGraderLibrary,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);

      const cursor = given(query.pageToken);
      if (cursor !== undefined && !isId("grl", cursor)) {
        return invalid(
          reply,
          "pageToken must be the nextPageToken from an earlier grader-library page",
        );
      }

      const page = pageAfter(await listGraderDefinitions(acting.auth), cursor);
      return reply.send({
        graderLibraryEntries: page.items.map(described),
        nextPageToken: page.next,
      });
    },
  );

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    throw error;
  });
}
