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
    summary: "Get grader model choices", tag: "Graders", security: "credentialed",
    description: "Read supported provider/model pairs and default settings before creating or configuring an LLM grader.",
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
    description:
      "Includes Egma's built-in graders and custom graders owned by this project. activeProjectGraderId identifies a definition already in use by this project; null means it can be added.",
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
    description:
      "Read the current definition or request an exact definitionVersion from historical grade evidence. Setting definitions describe the values needed when adding the grader to a project.",
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
    description:
      "Adds an available definition with this project's scope, settings, and pass threshold. These settings apply to future work; adding a grader does not change earlier simulation plans. A definition can be active only once per project. The example settings are for Response latency.",
    tag: "Graders",
    security: "credentialed",
    request: {
      params: definitionParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          scope: {
            ...projectGraderPolicyInputProperties.scope,
            description:
              "Select all simulations, particular test suites or tests, and/or a production sample from 1 through 100 percent. production: null disables production grading.",
          },
          settings: {
            ...projectGraderPolicyInputProperties.settings,
            description:
              "Complete values for the definition's settingDefinitions. Omit settings to save the declared defaults on first use. LLM graders use llm_provider and llm_model; Response latency uses maximum_response_time_ms.",
          },
          passThreshold: {
            ...projectGraderPolicyInputProperties.passThreshold,
            description: "The minimum score for this grader's individual result to pass.",
          },
        },
        required: ["scope", "passThreshold"],
        additionalProperties: false,
        examples: [{
          scope: { simulations: [{ kind: "all" }], production: null },
          settings: { maximum_response_time_ms: 3000 },
          passThreshold: 1,
        }],
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
      "Create a custom LLM grader owned by this project. Set its instructions, model, scope, and pass threshold. Omit settings to save the declared model defaults at creation.",
    tag: "Graders",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: stringSchema,
          description: nullable(stringSchema),
          gradingInstructions: {
            ...stringSchema,
            description: "One rule to decide and the conversation evidence to inspect.",
          },
          passesWhen: {
            ...stringSchema,
            description:
              "The evidence that makes the rule pass. Include how to handle a conversation where the checked action never occurs.",
          },
          failsWhen: {
            ...stringSchema,
            description: "The evidence that makes the rule fail.",
          },
          settings: {
            ...projectGraderPolicyInputProperties.settings,
            description: "A complete llm_provider and llm_model pair from Get grader model choices. Omit settings to use the declared defaults.",
          },
          scope: {
            ...projectGraderPolicyInputProperties.scope,
            description:
              "The future simulations and/or production sample this project should grade.",
          },
          passThreshold: {
            ...projectGraderPolicyInputProperties.passThreshold,
            description: "The minimum score for this grader's individual result to pass.",
          },
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
        examples: [{
          name: "Appointment recap",
          gradingInstructions:
            "Decide whether the agent repeats the chosen appointment date and time and asks the caller to confirm them. Use the transcript.",
          passesWhen:
            "The agent repeats the chosen date and time and asks for confirmation. If no appointment is chosen, the rule is met.",
          failsWhen:
            "An appointment is chosen and the agent ends the conversation without repeating both its date and time and asking for confirmation.",
          scope: { simulations: [{ kind: "all" }], production: null },
          passThreshold: 1,
        }],
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
    summary: "Clone a grader", tag: "Graders", security: "credentialed",
    description: "Copy the current LLM definition and this project's effective settings into an independent custom grader. Historical versions and code graders cannot be cloned. The clone receives no source updates.",
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
    summary: "Update grader instructions", tag: "Graders", security: "credentialed",
    description: "Edit the current custom definition's prompt or display labels. Send its definitionVersion as baseDefinitionVersion. A changed prompt creates a version; label edits do not. Egma-owned definitions are read-only.",
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
