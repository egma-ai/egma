import { defineOperation } from "../definition.ts";
import { traceSpanReference, traceSpanSchema } from "./trace-span.ts";
import {
  arrayOf,
  dateTimeSchema,
  metricSchema,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";
import {
  gradeProjectionProperties,
  gradeProjectionRequired,
  gradingStateSchema,
  normalizedScoreSchema,
} from "./grades.ts";
import { simulationStatusSchema } from "./runs.ts";

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const booleanSchema = { type: "boolean" } as const;


const transcriptSchema = {
  type: "object",
  properties: {
    traceId: stringSchema,
    startedAt: dateTimeSchema,
    endedAt: dateTimeSchema,
    durationNs: stringSchema,
    spanCount: integerSchema,
    turnCounts: {
      type: "object",
      properties: { human: integerSchema, agent: integerSchema },
      required: ["human", "agent"],
      additionalProperties: false,
    },
    toolSpanCount: integerSchema,
    erroredSpanCount: integerSchema,
    turns: arrayOf(traceSpanReference),
    spans: arrayOf(traceSpanReference),
    spansTruncated: booleanSchema,
  },
  required: [
    "traceId",
    "startedAt",
    "endedAt",
    "durationNs",
    "spanCount",
    "turnCounts",
    "toolSpanCount",
    "erroredSpanCount",
    "turns",
    "spans",
    "spansTruncated",
  ],
  additionalProperties: false,
} as const;

const planItemSchema = {
  type: "object",
  properties: {
    projectGraderId: stringIdSchema,
    graderDefinitionId: stringIdSchema,
    graderDefinitionVersion: { type: "integer", minimum: 1 },
    graderName: stringSchema,
    passThreshold: normalizedScoreSchema,
  },
  required: [
    "projectGraderId",
    "graderDefinitionId",
    "graderDefinitionVersion",
    "graderName",
    "passThreshold",
  ],
  additionalProperties: false,
} as const;

const gradingPlanSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["run_start"] },
    capturedAt: dateTimeSchema,
    items: arrayOf(planItemSchema),
  },
  required: ["state", "capturedAt", "items"],
  additionalProperties: false,
} as const;

const simulationSchema = {
  $defs: { traceSpan: traceSpanSchema },
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    runId: stringIdSchema,
    runName: nullable(stringSchema),
    position: integerSchema,
    status: simulationStatusSchema,
    gradingState: nullable(gradingStateSchema),
    ...gradeProjectionProperties,
    reason: nullable(stringSchema),
    executionFailure: nullable(stringSchema),
    modality: { type: "string", enum: ["voice", "chat"] },
    createdAt: dateTimeSchema,
    startedAt: nullable(dateTimeSchema),
    endedAt: nullable(dateTimeSchema),
    providerReference: nullable(stringSchema),
    hasRecording: booleanSchema,
    /**
     * That this conversation was graded without the agent's own POV of it.
     *
     * A simulation stores two accounts of one conversation and grading waits
     * for the agent's — the SDK's export from inside the room, or the pull from
     * the platform — for thirty seconds and no longer (ADR-0024 §6). True says
     * the wait ran out: what is stored is egma's account, and the agent's is
     * missing or partial. **A reader that shows the agent's POV has to ask**,
     * because "the rows filed as the agent's" is a fragment here rather than
     * the conversation, and a fragment shown as the whole is worse than a gap
     * that says it is one. Regrade picks up a late arrival.
     *
     * False on every conversation whose agent POV landed, and on every lane
     * that files none — a phone number reaches nothing of egma's, so nothing
     * was ever waited for.
     */
    agentPovIncomplete: booleanSchema,
    measures: {
      type: "object",
      properties: {
        durationMs: integerSchema,
        turnCount: integerSchema,
        toolCallCount: integerSchema,
        erroredStepCount: integerSchema,
        humanTurnCount: integerSchema,
        agentTurnCount: integerSchema,
      },
      additionalProperties: false,
    },
    metrics: arrayOf(metricSchema),
    test: {
      type: "object",
      properties: {
        id: stringIdSchema,
        versionId: stringIdSchema,
        name: nullable(stringSchema),
        scenario: nullable(stringSchema),
        expectedBehaviors: nullable(arrayOf(stringSchema)),
      },
      required: [
        "id",
        "versionId",
        "name",
        "scenario",
        "expectedBehaviors",
      ],
      additionalProperties: false,
    },
    /**
     * Who called, as this simulation pinned them.
     *
     * `name` is the team's label for the library row and reads live, so a
     * rename shows here. The three beside it are the authored person off the
     * pinned version and never move — `identityName` being the name the agent
     * actually heard. Each of those is null only where the pinned version
     * could not be read at all.
     */
    persona: {
      type: "object",
      properties: {
        id: stringIdSchema,
        name: nullable(stringSchema),
        versionId: stringIdSchema,
        identityName: nullable(stringSchema),
        personality: nullable(stringSchema),
        language: nullable(stringSchema),
      },
      required: [
        "id",
        "name",
        "versionId",
        "identityName",
        "personality",
        "language",
      ],
      additionalProperties: false,
    },
    agent: {
      type: "object",
      properties: {
        id: stringIdSchema,
        name: nullable(stringSchema),
        archived: nullable(booleanSchema),
      },
      required: ["id", "name", "archived"],
      additionalProperties: false,
    },
    connection: {
      type: "object",
      properties: {
        id: stringIdSchema,
        name: nullable(stringSchema),
        archived: nullable(booleanSchema),
      },
      required: ["id", "name", "archived"],
      additionalProperties: false,
    },
    connectionSnapshot: {
      type: "object",
      properties: {
        agentPlatform: nullable(stringSchema),
        connectionType: stringSchema,
        accessVariant: stringSchema,
        modality: { type: "string", enum: ["voice", "chat"] },
        topology: stringSchema,
        environment: nullable(stringSchema),
        config: {},
      },
      required: [
        "agentPlatform",
        "connectionType",
        "accessVariant",
        "modality",
        "topology",
        "environment",
        "config",
      ],
      additionalProperties: false,
    },
    gradingPlan: nullable(gradingPlanSchema),
    transcript: nullable(transcriptSchema),
  },
  required: [
    "id",
    "projectId",
    "runId",
    "runName",
    "position",
    "status",
    "gradingState",
    ...gradeProjectionRequired,
    "reason",
    "executionFailure",
    "modality",
    "createdAt",
    "startedAt",
    "endedAt",
    "providerReference",
    "hasRecording",
    "agentPovIncomplete",
    "measures",
    "metrics",
    "test",
    "persona",
    "agent",
    "connection",
    "connectionSnapshot",
    "gradingPlan",
    "transcript",
  ],
  additionalProperties: false,
} as const;

const simulationParams = parameters({ simulationId: stringIdSchema }, [
  "simulationId",
]);
const projectQuery = parameters({ projectId: stringIdSchema });

export const simulationOperations = {
  getSimulation: defineOperation({
    operationId: "getSimulation",
    method: "GET",
    path: "/v1/simulations/{simulationId}",
    summary: "Get a simulation",
    tag: "Simulations",
    security: "credentialed",
    request: { params: simulationParams, query: projectQuery },
    responses: {
      200: {
        description: "The simulation and all of its evidence.",
        schema: simulationSchema,
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  regradeSimulation: defineOperation({
    operationId: "regradeSimulation",
    method: "POST",
    path: "/v1/simulations/{simulationId}/regrade",
    summary: "Regrade a simulation",
    tag: "Simulations",
    security: "credentialed",
    request: {
      params: simulationParams,
      query: projectQuery,
    },
    responses: {
      200: {
        description: "The grading work that was requested.",
        schema: {
          type: "object",
          properties: {
            simulationId: stringIdSchema,
            reopened: integerSchema,
            alreadyWaiting: integerSchema,
          },
          required: ["simulationId", "reopened", "alreadyWaiting"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
