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

/**
 * One tool the test answers for, and what it answers.
 *
 * Exactly one of `answer` and `error`: an entry carrying both, or neither, is
 * not a mock tool. There is no delay — a mocked answer arrives when the lane
 * can send it, and a made-up wait told nobody anything true about the agent.
 */
export const testMockToolSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        tool: stringSchema,
        answer: anySchema,
        error: { not: {} },
      },
      required: ["tool", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        tool: stringSchema,
        answer: { not: {} },
        error: stringSchema,
      },
      required: ["tool", "error"],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * The world the test is conducted in, in the two platforms' own words.
 *
 * The inner keys stay snake_case on purpose. `retell_dynamic_variables` is what
 * Retell calls the values it substitutes into an agent's prompt, and
 * `job_dispatch_metadata` is what LiveKit calls the blob it hands the job. A
 * reader who knows either platform reads this without a translation table, so
 * the wire keeps their spelling even though every structural name around it is
 * lowerCamelCase.
 *
 * A dynamic variable whose name begins `egma_` is refused: those are Egma's own
 * words to the simulator, and a test cannot overwrite them.
 */
export const testEnvSchema = {
  type: "object",
  properties: {
    retell_dynamic_variables: {
      type: "object",
      additionalProperties: stringSchema,
    },
    job_dispatch_metadata: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
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
    env: nullable(testEnvSchema),
    revision: stringIdSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id", "projectId", "suiteId", "name", "description", "version",
    "versionId", "scenario", "expectedBehaviors", "personas", "mockTools",
    "env", "revision", "createdAt", "updatedAt",
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
    env: nullable(testEnvSchema),
    createdAt: dateTimeSchema,
  },
  required: [
    "id", "testId", "suiteId", "testName", "version", "current",
    "scenario", "expectedBehaviors", "personas", "mockTools", "env",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

/**
 * Everything a test version is made of, on create and on update alike.
 *
 * `mockTools` and `env` are versioned content: changing either mints a new test
 * version, exactly as an edited expected behavior does. On an update an absent
 * field leaves the field alone and `env: null` clears it.
 */
const testContentInput = {
  scenario: stringSchema,
  expectedBehaviors: arrayOf(stringSchema),
  personas: arrayOf(stringSchema),
  mockTools: arrayOf(testMockToolSchema),
  env: nullable(testEnvSchema),
} as const;

const createTestBody = {
  type: "object",
  properties: {
    suiteId: stringIdSchema,
    name: stringSchema,
    description: nullable(stringSchema),
    ...testContentInput,
  },
  /*
   * **A test names at least one persona from birth.** `personas` joined this
   * list on 2026-08-24. The server used to substitute the project's default
   * persona for a missing or empty list, so a test could exist that nobody had
   * ever said who calls about. The substitution is a refusal now, and the
   * required list says so before a caller sends anything.
   */
  required: ["suiteId", "name", "scenario", "expectedBehaviors", "personas"],
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
