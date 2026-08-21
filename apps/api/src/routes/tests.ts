import {
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  IdentityConflictError,
  listTests,
  listTestVersions,
  MAXIMUM_LIST_LIMIT,
  NotPermittedError,
  PersonaNameAmbiguousError,
  ProjectOutsideOrganizationError,
  resolvePersonaNames,
  TestMovedOnError,
  UnprocessableInputError,
  type AuthContext,
  type MockOverrideInput,
  type Test,
  type TestVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import { testOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { answerAsSent, describedMockTool } from "../http/mock-tools.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import {
  notFound,
  notPermitted,
  REFUSALS,
  sendRefusal,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";

export type TestRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;
type Query = {
  readonly projectId?: string;
  readonly suiteId?: string;
  readonly pageToken?: string;
  readonly pageSize?: string | number;
};

const CREATE_KEYS = [
  "suiteId", "name", "description", "scenario", "expectedBehaviors",
  "personas", "mockTools",
] as const;
const EDIT_KEYS = [
  "name", "description", "scenario", "expectedBehaviors", "personas",
  "mockTools", "expectedVersionId", "expectedRevision",
] as const;

function unknownKey(body: Body, allowed: readonly string[]): string | undefined {
  const found = Object.keys(body).find((key) => !allowed.includes(key));
  return found === undefined ? undefined : `a test has no key "${found}"`;
}

function unknownQuery(query: Query, allowed: readonly string[]): string | undefined {
  const found = Object.keys(query).find((key) => !allowed.includes(key));
  return found === undefined ? undefined : `the test query has no key "${found}"`;
}

function describedPersona(one: Test["personas"][number]): Record<string, unknown> {
  return {
    id: one.id,
    name: one.name,
    archivedAt: one.archivedAt?.toISOString() ?? null,
  };
}

export function describedTest(one: Test): Record<string, unknown> {
  return {
    id: one.id,
    projectId: one.projectId,
    suiteId: one.suiteId,
    name: one.name,
    description: one.description,
    version: one.version,
    versionId: one.versionId,
    scenario: one.scenario,
    expectedBehaviors: [...one.expectedBehaviors],
    personas: one.personas.map(describedPersona),
    mockTools: one.mockOverrides.map(describedMockTool),
    overrideCount: one.mockOverrides.length,
    revision: one.revision,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

function describedVersion(one: TestVersion): Record<string, unknown> {
  return {
    id: one.id,
    testId: one.testId,
    suiteId: one.suiteId,
    testName: one.testName,
    version: one.version,
    current: one.current,
    scenario: one.scenario,
    expectedBehaviors: [...one.expectedBehaviors],
    personas: one.personas.map(describedPersona),
    mockTools: one.mockOverrides.map(describedMockTool),
    overrideCount: one.mockOverrides.length,
    createdAt: one.createdAt.toISOString(),
  };
}

function strings(value: unknown, field: string): readonly string[] | string {
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string")) {
    return `${field} must be a list of text values`;
  }
  return value as string[];
}

function mockOverrides(value: unknown): readonly MockOverrideInput[] | string {
  if (!Array.isArray(value)) return "mockTools must be a list";
  const entries: MockOverrideInput[] = [];
  for (const valueEntry of value) {
    if (typeof valueEntry !== "object" || valueEntry === null || Array.isArray(valueEntry)) {
      return "each mockTools entry must be an object";
    }
    const entry = valueEntry as Body;
    if ("delayMs" in entry && typeof entry.delayMs !== "number") {
      return "delayMs must be a number of milliseconds";
    }
    entries.push({
      toolName: entry.tool,
      answer: answerAsSent(entry),
      ...(typeof entry.delayMs === "number"
        ? { delayMilliseconds: entry.delayMs }
        : {}),
    });
  }
  return entries;
}

async function personaIds(
  auth: AuthContext,
  body: Body,
): Promise<readonly string[] | string | undefined> {
  if (!("personas" in body)) return undefined;
  const named = strings(body.personas, "personas");
  return typeof named === "string" ? named : resolvePersonaNames(auth, named);
}

function page(
  query: Query,
  prefix: "tst" | "tstv",
): { limit?: number; cursor?: string } | string {
  const cursor = given(query.pageToken);
  if (cursor !== undefined && !isId(prefix, cursor)) {
    return `pageToken must be one ${prefix}_ identifier`;
  }
  if (query.pageSize === undefined) return cursor === undefined ? {} : { cursor };
  const limit = Number(query.pageSize);
  if (!Number.isInteger(limit)) return "pageSize must be a whole number";
  if (limit < 1 || limit > MAXIMUM_LIST_LIMIT) {
    return `pageSize must be between 1 and ${MAXIMUM_LIST_LIMIT}`;
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function noSuchTest(reply: FastifyReply, testId: string) {
  return notFound(reply, REFUSALS.notFound("test", testId));
}

async function acting(auth: AuthContext, query: Query) {
  return actingIn(auth, given(query.projectId));
}

export async function testRoutes(
  app: FastifyInstance,
  options: TestRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(app, testOperations.listTests, async (request, reply) => {
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownQuery(query, ["projectId", "suiteId", "pageToken", "pageSize"]);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const suiteId = given(query.suiteId);
    if (suiteId === undefined || !isId("ste", suiteId)) {
      return unprocessable(reply, "suiteId must be one ste_ test suite identifier");
    }
    const wanted = page(query, "tst");
    if (typeof wanted === "string") return unprocessable(reply, wanted);
    const found = await listTests(reached.auth, suiteId, wanted);
    if (found === undefined) {
      return notFound(reply, REFUSALS.notFound("test suite", suiteId));
    }
    return reply.send({
      tests: found.items.map(describedTest),
      nextPageToken: found.nextCursor ?? null,
    });
  });

  registerPlatformOperation(app, testOperations.createTest, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Query;
    const unexpectedQuery = unknownQuery(query, ["projectId"]);
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(body, CREATE_KEYS);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const suiteId = text(body.suiteId);
    if (!isId("ste", suiteId)) {
      return unprocessable(reply, "suiteId must be one ste_ test suite identifier");
    }
    const people = await personaIds(reached.auth, body);
    if (typeof people === "string") return unprocessable(reply, people);
    const behaviors = strings(body.expectedBehaviors, "expectedBehaviors");
    if (typeof behaviors === "string") return unprocessable(reply, behaviors);
    const overrides = "mockTools" in body ? mockOverrides(body.mockTools) : undefined;
    if (typeof overrides === "string") return unprocessable(reply, overrides);
    const created = await createTest(reached.auth, {
      suiteId,
      name: text(body.name),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      scenario: text(body.scenario),
      expectedBehaviors: behaviors,
      ...(people === undefined ? {} : { personaIds: people }),
      ...(overrides === undefined ? {} : { mockOverrides: overrides }),
    });
    return reply.code(201).send(describedTest(created));
  });

  registerPlatformOperation(app, testOperations.getTest, async (request, reply) => {
    const { testId } = request.params as { testId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownQuery(query, ["projectId"]);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const found = await getTest(reached.auth, testId);
    return found === undefined ? noSuchTest(reply, testId) : reply.send(describedTest(found));
  });

  registerPlatformOperation(app, testOperations.updateTest, async (request, reply) => {
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Query;
    const unexpectedQuery = unknownQuery(query, ["projectId"]);
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(body, EDIT_KEYS);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const people = await personaIds(reached.auth, body);
    if (typeof people === "string") return unprocessable(reply, people);
    const behaviors = "expectedBehaviors" in body
      ? strings(body.expectedBehaviors, "expectedBehaviors")
      : undefined;
    if (typeof behaviors === "string") return unprocessable(reply, behaviors);
    const overrides = "mockTools" in body ? mockOverrides(body.mockTools) : undefined;
    if (typeof overrides === "string") return unprocessable(reply, overrides);
    const changesContent = ["scenario", "expectedBehaviors", "personas", "mockTools"]
      .some((key) => key in body);
    if (
      "expectedVersionId" in body &&
      (typeof body.expectedVersionId !== "string" || !isId("tstv", body.expectedVersionId))
    ) {
      return unprocessable(reply, "expectedVersionId must be one tstv_ test-version identifier");
    }
    if (
      "expectedRevision" in body &&
      (typeof body.expectedRevision !== "string" || !isId("rev", body.expectedRevision))
    ) {
      return unprocessable(reply, "expectedRevision must be one rev_ revision identifier");
    }
    if (changesContent && !("expectedVersionId" in body)) {
      return unprocessable(reply, "a test content edit needs expectedVersionId from the version it read");
    }
    const edited = await editTest(reached.auth, testId, {
      ...(body.name !== undefined ? { name: text(body.name) } : {}),
      ...(body.description !== undefined
        ? { description: body.description === null ? null : text(body.description) }
        : {}),
      ...(body.scenario !== undefined ? { scenario: text(body.scenario) } : {}),
      ...(behaviors === undefined ? {} : { expectedBehaviors: behaviors }),
      ...(people === undefined ? {} : { personaIds: people }),
      ...(overrides === undefined ? {} : { mockOverrides: overrides }),
      ...(typeof body.expectedVersionId === "string"
        ? { expectedVersionId: body.expectedVersionId }
        : {}),
      ...(typeof body.expectedRevision === "string"
        ? { expectedRevision: body.expectedRevision }
        : {}),
    });
    return edited === undefined ? noSuchTest(reply, testId) : reply.send(describedTest(edited));
  });

  registerPlatformOperation(app, testOperations.deleteTest, async (request, reply) => {
    const { testId } = request.params as { testId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownQuery(query, ["projectId"]);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const deleted = await deleteTest(reached.auth, testId);
    return deleted ? reply.code(204).send() : noSuchTest(reply, testId);
  });

  registerPlatformOperation(app, testOperations.listTestVersions, async (request, reply) => {
    const { testId } = request.params as { testId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownQuery(query, ["projectId", "pageToken", "pageSize"]);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const wanted = page(query, "tstv");
    if (typeof wanted === "string") return unprocessable(reply, wanted);
    const found = await listTestVersions(reached.auth, testId, wanted);
    if (found === undefined) return noSuchTest(reply, testId);
    return reply.send({
      versions: found.items.map(describedVersion),
      nextPageToken: found.nextCursor ?? null,
    });
  });

  registerPlatformOperation(app, testOperations.getTestVersion, async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownQuery(query, ["projectId"]);
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const reached = await acting(requesterOf(request).auth, query);
    if ("refusal" in reached) return refuseActing(reply, reached);
    const found = await getTestVersion(reached.auth, versionId);
    return found === undefined
      ? notFound(reply, REFUSALS.notFound("test version", versionId))
      : reply.send(describedVersion(found));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof TestMovedOnError) {
      return reply.code(409).send({
        error: "version_conflict",
        message: error.message,
        test: { id: error.testId, name: error.testName },
        expectedVersionId: error.expectedVersionId,
        currentVersionId: error.currentVersionId,
      });
    }
    if (error instanceof IdentityConflictError) {
      return sendRefusal(reply, "identity_conflict", REFUSALS.identityConflict("Test", error.resourceId));
    }
    if (error instanceof PersonaNameAmbiguousError) {
      return sendRefusal(reply, "persona_name_ambiguous", REFUSALS.personaNameAmbiguous(error.personaName));
    }
    if (error instanceof UnprocessableInputError) return unprocessable(reply, error.message);
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }
    if (error instanceof NotPermittedError) return notPermitted(reply, error.message);
    throw error;
  });
}
