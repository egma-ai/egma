import {
  authorize,
  editProjectGrader,
  listProjectGraders,
  NotPermittedError,
  UnprocessableInputError,
  type ProjectGrader,
  type ProjectGraderScope,
} from "@egma/db";
import { isId } from "@egma/ids";
import { graderOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import {
  invalid,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";

/**
 * A project grader is the project's policy for one shared definition.
 *
 * The first product surface has one row: Expected behaviors. Every project is
 * created with it. Its simulation coverage is fixed by Egma, while the project
 * may change the score the grader must reach. The executable prompt and model
 * stay on the shared definition and never cross this route.
 */

export type GraderRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
};

type Body = Record<string, unknown>;

const PAGE_SIZE = 100;

function scopeForApi(scope: ProjectGraderScope): Record<string, unknown> {
  return {
    simulations: scope.simulations,
    production:
      scope.production === null
        ? null
        : { samplePercent: scope.production.sample_percent },
  };
}

function described(one: ProjectGrader): Record<string, unknown> {
  return {
    id: one.id,
    projectId: one.projectId,
    graderDefinitionId: one.graderDefinitionId,
    name: one.name,
    description: one.description,
    scopeEditable: one.scopeEditable,
    scope: scopeForApi(one.scope),
    passThreshold: one.passThreshold,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

function noSuchGrader(graderId: string): string {
  return `There is no active project grader ${graderId} available here.`;
}

function pageAfter(
  all: readonly ProjectGrader[],
  cursor: string | undefined,
): { readonly items: readonly ProjectGrader[]; readonly next: string | null } {
  let start = 0;
  if (cursor !== undefined) {
    const index = all.findIndex((one) => one.id === cursor);
    if (index < 0) {
      throw new UnprocessableInputError(
        "pageToken is not a cursor from this project grader list",
      );
    }
    start = index + 1;
  }
  const items = all.slice(start, start + PAGE_SIZE);
  const hasMore = start + items.length < all.length;
  return {
    items,
    next: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

export async function graderRoutes(
  app: FastifyInstance,
  options: GraderRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  registerPlatformOperation(
    app,
    graderOperations.listGraders,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);

      const cursor = given(query.pageToken);
      if (cursor !== undefined && !isId("grd", cursor)) {
        return invalid(
          reply,
          "pageToken must be the nextPageToken from an earlier project grader page",
        );
      }

      const page = pageAfter(await listProjectGraders(acting.auth), cursor);
      return reply.send({
        graders: page.items.map(described),
        nextPageToken: page.next,
      });
    },
  );

  registerPlatformOperation(
    app,
    graderOperations.updateGrader,
    async (request, reply) => {
      const auth = requesterOf(request).auth;
      const { graderId } = request.params as { readonly graderId: string };
      const body = (request.body ?? {}) as Body;
      const query = (request.query ?? {}) as Query;

      // Refuse the role before reading the edit. A viewer must get the same
      // permission answer for every body shape.
      authorize(auth, "author_definitions", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      });

      const unknown = Object.keys(body).find((key) => key !== "passThreshold");
      if (unknown !== undefined) {
        return invalid(
          reply,
          `a project grader update has no key "${unknown}"; only passThreshold can be changed`,
        );
      }
      if (typeof body.passThreshold !== "number") {
        return invalid(reply, "passThreshold must be a number from 0 through 1");
      }

      const acting = await actingIn(
        auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);

      const changed = await editProjectGrader(acting.auth, graderId, {
        passThreshold: body.passThreshold,
      });
      return changed === undefined
        ? notFound(reply, noSuchGrader(graderId))
        : reply.send(described(changed));
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
