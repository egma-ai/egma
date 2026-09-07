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
    description:
      "Returns active project policies, including scope, settings, and individual pass thresholds. Use /v1/grader-library to find definitions that are not yet active in this project.",
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
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateGrader: defineOperation({
    operationId: "updateGrader",
    method: "PATCH",
    path: "/v1/graders/{graderId}",
    summary: "Update a project grader's policy",
    description:
      "Change model settings, scope, or threshold for future work. Existing simulation plans keep their selected definitions and settings, including when regraded. Expected behaviors has fixed scope; its model and threshold are editable.",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: graderParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          scope: {
            ...projectGraderPolicyInputProperties.scope,
            description:
              "Simulation selectors and an optional production sample. Only graders with scopeEditable set to true accept scope changes.",
          },
          settings: {
            ...projectGraderPolicyInputProperties.settings,
            description:
              "Complete values for the definition's settingDefinitions. LLM graders use llm_provider and llm_model. Response latency uses maximum_response_time_ms, a positive integer in milliseconds. These settings belong to this project and do not create a definition version.",
          },
          passThreshold: {
            ...projectGraderPolicyInputProperties.passThreshold,
            description:
              "This grader passes when its score is at least this value. There is no overall run pass threshold.",
          },
        },
        minProperties: 1,
        additionalProperties: false,
        examples: [{ passThreshold: 1 }],
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
    description:
      "Stops selecting this grader for future project work. Existing grades and frozen simulation plans remain readable. Expected behaviors cannot be removed.",
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
