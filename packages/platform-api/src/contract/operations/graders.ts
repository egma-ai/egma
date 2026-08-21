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

const judgeModel = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
  },
  required: ["provider", "model"],
  additionalProperties: false,
} as const;

const grader = {
  type: "object",
  properties: {
    id: stringIdSchema,
    libraryId: stringIdSchema,
    projectId: stringIdSchema,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    type: { type: "string" },
    required: { type: "boolean" },
    scope: { type: "string" },
    productionSampleRate: { type: "number" },
    version: { type: "integer", minimum: 1 },
    versionId: stringIdSchema,
    config: anySchema,
    judgeModel: nullable(judgeModel),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "libraryId",
    "projectId",
    "name",
    "description",
    "type",
    "required",
    "scope",
    "productionSampleRate",
    "version",
    "versionId",
    "config",
    "judgeModel",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const graderBodyProperties = {
  params: { type: "object", additionalProperties: true },
  name: { type: "string" },
  description: nullable({ type: "string" }),
  required: { type: "boolean" },
  scope: { type: "string" },
  productionSampleRate: { type: "number" },
  judgeModel: nullable(judgeModel),
} as const;

const graderParams = parameters({ graderId: stringIdSchema }, ["graderId"]);
const projectQuery = parameters({ projectId: stringIdSchema });

export const graderOperations = {
  listGraders: defineOperation({
    operationId: "listGraders",
    method: "GET",
    path: "/v1/graders",
    summary: "List running graders",
    tag: "Graders",
    security: "credentialed",
    request: {
      query: parameters({
        projectId: stringIdSchema,
        pageToken: stringIdSchema,
      }),
    },
    responses: {
      200: {
        description: "Running graders, newest first.",
        schema: {
          type: "object",
          properties: {
            graders: arrayOf(grader),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["graders", "nextPageToken"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  createGrader: defineOperation({
    operationId: "createGrader",
    method: "POST",
    path: "/v1/graders",
    summary: "Use a grader library entry",
    tag: "Graders",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          libraryId: stringIdSchema,
          ...graderBodyProperties,
        },
        required: ["libraryId"],
        additionalProperties: false,
      },
    },
    responses: {
      201: { description: "The new running grader.", schema: grader },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateGrader: defineOperation({
    operationId: "updateGrader",
    method: "PATCH",
    path: "/v1/graders/{graderId}",
    summary: "Update a running grader",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: graderParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: graderBodyProperties,
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated grader.", schema: grader },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  deleteGrader: defineOperation({
    operationId: "deleteGrader",
    method: "DELETE",
    path: "/v1/graders/{graderId}",
    summary: "Switch off a grader",
    tag: "Graders",
    security: "credentialed",
    request: { params: graderParams, query: projectQuery },
    responses: {
      200: {
        description: "The grader that was switched off.",
        schema: {
          type: "object",
          properties: {
            id: stringIdSchema,
            name: { type: "string" },
            deletedAt: dateTimeSchema,
          },
          required: ["id", "name", "deletedAt"],
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
