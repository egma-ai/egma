import {
  authorize,
  createCustomLlmGrader,
  getGraderDefinitionVersion,
  getGraderLibraryEntry,
  listGraderLibrary,
  NotPermittedError,
  PREDEFINED_GRADERS,
  UnprocessableInputError,
  useGraderInProject,
  type GraderDefinitionSnapshot,
  type GraderLibraryEntry,
  type GraderModality,
  type ProjectGrader,
  type ProjectGraderScope,
} from "@egma/db";
import { isId } from "@egma/ids";
import { graderLibraryOperations } from "@egma/platform-api/contract";
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
import { given, text } from "../http/reading.ts";

/**
 * The organization-visible grader library and the two ways a definition enters
 * the current project.
 *
 * Egma definitions are installed from the backend catalog. No route here can
 * author one. A customer can use a visible definition, or create one custom
 * LLM definition whose type, model and output contract are fixed by the server.
 */

export type GraderLibraryRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
  readonly definitionVersion?: number;
};

type Body = Record<string, unknown>;

const PAGE_SIZE = 100;
const MODALITIES = ["chat", "voice"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(
  value: Body,
  allowed: readonly string[],
  noun: string,
): string | undefined {
  const key = Object.keys(value).find((one) => !allowed.includes(one));
  return key === undefined ? undefined : `${noun} has no key "${key}"`;
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

function requiredEvidence(
  entry: Pick<GraderLibraryEntry, "id" | "type">,
): readonly string[] {
  if (entry.id === PREDEFINED_GRADERS.expectedBehaviors) {
    return ["transcript", "test_expected_behaviors"];
  }
  if (entry.id === PREDEFINED_GRADERS.responseLatency) {
    return ["turn_response_latency"];
  }
  return entry.type === "llm_as_judge"
    ? ["transcript", "ending_outcome", "tool_calls", "observed_metrics"]
    : [];
}

function describedLibraryEntry(
  entry: GraderLibraryEntry,
  activeProjectGraderId = entry.activeProjectGraderId,
  definition?: GraderDefinitionSnapshot,
): Record<string, unknown> {
  const definitionVersion =
    definition?.definitionVersion ?? entry.definitionVersion;
  const type = definition?.type ?? entry.type;
  const prompt = definition === undefined
    ? entry.gradingInstructions
    : definition.prompt;
  const parameterContract =
    definition?.parameterContract ?? entry.parameterContract;
  const modalities = definition?.modalities ?? entry.modalities;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    owner: entry.owner,
    type,
    scopeEditable: entry.scopeEditable,
    currentDefinitionVersion: entry.currentDefinitionVersion,
    definitionVersion,
    modalities,
    // Egma-owned prompts and trusted implementation details are not an
    // authoring surface. Organization-owned instructions are the customer's.
    gradingInstructions:
      entry.owner === "organization" ? prompt : null,
    requiredEvidence: requiredEvidence({ id: entry.id, type }),
    settingDefinitions: parameterContract,
    activeProjectGraderId,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

function describedProjectGrader(one: ProjectGrader): Record<string, unknown> {
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

function pageAfter(
  all: readonly GraderLibraryEntry[],
  cursor: string | undefined,
): {
  readonly items: readonly GraderLibraryEntry[];
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

function noSuchDefinition(id: string): string {
  return `There is no grader definition ${id} available in this organization.`;
}

function modalitiesFrom(value: unknown): readonly GraderModality[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return "modalities must contain chat, voice, or both";
  }
  if (
    new Set(value).size !== value.length ||
    value.some(
      (one) =>
        typeof one !== "string" ||
        !(MODALITIES as readonly string[]).includes(one),
    )
  ) {
    return "modalities must contain chat, voice, or both, with no repeats";
  }
  return value as readonly GraderModality[];
}

export async function graderLibraryRoutes(
  app: FastifyInstance,
  options: GraderLibraryRoutesOptions,
): Promise<void> {
  credentialed(app, options);

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

      const page = pageAfter(await listGraderLibrary(acting.auth), cursor);
      return reply.send({
        graderLibraryEntries: page.items.map((entry) =>
          describedLibraryEntry(entry),
        ),
        nextPageToken: page.next,
      });
    },
  );

  registerPlatformOperation(
    app,
    graderLibraryOperations.getGraderLibraryEntry,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const { graderDefinitionId } = request.params as {
        readonly graderDefinitionId: string;
      };
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      const entry = await getGraderLibraryEntry(
        acting.auth,
        graderDefinitionId,
      );
      if (entry === undefined) {
        return notFound(reply, noSuchDefinition(graderDefinitionId));
      }
      const definition = query.definitionVersion === undefined
        ? undefined
        : await getGraderDefinitionVersion(
            acting.auth,
            graderDefinitionId,
            query.definitionVersion,
          );
      if (query.definitionVersion !== undefined && definition === undefined) {
        return notFound(
          reply,
          `There is no grader definition ${graderDefinitionId} version ${String(query.definitionVersion)} available in this organization.`,
        );
      }
      return reply.send(describedLibraryEntry(entry, undefined, definition));
    },
  );

  registerPlatformOperation(
    app,
    graderLibraryOperations.useGraderInProject,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const body = (request.body ?? {}) as Body;
      const { graderDefinitionId } = request.params as {
        readonly graderDefinitionId: string;
      };
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      authorize(acting.auth, "author_definitions", {
        organizationId: acting.auth.organizationId,
        projectId: acting.auth.projectId,
      });

      const unknown = unknownKey(
        body,
        ["scope", "settings", "passThreshold"],
        "a Use in project request",
      );
      if (unknown !== undefined) return invalid(reply, unknown);
      if (!("scope" in body) || !("settings" in body)) {
        return invalid(reply, "scope and settings are required");
      }
      if (typeof body.passThreshold !== "number") {
        return invalid(reply, "passThreshold must be a number from 0 through 1");
      }

      const used = await useGraderInProject(acting.auth, graderDefinitionId, {
        scope: scopeForDb(body.scope),
        parameterValues: body.settings,
        passThreshold: body.passThreshold,
      });
      return used === undefined
        ? notFound(reply, noSuchDefinition(graderDefinitionId))
        : reply.code(201).send(describedProjectGrader(used));
    },
  );

  registerPlatformOperation(
    app,
    graderLibraryOperations.createCustomGrader,
    async (request, reply) => {
      const query = (request.query ?? {}) as Query;
      const body = (request.body ?? {}) as Body;
      const acting = await actingIn(
        requesterOf(request).auth,
        given(query.projectId),
      );
      if ("refusal" in acting) return refuseActing(reply, acting);
      authorize(acting.auth, "author_definitions", {
        organizationId: acting.auth.organizationId,
        projectId: acting.auth.projectId,
      });

      const unknown = unknownKey(
        body,
        [
          "name",
          "description",
          "gradingInstructions",
          "modalities",
          "scope",
          "passThreshold",
        ],
        "a custom grader",
      );
      if (unknown !== undefined) return invalid(reply, unknown);
      const name = given(text(body.name));
      if (name === undefined) return invalid(reply, "name is required");
      if (
        body.description !== undefined &&
        body.description !== null &&
        typeof body.description !== "string"
      ) {
        return invalid(reply, "description must be text or null");
      }
      const gradingInstructions = given(text(body.gradingInstructions));
      if (gradingInstructions === undefined) {
        return invalid(reply, "gradingInstructions is required");
      }
      const modalities = modalitiesFrom(body.modalities);
      if (typeof modalities === "string") return invalid(reply, modalities);
      if (!("scope" in body)) return invalid(reply, "scope is required");
      if (typeof body.passThreshold !== "number") {
        return invalid(reply, "passThreshold must be a number from 0 through 1");
      }

      const created = await createCustomLlmGrader(acting.auth, {
        name,
        description:
          body.description === null ? null : given(text(body.description)) ?? null,
        gradingInstructions,
        modalities,
        scope: scopeForDb(body.scope),
        passThreshold: body.passThreshold,
      });
      return reply.code(201).send({
        definition: describedLibraryEntry(
          created.definition,
          created.projectGrader.id,
        ),
        grader: describedProjectGrader(created.projectGrader),
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
