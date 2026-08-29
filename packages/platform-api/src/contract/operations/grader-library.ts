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
  graderLibraryEntrySchema,
  projectGraderPolicyInputProperties,
  projectGraderSchema,
} from "./grader-shapes.ts";

const stringSchema = { type: "string" } as const;
const projectQuery = parameters({ projectId: stringIdSchema });
const definitionReadQuery = parameters({
  projectId: stringIdSchema,
  definitionVersion: { type: "integer", minimum: 1 },
});
const definitionParams = parameters(
  { graderDefinitionId: stringIdSchema },
  ["graderDefinitionId"],
);

const commonReadRefusals = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  404: refusalResponse,
  422: refusalResponse,
  429: rateLimitResponse,
} as const;

const commonWriteRefusals = {
  ...commonReadRefusals,
  409: refusalResponse,
} as const;

export const graderLibraryOperations = {
  listGraderLibrary: defineOperation({
    operationId: "listGraderLibrary",
    method: "GET",
    path: "/v1/grader-library",
    summary: "List the grader library for a project",
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
        description:
          "Grader definitions visible to the organization, with current-project use state.",
        schema: {
          type: "object",
          properties: {
            graderLibraryEntries: arrayOf(graderLibraryEntrySchema),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["graderLibraryEntries", "nextPageToken"],
          additionalProperties: false,
        },
      },
      ...commonReadRefusals,
    },
  }),

  getGraderLibraryEntry: defineOperation({
    operationId: "getGraderLibraryEntry",
    method: "GET",
    path: "/v1/grader-library/{graderDefinitionId}",
    summary: "Get one grader library entry",
    tag: "Graders",
    security: "credentialed",
    request: { params: definitionParams, query: definitionReadQuery },
    responses: {
      200: {
        description: "The grader definition and its current-project use state.",
        schema: graderLibraryEntrySchema,
      },
      ...commonReadRefusals,
    },
  }),

  useGraderInProject: defineOperation({
    operationId: "useGraderInProject",
    method: "POST",
    path: "/v1/grader-library/{graderDefinitionId}/use",
    summary: "Use a grader in the current project",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: definitionParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: projectGraderPolicyInputProperties,
        required: ["scope", "settings", "passThreshold"],
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      201: {
        description: "The new current-project grader policy.",
        schema: projectGraderSchema,
      },
      ...commonWriteRefusals,
    },
  }),

  createCustomGrader: defineOperation({
    operationId: "createCustomGrader",
    method: "POST",
    path: "/v1/grader-library/custom",
    summary: "Create and use a custom LLM grader",
    description:
      "Creates one organization-owned LLM judge and its current-project policy. " +
      "The judge is binary, so the body draws its boundary in three parts: what " +
      "to decide, what answers met, and what answers not_met. The server " +
      "compiles them into the definition version's one immutable prompt and " +
      "fixes its type, model, compatible modalities, and empty settings contract.",
    tag: "Graders",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: stringSchema,
          description: nullable(stringSchema),
          gradingInstructions: stringSchema,
          passesWhen: stringSchema,
          failsWhen: stringSchema,
          scope: projectGraderPolicyInputProperties.scope,
          passThreshold: projectGraderPolicyInputProperties.passThreshold,
        },
        required: [
          "name",
          "gradingInstructions",
          "passesWhen",
          "failsWhen",
          "scope",
          "passThreshold",
        ],
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      201: {
        description: "The custom definition and its current-project policy.",
        schema: {
          type: "object",
          properties: {
            definition: graderLibraryEntrySchema,
            grader: projectGraderSchema,
          },
          required: ["definition", "grader"],
          additionalProperties: false,
        },
      },
      ...commonWriteRefusals,
    },
  }),
} as const;
