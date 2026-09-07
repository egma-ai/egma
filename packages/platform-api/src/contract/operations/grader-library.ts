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
  graderSettingDefinitionSchema,
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
  getGraderForm: defineOperation({
    operationId: "getGraderForm", method: "GET", path: "/v1/grader-form",
    summary: "Get supported grader models and first-use defaults", tag: "Graders", security: "credentialed",
    request: { query: projectQuery },
    responses: {
      200: { description: "Supported grader model pairs and the default LLM contract.", schema: {
        type: "object", properties: {
          modelCatalog: arrayOf({ type: "object", properties: {
            provider: stringSchema, model: stringSchema, label: stringSchema,
          }, required: ["provider", "model", "label"], additionalProperties: false }),
          settingDefinitions: arrayOf(graderSettingDefinitionSchema),
        }, required: ["modelCatalog", "settingDefinitions"], additionalProperties: false,
      } }, ...commonReadRefusals,
    },
  }),

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
          "Grader definitions visible to the project, with current-project use state.",
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
        required: ["scope", "passThreshold"],
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
      "Creates a project-owned LLM core and complete project model settings in one write. " +
      "The server compiles the three instruction fields into one immutable prompt. " +
      "Omitted settings use the current contract defaults once, at creation.",
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
          settings: projectGraderPolicyInputProperties.settings,
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

  cloneGrader: defineOperation({
    operationId: "cloneGrader", method: "POST", path: "/v1/grader-library/{graderDefinitionId}/clone",
    summary: "Clone the current LLM core into this project", tag: "Graders", security: "credentialed",
    request: {
      params: definitionParams, query: projectQuery, bodyRequired: true,
      body: { type: "object", properties: { name: stringSchema, description: nullable(stringSchema) }, required: ["name"], additionalProperties: false },
    },
    responses: {
      201: { description: "The independent custom definition and its copied project settings.", schema: {
        type: "object", properties: { definition: graderLibraryEntrySchema, grader: projectGraderSchema },
        required: ["definition", "grader"], additionalProperties: false,
      } }, ...commonWriteRefusals,
    },
  }),
  updateGraderDefinition: defineOperation({
    operationId: "updateGraderDefinition", method: "PATCH", path: "/v1/grader-library/{graderDefinitionId}",
    summary: "Edit the current custom grader core or live display metadata", tag: "Graders", security: "credentialed",
    request: {
      params: definitionParams, query: projectQuery, bodyRequired: true,
      body: {
        type: "object", properties: {
          baseDefinitionVersion: { type: "integer", minimum: 1 }, gradingInstructions: stringSchema,
          name: stringSchema, description: nullable(stringSchema),
        }, required: ["baseDefinitionVersion"], minProperties: 2, additionalProperties: false,
      },
    },
    responses: { 200: { description: "The current core. A prompt change creates the next immutable version.", schema: graderLibraryEntrySchema }, ...commonWriteRefusals },
  }),
} as const;
