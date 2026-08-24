import {
  archiveProjectGrader,
  authorize,
  editProjectGrader,
  listProjectGraders,
  NotPermittedError,
  PREDEFINED_GRADERS,
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

/** One project's active policy rows over shared grader definitions. */

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeForDb(value: unknown): unknown {
  if (!isObject(value)) return value;
  const production = value.production;
  if (!isObject(production)) return value;
  const { samplePercent, ...unknown } = production;
  return {
    ...value,
    production: { ...unknown, sample_percent: samplePercent },
  };
}

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
    owner: one.owner,
    type: one.type,
    modalities: one.modalities,
    scopeEditable: one.scopeEditable,
    removable: one.graderDefinitionId !== PREDEFINED_GRADERS.expectedBehaviors,
    scope: scopeForApi(one.scope),
    settings: one.parameterValues,
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
  credentialed(app, options);

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
      const { graderId } = request.params as { readonly graderId: string };
      const body = (request.body ?? {}) as Body;
      const query = (request.query ?? {}) as Query;
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      authorize(acting.auth, "author_definitions", {
        organizationId: acting.auth.organizationId,
        projectId: acting.auth.projectId,
      });

      const allowed = ["scope", "settings", "passThreshold"];
      const unknown = Object.keys(body).find((key) => !allowed.includes(key));
      if (unknown !== undefined) {
        return invalid(
          reply,
          `a project grader update has no key "${unknown}"; change scope, settings, or passThreshold`,
        );
      }
      if (Object.keys(body).length === 0) {
        return invalid(
          reply,
          "a project grader update must change scope, settings, or passThreshold",
        );
      }
      if (
        "passThreshold" in body &&
        typeof body.passThreshold !== "number"
      ) {
        return invalid(reply, "passThreshold must be a number from 0 through 1");
      }

      const changed = await editProjectGrader(acting.auth, graderId, {
        ...(body.scope === undefined ? {} : { scope: scopeForDb(body.scope) }),
        ...(body.settings === undefined
          ? {}
          : { parameterValues: body.settings }),
        ...(body.passThreshold === undefined
          ? {}
          : { passThreshold: body.passThreshold as number }),
      });
      return changed === undefined
        ? notFound(reply, noSuchGrader(graderId))
        : reply.send(described(changed));
    },
  );

  registerPlatformOperation(
    app,
    graderOperations.removeGrader,
    async (request, reply) => {
      const { graderId } = request.params as { readonly graderId: string };
      const query = (request.query ?? {}) as Query;
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      authorize(acting.auth, "author_definitions", {
        organizationId: acting.auth.organizationId,
        projectId: acting.auth.projectId,
      });
      const removed = await archiveProjectGrader(acting.auth, graderId);
      return removed
        ? reply.code(204).send()
        : notFound(reply, noSuchGrader(graderId));
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
