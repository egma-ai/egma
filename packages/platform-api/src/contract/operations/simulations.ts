import { defineOperation } from "../definition.ts";
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
  mockToolCoverageSchema,
  mockToolSchema,
  outcomeSchema,
  recordedVerdictSchema,
  simulationStatusSchema,
  verdictCountsSchema,
  verdictSchema,
} from "./runs.ts";

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const numberSchema = { type: "number" } as const;
const booleanSchema = { type: "boolean" } as const;

const traceSpanReference = { $ref: "#/$defs/traceSpan" } as const;
const traceSpanSchema = {
  type: "object",
  properties: {
    spanId: stringSchema,
    parentSpanId: stringSchema,
    name: stringSchema,
    kind: stringSchema,
    status: stringSchema,
    startedAt: dateTimeSchema,
    durationNs: stringSchema,
    text: stringSchema,
    audioUrl: stringSchema,
    toolName: stringSchema,
    toolArguments: stringSchema,
    toolResult: stringSchema,
    spans: arrayOf(traceSpanReference),
  },
  required: [
    "spanId",
    "parentSpanId",
    "name",
    "kind",
    "status",
    "startedAt",
    "durationNs",
    "text",
    "audioUrl",
    "toolName",
    "toolArguments",
    "toolResult",
    "spans",
  ],
  additionalProperties: false,
} as const;

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
    kind: { type: "string", enum: ["authored"] },
    graderId: stringIdSchema,
    graderVersionId: stringIdSchema,
    name: stringSchema,
    libraryId: stringIdSchema,
    required: booleanSchema,
    scope: {
      type: "string",
      enum: ["simulations", "production", "both"],
    },
  },
  required: [
    "kind",
    "graderId",
    "graderVersionId",
    "name",
    "libraryId",
    "required",
    "scope",
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

const mockToolDefaultSchema = {
  type: "object",
  properties: {
    ...mockToolSchema.properties,
    mockToolId: stringIdSchema,
  },
  required: [...mockToolSchema.required, "mockToolId"],
  oneOf: [
    { type: "object", required: ["answer"] },
    { type: "object", required: ["error"] },
  ],
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
    grading: {
      type: "string",
      enum: ["not_required", "waiting", "pending", "graded"],
    },
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    counts: nullable(verdictCountsSchema),
    reason: nullable(stringSchema),
    modality: { type: "string", enum: ["voice", "chat"] },
    createdAt: dateTimeSchema,
    startedAt: nullable(dateTimeSchema),
    endedAt: nullable(dateTimeSchema),
    providerReference: nullable(stringSchema),
    hasRecording: booleanSchema,
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
    persona: {
      type: "object",
      properties: {
        id: stringIdSchema,
        name: nullable(stringSchema),
        versionId: stringIdSchema,
        traits: nullable({
          type: "object",
          properties: {
            personality: stringSchema,
            language: stringSchema,
            manner: stringSchema,
            patience: stringSchema,
            accent: stringSchema,
            backgroundNoise: stringSchema,
            underFriction: stringSchema,
          },
          required: ["personality", "language"],
          additionalProperties: false,
        }),
      },
      required: ["id", "name", "versionId", "traits"],
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
    mockToolCoverage: nullable(mockToolCoverageSchema),
    mockTools: {
      type: "object",
      properties: {
        defaults: arrayOf(mockToolDefaultSchema),
        overrides: arrayOf(mockToolSchema),
      },
      required: ["defaults", "overrides"],
      additionalProperties: false,
    },
    gradingPlan: nullable(gradingPlanSchema),
    gradingJobs: arrayOf({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "claimed", "graded", "abandoned"],
        },
        regradeGraderId: nullable(stringIdSchema),
        attempts: integerSchema,
        lastError: nullable(stringSchema),
        finishedAt: nullable(dateTimeSchema),
      },
      required: [
        "status",
        "regradeGraderId",
        "attempts",
        "lastError",
        "finishedAt",
      ],
      additionalProperties: false,
    }),
    verdicts: arrayOf(recordedVerdictSchema),
    outcome: nullable(outcomeSchema),
    diagnostics: nullable(outcomeSchema),
    byGrader: arrayOf({
      type: "object",
      properties: {
        graderId: stringIdSchema,
        required: booleanSchema,
        verdict: verdictSchema,
        score: nullable(numberSchema),
        counts: verdictCountsSchema,
      },
      required: ["graderId", "required", "verdict", "score", "counts"],
      additionalProperties: false,
    }),
    transcript: nullable(transcriptSchema),
  },
  required: [
    "id",
    "projectId",
    "runId",
    "runName",
    "position",
    "status",
    "grading",
    "verdict",
    "score",
    "counts",
    "reason",
    "modality",
    "createdAt",
    "startedAt",
    "endedAt",
    "providerReference",
    "hasRecording",
    "measures",
    "metrics",
    "test",
    "persona",
    "agent",
    "connection",
    "connectionSnapshot",
    "mockToolCoverage",
    "mockTools",
    "gradingPlan",
    "gradingJobs",
    "verdicts",
    "outcome",
    "diagnostics",
    "byGrader",
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
      body: {
        type: "object",
        properties: {
          graderId: stringIdSchema,
        },
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "The grading work that was requested.",
        schema: {
          type: "object",
          properties: {
            simulationId: stringIdSchema,
            graderId: nullable(stringIdSchema),
            reopened: integerSchema,
            alreadyWaiting: integerSchema,
          },
          required: [
            "simulationId",
            "graderId",
            "reopened",
            "alreadyWaiting",
          ],
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
