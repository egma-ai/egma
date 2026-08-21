import { defineOperation } from "../definition.ts";
import {
  anySchema,
  arrayOf,
  dateTimeSchema,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const stringSchema = { type: "string" } as const;
const pageSizeSchema = { type: "integer", minimum: 1, maximum: 200 } as const;

const testParams = parameters({ testId: stringIdSchema }, ["testId"]);
const versionParams = parameters({ versionId: stringIdSchema }, ["versionId"]);
const projectQuery = parameters({ projectId: stringIdSchema });
const testListQuery = parameters(
  {
    projectId: stringIdSchema,
    suiteId: stringIdSchema,
    pageToken: stringIdSchema,
    pageSize: pageSizeSchema,
  },
  ["suiteId"],
);
const versionListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  pageSize: pageSizeSchema,
});

const namedResourceSchema = {
  type: "object",
  properties: { id: stringIdSchema, name: stringSchema },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const testPersonaSchema = {
  ...namedResourceSchema,
  properties: {
    ...namedResourceSchema.properties,
    archivedAt: nullable(dateTimeSchema),
  },
  required: [...namedResourceSchema.required, "archivedAt"],
} as const;

const mockToolProperties = {
  tool: stringSchema,
  delayMs: { type: "integer", minimum: 0 },
} as const;

export const testMockToolSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: anySchema,
        error: { not: {} },
      },
      required: ["tool", "delayMs", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: { not: {} },
        error: stringSchema,
      },
      required: ["tool", "delayMs", "error"],
      additionalProperties: false,
    },
  ],
} as const;

export const testMockToolInputSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: anySchema,
        error: { not: {} },
      },
      required: ["tool", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: { not: {} },
        error: stringSchema,
      },
      required: ["tool", "error"],
      additionalProperties: false,
    },
  ],
} as const;

export const testSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    suiteId: stringIdSchema,
    name: stringSchema,
    description: nullable(stringSchema),
    version: { type: "integer", minimum: 1 },
    versionId: stringIdSchema,
    scenario: stringSchema,
    expectedBehaviors: arrayOf(stringSchema),
    personas: arrayOf(testPersonaSchema),
    mockTools: arrayOf(testMockToolSchema),
    overrideCount: { type: "integer", minimum: 0 },
    revision: stringIdSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id", "projectId", "suiteId", "name", "description", "version",
    "versionId", "scenario", "expectedBehaviors", "personas", "mockTools",
    "overrideCount", "revision", "createdAt", "updatedAt",
  ],
  additionalProperties: false,
} as const;

const testVersionSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    testId: stringIdSchema,
    suiteId: stringIdSchema,
    testName: stringSchema,
    version: { type: "integer", minimum: 1 },
    current: { type: "boolean" },
    scenario: stringSchema,
    expectedBehaviors: arrayOf(stringSchema),
    personas: arrayOf(testPersonaSchema),
    mockTools: arrayOf(testMockToolSchema),
    overrideCount: { type: "integer", minimum: 0 },
    createdAt: dateTimeSchema,
  },
  required: [
    "id", "testId", "suiteId", "testName", "version", "current",
    "scenario", "expectedBehaviors", "personas", "mockTools", "overrideCount",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const testContentInput = {
  scenario: stringSchema,
  expectedBehaviors: arrayOf(stringSchema),
  personas: arrayOf(stringSchema),
  mockTools: arrayOf(testMockToolInputSchema),
} as const;

const createTestBody = {
  type: "object",
  properties: {
    suiteId: stringIdSchema,
    name: stringSchema,
    description: nullable(stringSchema),
    ...testContentInput,
  },
  required: ["suiteId", "name", "scenario", "expectedBehaviors"],
  additionalProperties: false,
} as const;

const updateTestBody = {
  type: "object",
  properties: {
    name: stringSchema,
    description: nullable(stringSchema),
    ...testContentInput,
    expectedVersionId: stringIdSchema,
    expectedRevision: stringIdSchema,
  },
  additionalProperties: false,
} as const;

const testListSchema = {
  type: "object",
  properties: {
    tests: arrayOf(testSchema),
    nextPageToken: nullable(stringIdSchema),
  },
  required: ["tests", "nextPageToken"],
  additionalProperties: false,
} as const;

const versionListSchema = {
  type: "object",
  properties: {
    versions: arrayOf(testVersionSchema),
    nextPageToken: nullable(stringIdSchema),
  },
  required: ["versions", "nextPageToken"],
  additionalProperties: false,
} as const;

const readRefusals = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  404: refusalResponse,
  422: refusalResponse,
  429: rateLimitResponse,
} as const;
const writeRefusals = { ...readRefusals, 409: refusalResponse } as const;

const movedTestRefusal = {
  description: "The test moved after the version the edit was based on.",
  schema: {
    oneOf: [
      {
        type: "object",
        properties: {
          error: { const: "version_conflict" },
          message: stringSchema,
          test: namedResourceSchema,
          expectedVersionId: stringIdSchema,
          currentVersionId: stringIdSchema,
        },
        required: [
          "error", "message", "test", "expectedVersionId", "currentVersionId",
        ],
        additionalProperties: false,
      },
      refusalResponse.schema,
    ],
  },
} as const;

export const testOperations = {
  listTests: defineOperation({
    operationId: "listTests",
    method: "GET",
    path: "/v1/tests",
    summary: "List the active tests in a test suite",
    tag: "Tests",
    security: "credentialed",
    request: { query: testListQuery },
    responses: { 200: { description: "A page of tests.", schema: testListSchema }, ...readRefusals },
  }),
  getTestVersion: defineOperation({
    operationId: "getTestVersion",
    method: "GET",
    path: "/v1/test-versions/{versionId}",
    summary: "Get a test version",
    tag: "Tests",
    security: "credentialed",
    request: { params: versionParams, query: projectQuery },
    responses: { 200: { description: "The frozen test version.", schema: testVersionSchema }, ...readRefusals },
  }),
  getTest: defineOperation({
    operationId: "getTest",
    method: "GET",
    path: "/v1/tests/{testId}",
    summary: "Get a test",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: projectQuery },
    responses: { 200: { description: "The test.", schema: testSchema }, ...readRefusals },
  }),
  listTestVersions: defineOperation({
    operationId: "listTestVersions",
    method: "GET",
    path: "/v1/tests/{testId}/versions",
    summary: "List test versions",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: versionListQuery },
    responses: { 200: { description: "A page of frozen test versions.", schema: versionListSchema }, ...readRefusals },
  }),
  createTest: defineOperation({
    operationId: "createTest",
    method: "POST",
    path: "/v1/tests",
    summary: "Create a test in a test suite",
    tag: "Tests",
    security: "credentialed",
    request: { query: projectQuery, body: createTestBody },
    responses: { 201: { description: "The new test.", schema: testSchema }, ...writeRefusals },
  }),
  updateTest: defineOperation({
    operationId: "updateTest",
    method: "PATCH",
    path: "/v1/tests/{testId}",
    summary: "Update a test",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: projectQuery, body: updateTestBody },
    responses: { 200: { description: "The updated test.", schema: testSchema }, ...writeRefusals, 409: movedTestRefusal },
  }),
  deleteTest: defineOperation({
    operationId: "deleteTest",
    method: "DELETE",
    path: "/v1/tests/{testId}",
    summary: "Permanently delete a test from authoring",
    description: "The test leaves authoring permanently. Existing run evidence stays readable.",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: projectQuery },
    responses: { 204: { description: "The test was deleted." }, ...writeRefusals },
  }),
} as const;
