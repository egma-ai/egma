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
    description:
      "Includes Egma's built-in graders and custom graders from your organization. activeProjectGraderId identifies a definition already in use by this project; null means it can be added.",
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
              "Values required by the definition's settingDefinitions. Use an empty object for a grader with no settings.",
          },
          passThreshold: {
            ...projectGraderPolicyInputProperties.passThreshold,
            description: "The minimum score for this grader's individual result to pass.",
          },
        },
        required: ["scope", "settings", "passThreshold"],
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
      "Create a custom LLM grader in your organization’s library and activate it in this project. Write the grading instructions and pass/fail criteria; Egma supplies the model.",
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
          scope: {
            ...projectGraderPolicyInputProperties.scope,
            description:
              "The future simulations and/or production sample this project should grade.",
          },
          passThreshold: {
            ...projectGraderPolicyInputProperties.passThreshold,
            description: "Use 1 to require this binary check to pass.",
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
          name: "Booking confirmation",
          gradingInstructions:
            "Decide whether the agent makes only supported claims about completed bookings. Use the transcript and booking tool results.",
          passesWhen:
            "Every booking claim follows a successful booking tool result. If the agent makes no booking claim, the rule is met.",
          failsWhen:
            "The agent claims a booking before the tool succeeds, after it fails, or without a booking tool result.",
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
} as const;
