import { defineOperation } from "../definition.ts";
import {
  arrayOf,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";
import {
  testEnvSchema,
  testMockToolSchema,
  testSchema,
} from "./tests.ts";

const stringSchema = { type: "string" } as const;
const projectQuery = parameters({ projectId: stringIdSchema });

const repositorySuiteSchema = {
  type: "object",
  properties: { id: stringIdSchema, name: stringSchema },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const repositoryTestSchema = {
  type: "object",
  properties: {
    clientRef: stringSchema,
    suiteId: stringIdSchema,
    name: stringSchema,
    description: stringSchema,
    scenario: stringSchema,
    expectedBehaviors: arrayOf(stringSchema),
    personas: arrayOf(stringSchema),
    mockTools: arrayOf(testMockToolSchema),
    env: nullable(testEnvSchema),
    expectedVersionId: stringIdSchema,
    expectedRevision: stringIdSchema,
  },
  required: [
    "clientRef", "suiteId", "name", "description", "scenario",
    "expectedBehaviors", "personas", "mockTools", "env",
  ],
  additionalProperties: false,
} as const;

const changeSetBody = {
  type: "object",
  properties: {
    suites: arrayOf(repositorySuiteSchema),
    tests: arrayOf(repositoryTestSchema),
  },
  required: ["suites", "tests"],
  additionalProperties: false,
} as const;

export const repositoryOperations = {
  applyRepositoryChangeSet: defineOperation({
    operationId: "applyRepositoryChangeSet",
    method: "POST",
    path: "/v1/repository/change-set",
    summary: "Apply the complete authored state from a repository",
    description:
      "The complete authored suites and tests are applied atomically. Each test carries its own mock tools and env. Missing resources refuse rather than delete.",
    tag: "Repository",
    security: "credentialed",
    request: { query: projectQuery, body: changeSetBody },
    responses: {
      200: {
        description: "The tests after the change set was applied.",
        schema: {
          type: "object",
          properties: {
            tests: arrayOf({
              type: "object",
              properties: { clientRef: stringSchema, test: testSchema },
              required: ["clientRef", "test"],
              additionalProperties: false,
            }),
          },
          required: ["tests"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
