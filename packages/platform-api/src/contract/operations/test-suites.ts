import { defineOperation } from "../definition.ts";
import {
  arrayOf,
  dateTimeSchema,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const stringSchema = { type: "string" } as const;
const suiteParams = parameters({ suiteId: stringIdSchema }, ["suiteId"]);
const projectQuery = parameters({ projectId: stringIdSchema });
const listQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  pageSize: { type: "integer", minimum: 1, maximum: 200 },
});

const testSuiteSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    name: stringSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: ["id", "projectId", "name", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const nameBody = {
  type: "object",
  properties: { name: stringSchema },
  required: ["name"],
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

export const testSuiteOperations = {
  listTestSuites: defineOperation({
    operationId: "listTestSuites",
    method: "GET",
    path: "/v1/test-suites",
    summary: "List test suites",
    tag: "Test Suites",
    security: "credentialed",
    request: { query: listQuery },
    responses: {
      200: {
        description: "A page of active test suites.",
        schema: {
          type: "object",
          properties: {
            testSuites: arrayOf(testSuiteSchema),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["testSuites", "nextPageToken"],
          additionalProperties: false,
        },
      },
      ...readRefusals,
    },
  }),
  createTestSuite: defineOperation({
    operationId: "createTestSuite",
    method: "POST",
    path: "/v1/test-suites",
    summary: "Create a test suite",
    tag: "Test Suites",
    security: "credentialed",
    request: { query: projectQuery, body: nameBody },
    responses: { 201: { description: "The new test suite.", schema: testSuiteSchema }, ...writeRefusals },
  }),
  getTestSuite: defineOperation({
    operationId: "getTestSuite",
    method: "GET",
    path: "/v1/test-suites/{suiteId}",
    summary: "Get a test suite",
    tag: "Test Suites",
    security: "credentialed",
    request: { params: suiteParams, query: projectQuery },
    responses: { 200: { description: "The test suite.", schema: testSuiteSchema }, ...readRefusals },
  }),
  updateTestSuite: defineOperation({
    operationId: "updateTestSuite",
    method: "PATCH",
    path: "/v1/test-suites/{suiteId}",
    summary: "Rename a test suite",
    tag: "Test Suites",
    security: "credentialed",
    request: { params: suiteParams, query: projectQuery, body: nameBody },
    responses: { 200: { description: "The renamed test suite.", schema: testSuiteSchema }, ...writeRefusals },
  }),
  deleteTestSuite: defineOperation({
    operationId: "deleteTestSuite",
    method: "DELETE",
    path: "/v1/test-suites/{suiteId}",
    summary: "Permanently delete a test suite from authoring",
    description: "The suite and its tests leave authoring permanently. Existing run evidence stays readable.",
    tag: "Test Suites",
    security: "credentialed",
    request: { params: suiteParams, query: projectQuery },
    responses: { 204: { description: "The test suite was deleted." }, ...writeRefusals },
  }),
} as const;
