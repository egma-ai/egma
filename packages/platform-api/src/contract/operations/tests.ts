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
const deleteTestQuery = parameters(
  {
    projectId: stringIdSchema,
    expectedVersionId: stringIdSchema,
    expectedRevision: stringIdSchema,
  },
  ["expectedVersionId", "expectedRevision"],
);
const testListQuery = parameters(
  {
    projectId: stringIdSchema,
    suiteId: {
      ...stringIdSchema,
      description: "The test suite to read. Tests are listed one suite at a time.",
    },
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
  description:
    "One named tool's fixed response for this test. Supply exactly one of answer or error. Tools without a mock run normally.",
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
      description:
        "String values supplied to the Retell agent before the conversation. Variable names beginning with egma_ are reserved.",
      additionalProperties: stringSchema,
    },
    job_dispatch_metadata: {
      type: "object",
      description: "Context delivered to the LiveKit worker in ctx.job.metadata.",
      additionalProperties: true,
    },
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
  scenario: {
    ...stringSchema,
    description: "The situation and goal the synthetic caller acts out.",
  },
  expectedBehaviors: {
    ...arrayOf(stringSchema),
    description:
      "Statements checked independently against the completed conversation. Include at least one non-empty statement.",
  },
  personas: {
    ...arrayOf(stringSchema),
    description:
      "At least one available persona ID or unambiguous current name. Each selected persona creates one simulation for this test in a run.",
  },
  mockTools: {
    ...arrayOf(testMockToolSchema),
    description:
      "Test-owned tool answers. Use an empty array to remove existing mocks on update. Applying mocks requires a supported connection and, for LiveKit, tool instrumentation.",
  },
  env: {
    ...nullable(testEnvSchema),
    description:
      "Non-secret startup context for the agent's provider. Omit to keep existing context on update, or send null to clear it.",
  },
} as const;

const createTestBody = {
  type: "object",
  properties: {
    suiteId: {
      ...stringIdSchema,
      description: "An existing active test suite in the current project.",
    },
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
  examples: [{
    suiteId: "ste_01M0E4EVJ6ECGVJEA4NSBTC0CC",
    name: "No available appointments",
    description: "The caller asks for an appointment when the calendar is full.",
    scenario:
      "Ask Harbor Clinic for an afternoon appointment. If none is available, ask how to arrange a callback.",
    expectedBehaviors: [
      "The agent checks availability before offering an appointment.",
      "The agent does not invent an available time when the tool returns no slots.",
    ],
    personas: ["Everyday caller"],
    mockTools: [{ tool: "check_availability", answer: { slots: [] } }],
    env: { retell_dynamic_variables: { clinic_name: "Harbor Clinic" } },
  }],
} as const;

const updateTestBody = {
  type: "object",
  properties: {
    name: stringSchema,
    description: nullable(stringSchema),
    ...testContentInput,
    expectedVersionId: {
      ...stringIdSchema,
      description:
        "The versionId returned by the test read. Required when changing scenario, expectedBehaviors, personas, mockTools, or env; a stale value returns 409.",
    },
    expectedRevision: {
      ...stringIdSchema,
      description:
        "The revision returned by the test read. Supply it to reject an update if the test's live identity changed since that read.",
    },
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
  description: "The test content or identity moved after the write was based on it.",
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
    description:
      "Read the frozen scenario, expected behaviors, persona selections, mocks, and context used by a simulation. Later test edits do not change this version.",
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
    description:
      "Creates the test and its first content version in an existing suite. Choose at least one persona. The agent and connection are selected when starting a run, not when creating the test.",
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
    description:
      "Omitted fields keep their current values. Content changes create an immutable version and require expectedVersionId from the last read. Name and description changes keep the content version. Existing simulations retain their original evidence.",
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
    description:
      "The test leaves authoring permanently only while expectedVersionId and expectedRevision are both still current. Existing run evidence stays readable.",
    tag: "Tests",
    security: "credentialed",
    request: { params: testParams, query: deleteTestQuery },
    responses: {
      204: { description: "The test was deleted." },
      ...writeRefusals,
      409: movedTestRefusal,
    },
  }),
} as const;
