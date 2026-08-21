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

const mockToolAgent = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
  },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const mockToolProperties = {
  id: stringIdSchema,
  tool: { type: "string" },
  delayMs: { type: "integer", minimum: 0 },
  agents: arrayOf(mockToolAgent),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
} as const;

const mockToolRequired = [
  "id",
  "tool",
  "delayMs",
  "agents",
  "createdAt",
  "updatedAt",
] as const;

const mockTool = {
  oneOf: [
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: anySchema,
        error: { not: {} },
      },
      required: [...mockToolRequired, "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...mockToolProperties,
        answer: { not: {} },
        error: { type: "string" },
      },
      required: [...mockToolRequired, "error"],
      additionalProperties: false,
    },
  ],
} as const;

const mockToolBodyProperties = {
  tool: { type: "string" },
  delayMs: { type: "integer", minimum: 0 },
  agents: arrayOf({ type: "string" }),
  projectId: stringIdSchema,
} as const;

const listQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
});

const mockToolParams = parameters(
  { mockToolId: stringIdSchema },
  ["mockToolId"],
);

export const mockToolOperations = {
  listMockTools: defineOperation({
    operationId: "listMockTools",
    method: "GET",
    path: "/v1/mock-tools",
    summary: "List mock tools",
    tag: "Mock tools",
    security: "credentialed",
    request: { query: listQuery },
    responses: {
      200: {
        description: "Mock tools, newest first.",
        schema: {
          type: "object",
          properties: {
            mockTools: arrayOf(mockTool),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["mockTools", "nextPageToken"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  createMockTool: defineOperation({
    operationId: "createMockTool",
    method: "POST",
    path: "/v1/mock-tools",
    summary: "Create a mock tool",
    tag: "Mock tools",
    security: "credentialed",
    request: {
      body: {
        oneOf: [
          {
            type: "object",
            properties: {
              ...mockToolBodyProperties,
              answer: anySchema,
              error: { not: {} },
            },
            required: ["tool", "answer"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              ...mockToolBodyProperties,
              answer: { not: {} },
              error: { type: "string" },
            },
            required: ["tool", "error"],
            additionalProperties: false,
          },
        ],
      },
      bodyRequired: true,
    },
    responses: {
      201: { description: "The new mock tool.", schema: mockTool },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateMockTool: defineOperation({
    operationId: "updateMockTool",
    method: "PATCH",
    path: "/v1/mock-tools/{mockToolId}",
    summary: "Update a mock tool",
    tag: "Mock tools",
    security: "credentialed",
    request: {
      params: mockToolParams,
      body: {
        oneOf: [
          {
            type: "object",
            properties: {
              ...mockToolBodyProperties,
              answer: anySchema,
              error: { not: {} },
            },
            required: ["answer"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              ...mockToolBodyProperties,
              answer: { not: {} },
              error: { type: "string" },
            },
            required: ["error"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              ...mockToolBodyProperties,
              answer: { not: {} },
              error: { not: {} },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    responses: {
      200: { description: "The updated mock tool.", schema: mockTool },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  deleteMockTool: defineOperation({
    operationId: "deleteMockTool",
    method: "DELETE",
    path: "/v1/mock-tools/{mockToolId}",
    summary: "Delete a mock tool",
    tag: "Mock tools",
    security: "credentialed",
    request: {
      params: mockToolParams,
      query: parameters({ projectId: stringIdSchema }),
    },
    responses: {
      200: {
        description: "The deleted mock tool.",
        schema: {
          type: "object",
          properties: {
            id: stringIdSchema,
            tool: { type: "string" },
            deletedAt: dateTimeSchema,
          },
          required: ["id", "tool", "deletedAt"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
