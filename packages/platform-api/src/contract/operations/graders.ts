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

const allSimulationSelector = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["all"] },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const identifiedSimulationSelector = (kind: "test_suite" | "test") =>
  ({
    type: "object",
    properties: {
      kind: { type: "string", enum: [kind] },
      id: stringIdSchema,
    },
    required: ["kind", "id"],
    additionalProperties: false,
  }) as const;

const scope = {
  type: "object",
  properties: {
    simulations: arrayOf({
      oneOf: [
        allSimulationSelector,
        identifiedSimulationSelector("test_suite"),
        identifiedSimulationSelector("test"),
      ],
    }),
    production: nullable({
      type: "object",
      properties: {
        samplePercent: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["samplePercent"],
      additionalProperties: false,
    }),
  },
  required: ["simulations", "production"],
  additionalProperties: false,
} as const;

const grader = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    graderDefinitionId: stringIdSchema,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    scopeEditable: { type: "boolean" },
    scope,
    passThreshold: { type: "number", minimum: 0, maximum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "graderDefinitionId",
    "name",
    "description",
    "scopeEditable",
    "scope",
    "passThreshold",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const graderParams = parameters({ graderId: stringIdSchema }, ["graderId"]);
const projectQuery = parameters({ projectId: stringIdSchema });

export const graderOperations = {
  listGraders: defineOperation({
    operationId: "listGraders",
    method: "GET",
    path: "/v1/graders",
    summary: "List project graders",
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
        description: "Project graders, newest first.",
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

  updateGrader: defineOperation({
    operationId: "updateGrader",
    method: "PATCH",
    path: "/v1/graders/{graderId}",
    summary: "Update a project grader's pass threshold",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: graderParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          passThreshold: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["passThreshold"],
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated project grader.", schema: grader },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
