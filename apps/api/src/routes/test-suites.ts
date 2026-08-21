import {
  createTestSuite,
  deleteTestSuite,
  getTestSuite,
  listTestSuites,
  MAXIMUM_LIST_LIMIT,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  renameTestSuite,
  UnprocessableInputError,
  type TestSuite,
} from "@egma/db";
import { isId } from "@egma/ids";
import { testSuiteOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import { notFound, notPermitted, REFUSALS, unprocessable } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";

export type TestSuiteRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;
type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
  readonly pageSize?: string | number;
};

function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
  noun: string,
): string | undefined {
  const key = Object.keys(value).find((one) => !allowed.includes(one));
  return key === undefined ? undefined : `${noun} has no key "${key}"`;
}

function described(one: TestSuite): Record<string, unknown> {
  return {
    id: one.id,
    projectId: one.projectId,
    name: one.name,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

function page(query: Query): { limit?: number; cursor?: string } | string {
  const cursor = given(query.pageToken);
  if (cursor !== undefined && !isId("ste", cursor)) {
    return "pageToken must be one ste_ test suite identifier";
  }
  if (query.pageSize === undefined) return cursor === undefined ? {} : { cursor };
  const limit = Number(query.pageSize);
  if (!Number.isInteger(limit)) return "pageSize must be a whole number";
  if (limit < 1 || limit > MAXIMUM_LIST_LIMIT) {
    return `pageSize must be between 1 and ${MAXIMUM_LIST_LIMIT}`;
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

export async function testSuiteRoutes(
  app: FastifyInstance,
  options: TestSuiteRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(app, testSuiteOperations.listTestSuites, async (request, reply) => {
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId", "pageToken", "pageSize"], "the test suite query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const wanted = page(query);
    if (typeof wanted === "string") return unprocessable(reply, wanted);
    const found = await listTestSuites(acting.auth, wanted);
    return reply.send({
      testSuites: found.items.map(described),
      nextPageToken: found.nextCursor ?? null,
    });
  });

  registerPlatformOperation(app, testSuiteOperations.createTestSuite, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Query;
    const unexpectedQuery = unknownKey(query, ["projectId"], "the test suite query");
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(body, ["name"], "a test suite");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const created = await createTestSuite(acting.auth, { name: text(body.name) });
    return reply.code(201).send(described(created));
  });

  registerPlatformOperation(app, testSuiteOperations.getTestSuite, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId"], "the test suite query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const found = await getTestSuite(acting.auth, suiteId);
    return found === undefined
      ? notFound(reply, REFUSALS.notFound("test suite", suiteId))
      : reply.send(described(found));
  });

  registerPlatformOperation(app, testSuiteOperations.updateTestSuite, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Query;
    const unexpectedQuery = unknownKey(query, ["projectId"], "the test suite query");
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(body, ["name"], "a test suite");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const renamed = await renameTestSuite(acting.auth, suiteId, { name: text(body.name) });
    return renamed === undefined
      ? notFound(reply, REFUSALS.notFound("test suite", suiteId))
      : reply.send(described(renamed));
  });

  registerPlatformOperation(app, testSuiteOperations.deleteTestSuite, async (request, reply) => {
    const { suiteId } = request.params as { suiteId: string };
    const query = (request.query ?? {}) as Query;
    const unexpected = unknownKey(query, ["projectId"], "the test suite query");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(requesterOf(request).auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);
    const deleted = await deleteTestSuite(acting.auth, suiteId);
    return deleted === undefined
      ? notFound(reply, REFUSALS.notFound("test suite", suiteId))
      : reply.code(204).send();
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) return unprocessable(reply, error.message);
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }
    if (error instanceof NotPermittedError) return notPermitted(reply, error.message);
    throw error;
  });
}
