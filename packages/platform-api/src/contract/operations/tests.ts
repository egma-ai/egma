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

const testParams = parameters({ testId: stringIdSchema }, ["testId"]);
const versionParams = parameters({ versionId: stringIdSchema }, ["versionId"]);

const projectQuery = parameters({ projectId: stringIdSchema });
const testListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  archived: { type: "string" },
  agentId: stringIdSchema,
  name: { type: "string" },
});
const versionListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
});

const namedResource = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
  },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const testPersona = {
  ...namedResource,
  properties: {
    ...namedResource.properties,
    archivedAt: nullable(dateTimeSchema),
  },
  required: [...namedResource.required, "archivedAt"],
} as const;

const testAgent = testPersona;

const describedMockToolProperties = {
  tool: { type: "string" },
  delayMs: { type: "integer", minimum: 0 },
} as const;

const mockTool = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...describedMockToolProperties,
        answer: anySchema,
        error: { not: {} },
      },
      required: ["tool", "delayMs", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...describedMockToolProperties,
        answer: { not: {} },
        error: { type: "string" },
      },
      required: ["tool", "delayMs", "error"],
      additionalProperties: false,
    },
  ],
} as const;

const test = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    version: { type: "integer", minimum: 1 },
    versionId: stringIdSchema,
    scenario: { type: "string" },
    expectedBehaviors: arrayOf({ type: "string" }),
    personas: arrayOf(testPersona),
    requiredCapabilities: arrayOf({ type: "string" }),
    mockTools: arrayOf(mockTool),
    overrideCount: { type: "integer", minimum: 0 },
    agents: arrayOf(testAgent),
    revision: stringIdSchema,
    applicabilityRevision: stringIdSchema,
    archivedAt: nullable(dateTimeSchema),
    archiveReason: nullable({ type: "string" }),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "name",
    "description",
    "version",
    "versionId",
    "scenario",
    "expectedBehaviors",
    "personas",
    "requiredCapabilities",
    "mockTools",
    "overrideCount",
    "agents",
    "revision",
    "applicabilityRevision",
    "archivedAt",
    "archiveReason",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const testVersion = {
  type: "object",
  properties: {
    id: stringIdSchema,
    testId: stringIdSchema,
    testName: { type: "string" },
    version: { type: "integer", minimum: 1 },
    current: { type: "boolean" },
    scenario: { type: "string" },
    expectedBehaviors: arrayOf({ type: "string" }),
    personas: arrayOf(testPersona),
    requiredCapabilities: arrayOf({ type: "string" }),
    mockTools: arrayOf(mockTool),
    overrideCount: { type: "integer", minimum: 0 },
    createdAt: dateTimeSchema,
  },
  required: [
    "id",
    "testId",
    "testName",
    "version",
    "current",
    "scenario",
    "expectedBehaviors",
    "personas",
    "requiredCapabilities",
    "mockTools",
    "overrideCount",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const mockToolInputProperties = {
  tool: { type: "string" },
  delayMs: { type: "integer", minimum: 0 },
} as const;

const mockToolInput = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...mockToolInputProperties,
        answer: anySchema,
        error: { not: {} },
      },
      required: ["tool", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...mockToolInputProperties,
        answer: { not: {} },
        error: { type: "string" },
      },
      required: ["tool", "error"],
      additionalProperties: false,
    },
  ],
} as const;

const testContentInput = {
  scenario: { type: "string" },
  expectedBehaviors: arrayOf({ type: "string" }),
  personas: arrayOf({ type: "string" }),
  mockTools: arrayOf(mockToolInput),
  requiredCapabilities: arrayOf({ type: "string" }),
} as const;

const createTestBody = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: nullable({ type: "string" }),
    ...testContentInput,
    agents: arrayOf(stringIdSchema),
  },
  required: ["name", "scenario", "expectedBehaviors"],
  additionalProperties: false,
} as const;

const updateTestBody = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: nullable({ type: "string" }),
    ...testContentInput,
    expectedVersionId: stringIdSchema,
    expectedRevision: stringIdSchema,
    repositoryAgentId: stringIdSchema,
  },
  additionalProperties: false,
} as const;

const setTestAgentsBody = {
  type: "object",
  properties: {
    agents: arrayOf(stringIdSchema),
    expectedApplicabilityRevision: stringIdSchema,
  },
  required: ["agents"],
  additionalProperties: false,
} as const;

const archiveTestBody = {
  type: "object",
  properties: {
    expectedRevision: stringIdSchema,
  },
  additionalProperties: false,
} as const;

const restoreTestBody = {
  type: "object",
  properties: {
    ...archiveTestBody.properties,
    agents: arrayOf(stringIdSchema),
  },
  additionalProperties: false,
} as const;

const testList = {
  type: "object",
  properties: {
    tests: arrayOf(test),
    nextPageToken: nullable(stringIdSchema),
  },
  required: ["tests", "nextPageToken"],
  additionalProperties: false,
} as const;

const versionList = {
  type: "object",
  properties: {
    versions: arrayOf(testVersion),
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

const writeRefusals = {
  ...readRefusals,
  409: refusalResponse,
} as const;

const movedTestRefusal = {
  description: "The test moved after the version the edit was based on.",
  schema: {
    oneOf: [
      {
        type: "object",
        properties: {
          error: { const: "conflict" },
          message: { type: "string" },
          test: namedResource,
          expectedVersionId: stringIdSchema,
          currentVersionId: stringIdSchema,
        },
        required: [
          "error",
          "message",
          "test",
          "expectedVersionId",
          "currentVersionId",
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
    summary: "List tests",
    tag: "Tests",
    security: "credentialed",
    request: { query: testListQuery },
    responses: {
      200: { description: "A page of tests.", schema: testList },
      ...readRefusals,
    },
  }),

  getTestVersion: defineOperation({
    operationId: "getTestVersion",
    method: "GET",
    path: "/v1/test-versions/{versionId}",
    summary: "Get a test version",
    tag: "Tests",
    security: "credentialed",
    request: { params: versionParams, query: projectQuery },
    responses: {
      200: { description: "The frozen test version.", schema: testVersion },
      ...readRefusals,
    },
  }),

  getTest: defineOperation({
    operationId: "getTest",
    method: "GET",
    path: "/v1/tests/{testId}",
    summary: "Get a test",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: projectQuery },
    responses: {
      200: { description: "The test.", schema: test },
      ...readRefusals,
    },
  }),

  listTestVersions: defineOperation({
    operationId: "listTestVersions",
    method: "GET",
    path: "/v1/tests/{testId}/versions",
    summary: "List test versions",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: versionListQuery },
    responses: {
      200: { description: "A page of frozen test versions.", schema: versionList },
      ...readRefusals,
    },
  }),

  createTest: defineOperation({
    operationId: "createTest",
    method: "POST",
    path: "/v1/tests",
    summary: "Create a test",
    tag: "Tests",
    security: "credentialed",
    request: { query: projectQuery, body: createTestBody },
    responses: {
      201: { description: "The new test.", schema: test },
      ...writeRefusals,
    },
  }),

  updateTest: defineOperation({
    operationId: "updateTest",
    method: "PATCH",
    path: "/v1/tests/{testId}",
    summary: "Update a test",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: projectQuery, body: updateTestBody },
    responses: {
      200: { description: "The updated test.", schema: test },
      ...writeRefusals,
      409: movedTestRefusal,
    },
  }),

  setTestAgents: defineOperation({
    operationId: "setTestAgents",
    method: "POST",
    path: "/v1/tests/{testId}/agents",
    summary: "Set the agents a test applies to",
    tag: "Tests",
    security: "credentialed",
    request: {
      params: testParams,
      query: projectQuery,
      body: setTestAgentsBody,
    },
    responses: {
      200: { description: "The test with its new agent set.", schema: test },
      ...writeRefusals,
    },
  }),

  cloneTest: defineOperation({
    operationId: "cloneTest",
    method: "POST",
    path: "/v1/tests/{testId}/clone",
    summary: "Clone a test",
    tag: "Tests",
    security: "credentialed",
    request: {
      params: testParams,
      query: projectQuery,
    },
    responses: {
      201: { description: "The cloned test.", schema: test },
      ...writeRefusals,
    },
  }),

  archiveTest: defineOperation({
    operationId: "archiveTest",
    method: "POST",
    path: "/v1/tests/{testId}/archive",
    summary: "Archive a test",
    tag: "Tests",
    security: "credentialed",
    request: {
      params: testParams,
      query: projectQuery,
      body: archiveTestBody,
      bodyRequired: false,
    },
    responses: {
      200: { description: "The archived test.", schema: test },
      ...writeRefusals,
    },
  }),

  restoreTest: defineOperation({
    operationId: "restoreTest",
    method: "POST",
    path: "/v1/tests/{testId}/restore",
    summary: "Restore a test",
    tag: "Tests",
    security: "credentialed",
    request: {
      params: testParams,
      query: projectQuery,
      body: restoreTestBody,
      bodyRequired: false,
    },
    responses: {
      200: { description: "The restored test.", schema: test },
      ...writeRefusals,
    },
  }),
} as const;
