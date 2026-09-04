import {
  applyRepositoryChangeSet,
  IdentityConflictError,
  NotPermittedError,
  PersonaNameAmbiguousError,
  ProjectOutsideOrganizationError,
  resolvePersonaNames,
  TestMovedOnError,
  UnprocessableInputError,
  type AuthContext,
  type RepositoryChangeSet,
} from "@egma/db";
import { isId } from "@egma/ids";
import { repositoryOperations } from "@egma/platform-api/contract";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import {
  notPermitted,
  REFUSALS,
  sendRefusal,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { describedTest, envIn, mockToolsIn } from "./tests.ts";

export type RepositoryRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;

function object(value: unknown, noun: string): Body | string {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Body
    : `${noun} must be an object`;
}

function objects(value: unknown, noun: string): readonly Body[] | string {
  if (!Array.isArray(value)) return `${noun} must be a list`;
  const entries: Body[] = [];
  for (const entry of value) {
    const found = object(entry, `each ${noun} entry`);
    if (typeof found === "string") return found;
    entries.push(found);
  }
  return entries;
}

function strings(value: unknown, field: string): readonly string[] | string {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return `${field} must be a list of text values`;
  }
  return value as readonly string[];
}

function unknownKey(
  value: Body,
  allowed: readonly string[],
  noun: string,
): string | undefined {
  const key = Object.keys(value).find((one) => !allowed.includes(one));
  return key === undefined ? undefined : `${noun} has no key "${key}"`;
}

async function repositoryTests(
  auth: AuthContext,
  value: unknown,
): Promise<RepositoryChangeSet["tests"] | string> {
  const entries = objects(value, "tests");
  if (typeof entries === "string") return entries;
  const found: RepositoryChangeSet["tests"][number][] = [];
  for (const entry of entries) {
    const unexpected = unknownKey(
      entry,
      [
        "clientRef", "suiteId", "name", "description", "scenario",
        "expectedBehaviors", "personas", "mockTools", "env",
        "expectedVersionId", "expectedRevision",
      ],
      "a repository test",
    );
    if (unexpected !== undefined) return unexpected;
    if (typeof entry.clientRef !== "string" || entry.clientRef.trim() === "") {
      return "clientRef must name one repository file";
    }
    if (typeof entry.suiteId !== "string" || !isId("ste", entry.suiteId)) {
      return "suiteId must be one ste_ test suite identifier";
    }
    if (typeof entry.name !== "string") return "name must be text";
    if (typeof entry.description !== "string") return "description must be text";
    if (typeof entry.scenario !== "string") return "scenario must be text";
    const behaviors = strings(entry.expectedBehaviors, "expectedBehaviors");
    if (typeof behaviors === "string") return behaviors;
    const people = strings(entry.personas, "personas");
    if (typeof people === "string") return people;
    const personaIds = await resolvePersonaNames(auth, people);
    const mockTools = mockToolsIn(entry.mockTools);
    if (typeof mockTools === "string") return mockTools;
    const env = envIn(entry.env);
    if (typeof env === "string") return env;
    if (
      "expectedVersionId" in entry &&
      typeof entry.expectedVersionId !== "string"
    ) {
      return "expectedVersionId must be text";
    }
    if (
      "expectedRevision" in entry &&
      typeof entry.expectedRevision !== "string"
    ) {
      return "expectedRevision must be text";
    }
    const hasVersionPin = typeof entry.expectedVersionId === "string";
    const hasRevisionPin = typeof entry.expectedRevision === "string";
    if (hasVersionPin !== hasRevisionPin) {
      return "an existing repository test needs both expectedVersionId and expectedRevision; a new test needs neither";
    }
    if (hasRevisionPin && !isId("rev", entry.expectedRevision as string)) {
      return "expectedRevision must be one rev_ revision identifier";
    }
    found.push({
      clientRef: entry.clientRef,
      suiteId: entry.suiteId,
      name: entry.name,
      description: entry.description,
      scenario: entry.scenario,
      expectedBehaviors: behaviors,
      personaIds,
      mockTools,
      env,
      ...(typeof entry.expectedVersionId === "string"
        ? { expectedVersionId: entry.expectedVersionId }
        : {}),
      ...(typeof entry.expectedRevision === "string"
        ? { expectedRevision: entry.expectedRevision }
        : {}),
    });
  }
  return found;
}

export async function repositoryRoutes(
  app: FastifyInstance,
  options: RepositoryRoutesOptions,
): Promise<void> {
  credentialed(app, options);

  registerPlatformOperation(app, repositoryOperations.applyRepositoryChangeSet, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;
    const unexpectedQuery = unknownKey(query, ["projectId"], "the repository query");
    if (unexpectedQuery !== undefined) return unprocessable(reply, unexpectedQuery);
    const unexpected = unknownKey(body, ["suites", "tests"], "a repository change set");
    if (unexpected !== undefined) return unprocessable(reply, unexpected);
    const acting = await actingIn(
      requesterOf(request).auth,
      given(text(query.projectId)),
    );
    if ("refusal" in acting) return refuseActing(reply, acting);

    const suites = objects(body.suites, "suites");
    if (typeof suites === "string") return unprocessable(reply, suites);
    const preparedSuites: RepositoryChangeSet["suites"][number][] = [];
    for (const suite of suites) {
      const extra = unknownKey(suite, ["id", "name"], "a repository suite");
      if (extra !== undefined) return unprocessable(reply, extra);
      if (typeof suite.id !== "string" || !isId("ste", suite.id)) {
        return unprocessable(reply, "a repository suite id must be one ste_ identifier");
      }
      if (typeof suite.name !== "string") {
        return unprocessable(reply, "a repository suite name must be text");
      }
      preparedSuites.push({ id: suite.id, name: suite.name });
    }

    const tests = await repositoryTests(acting.auth, body.tests);
    if (typeof tests === "string") return unprocessable(reply, tests);

    const applied = await applyRepositoryChangeSet(acting.auth, {
      suites: preparedSuites,
      tests,
    });
    return reply.send({
      tests: applied.tests.map((entry) => ({
        clientRef: entry.clientRef,
        test: describedTest(entry.test),
      })),
    });
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
