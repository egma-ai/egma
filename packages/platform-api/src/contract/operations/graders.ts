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
  projectGraderPolicyInputProperties,
  projectGraderSchema,
} from "./grader-shapes.ts";

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
        description: "Project graders, ordered by name.",
        schema: {
          type: "object",
          properties: {
            graders: arrayOf(projectGraderSchema),
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
    summary: "Update a project grader's policy",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: graderParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: projectGraderPolicyInputProperties,
        minProperties: 1,
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The updated project grader.",
        schema: projectGraderSchema,
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  removeGrader: defineOperation({
    operationId: "removeGrader",
    method: "DELETE",
    path: "/v1/graders/{graderId}",
    summary: "Remove an optional grader from a project",
    tag: "Graders",
    security: "credentialed",
    request: { params: graderParams, query: projectQuery },
    responses: {
      204: { description: "The optional project grader was removed." },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
