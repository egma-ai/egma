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

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const numberSchema = { type: "number" } as const;
const booleanSchema = { type: "boolean" } as const;
const pageSizeSchema = { type: "integer", minimum: 1, maximum: 200 } as const;

export const verdictSchema = {
  type: "string",
  enum: ["passed", "failed", "skipped", "errored"],
} as const;

const runStatusSchema = {
  type: "string",
  enum: ["pending", "running", "completed", "canceled"],
} as const;

export const simulationStatusSchema = {
  type: "string",
  enum: ["queued", "claimed", "running", "completed", "failed", "canceled"],
} as const;

const gradingStandingSchema = {
  type: "string",
  enum: ["not_required", "waiting", "pending", "graded"],
} as const;

const modalitySchema = {
  type: "string",
  enum: ["voice", "chat"],
} as const;

const endingReasonSchema = {
  type: "string",
  enum: [
    "persona_concluded",
    "agent_ended",
    "limit_reached",
    "agent_never_joined",
    "not_answered",
    "capacity",
    "simulator_error",
    "orphaned",
    "dispatch_failed",
  ],
} as const;

export const verdictCountsSchema = {
  type: "object",
  properties: {
    passed: integerSchema,
    failed: integerSchema,
    skipped: integerSchema,
    errored: integerSchema,
    total: integerSchema,
  },
  required: ["passed", "failed", "skipped", "errored", "total"],
  additionalProperties: false,
} as const;

export const outcomeSchema = {
  type: "object",
  properties: {
    verdict: verdictSchema,
    score: nullable(numberSchema),
    counts: verdictCountsSchema,
  },
  required: ["verdict", "score", "counts"],
  additionalProperties: false,
} as const;

export const recordedVerdictSchema = {
  type: "object",
  properties: {
    graderId: stringIdSchema,
    assertion: stringSchema,
    assertionText: nullable(stringSchema),
    required: booleanSchema,
    verdict: verdictSchema,
    score: numberSchema,
    rationale: stringSchema,
    citedTurns: arrayOf(stringSchema),
    judgedAt: dateTimeSchema,
  },
  required: [
    "graderId",
    "assertion",
    "assertionText",
    "required",
    "verdict",
    "score",
    "rationale",
    "citedTurns",
    "judgedAt",
  ],
  additionalProperties: false,
} as const;

const mockToolProperties = {
  tool: stringSchema,
  answer: {},
  error: stringSchema,
  delayMs: integerSchema,
} as const;

export const mockToolSchema = {
  type: "object",
  properties: mockToolProperties,
  required: ["tool", "delayMs"],
  oneOf: [
    { type: "object", required: ["answer"] },
    { type: "object", required: ["error"] },
  ],
  additionalProperties: false,
} as const;

export const mockToolCoverageSchema = {
  type: "object",
  properties: {
    discovered: arrayOf(stringSchema),
    covered: arrayOf(stringSchema),
    uncovered: arrayOf(stringSchema),
  },
  required: ["discovered", "covered", "uncovered"],
  additionalProperties: false,
} as const;

const simulationCountsSchema = {
  type: "object",
  properties: {
    queued: integerSchema,
    claimed: integerSchema,
    running: integerSchema,
    completed: integerSchema,
    failed: integerSchema,
    canceled: integerSchema,
  },
  required: ["queued", "claimed", "running", "completed", "failed", "canceled"],
  additionalProperties: false,
} as const;

const connectionSnapshotSchema = {
  type: "object",
  properties: {
    agentPlatform: nullable(stringSchema),
    connectionType: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
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
} as const;

const identitySchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: stringSchema,
    archived: booleanSchema,
  },
  required: ["id", "name", "archived"],
  additionalProperties: false,
} as const;

const runHeaderSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    suiteId: stringIdSchema,
    suiteName: stringSchema,
    suiteDeleted: booleanSchema,
    name: nullable(stringSchema),
    status: runStatusSchema,
    agentId: stringIdSchema,
    connectionId: stringIdSchema,
    agentPlatform: nullable(stringSchema),
    connectionType: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
    productLabel: stringSchema,
    environment: nullable(stringSchema),
    expectedSimulationCount: integerSchema,
    completedCount: nullable(integerSchema),
    failedCount: nullable(integerSchema),
    canceledCount: nullable(integerSchema),
    simulationCounts: simulationCountsSchema,
    finishedCount: integerSchema,
    gradableCount: integerSchema,
    gradedCount: integerSchema,
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    verdictCounts: verdictCountsSchema,
    resultsUrl: stringSchema,
    createdAt: dateTimeSchema,
    startedAt: nullable(dateTimeSchema),
    finishedAt: nullable(dateTimeSchema),
  },
  required: [
    "id",
    "projectId",
    "suiteId",
    "suiteName",
    "suiteDeleted",
    "name",
    "status",
    "agentId",
    "connectionId",
    "agentPlatform",
    "connectionType",
    "accessVariant",
    "modality",
    "productLabel",
    "environment",
    "expectedSimulationCount",
    "completedCount",
    "failedCount",
    "canceledCount",
    "simulationCounts",
    "finishedCount",
    "gradableCount",
    "gradedCount",
    "verdict",
    "score",
    "verdictCounts",
    "resultsUrl",
    "createdAt",
    "startedAt",
    "finishedAt",
  ],
  additionalProperties: false,
} as const;

const runDetailSchema = {
  ...runHeaderSchema,
  properties: {
    ...runHeaderSchema.properties,
    counts: verdictCountsSchema,
    connectionSnapshot: connectionSnapshotSchema,
    agent: nullable(identitySchema),
    connection: nullable({
      ...identitySchema,
      properties: {
        ...identitySchema.properties,
        productLabel: stringSchema,
      },
      required: [...identitySchema.required, "productLabel"],
    }),
  },
  required: [
    ...runHeaderSchema.required,
    "counts",
    "connectionSnapshot",
    "agent",
    "connection",
  ],
} as const;

const runSimulationSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    position: integerSchema,
    testId: stringIdSchema,
    testName: stringSchema,
    testVersionId: stringIdSchema,
    personaId: stringIdSchema,
    personaName: stringSchema,
    personaVersionId: stringIdSchema,
    status: simulationStatusSchema,
    grading: gradingStandingSchema,
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    counts: nullable(verdictCountsSchema),
    reason: nullable(endingReasonSchema),
    modality: modalitySchema,
    hasRecording: booleanSchema,
    mockToolCoverage: nullable(mockToolCoverageSchema),
  },
  required: [
    "id",
    "position",
    "testId",
    "testName",
    "testVersionId",
    "personaId",
    "personaName",
    "personaVersionId",
    "status",
    "grading",
    "verdict",
    "score",
    "counts",
    "reason",
    "modality",
    "hasRecording",
    "mockToolCoverage",
  ],
  additionalProperties: false,
} as const;

const runEventSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        seq: integerSchema,
        at: dateTimeSchema,
        kind: { type: "string", enum: ["run"] },
        status: runStatusSchema,
      },
      required: ["seq", "at", "kind", "status"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        seq: integerSchema,
        at: dateTimeSchema,
        kind: { type: "string", enum: ["simulation"] },
        simulationId: stringIdSchema,
        testName: nullable(stringSchema),
        personaName: nullable(stringSchema),
        status: simulationStatusSchema,
        verdict: nullable(verdictSchema),
        reason: nullable(endingReasonSchema),
      },
      required: [
        "seq",
        "at",
        "kind",
        "simulationId",
        "testName",
        "personaName",
        "status",
        "verdict",
        "reason",
      ],
      additionalProperties: false,
    },
  ],
} as const;

const expectedTestVersionSchema = {
  type: "object",
  properties: {
    testId: stringIdSchema,
    versionId: stringIdSchema,
  },
  required: ["testId", "versionId"],
  additionalProperties: false,
} as const;

const projectQuery = parameters({ projectId: stringIdSchema });
const runParams = parameters({ runId: stringIdSchema }, ["runId"]);
const pageQuery = {
  pageSize: pageSizeSchema,
  pageToken: stringIdSchema,
} as const;

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

export const runOperations = {
  createRun: defineOperation({
    operationId: "createRun",
    method: "POST",
    path: "/v1/runs",
    summary: "Run one complete test suite",
    tag: "Runs",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          suiteId: stringIdSchema,
          agentId: stringIdSchema,
          connectionId: stringIdSchema,
          idempotencyKey: stringSchema,
          name: stringSchema,
          expectedTestVersions: arrayOf(expectedTestVersionSchema),
        },
        required: ["suiteId", "agentId", "connectionId", "idempotencyKey"],
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      201: { description: "The bounded header for the new run.", schema: runHeaderSchema },
      ...commonWriteRefusals,
    },
  }),

  listRuns: defineOperation({
    operationId: "listRuns",
    method: "GET",
    path: "/v1/runs",
    summary: "List runs",
    tag: "Runs",
    security: "credentialed",
    request: {
      query: parameters({
        projectId: stringIdSchema,
        suiteId: stringIdSchema,
        agentId: stringIdSchema,
        connectionId: stringIdSchema,
        testId: stringIdSchema,
        status: runStatusSchema,
        verdict: verdictSchema,
        since: dateTimeSchema,
        until: dateTimeSchema,
        ...pageQuery,
      }),
    },
    responses: {
      200: {
        description: "A bounded page of run headers.",
        schema: {
          type: "object",
          properties: {
            runs: arrayOf(runHeaderSchema),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["runs", "nextPageToken"],
          additionalProperties: false,
        },
      },
      ...commonReadRefusals,
    },
  }),

  getRun: defineOperation({
    operationId: "getRun",
    method: "GET",
    path: "/v1/runs/{runId}",
    summary: "Get a run",
    tag: "Runs",
    security: "credentialed",
    request: { params: runParams, query: projectQuery },
    responses: {
      200: { description: "The bounded run header and target context.", schema: runDetailSchema },
      ...commonReadRefusals,
    },
  }),

  listRunSimulations: defineOperation({
    operationId: "listRunSimulations",
    method: "GET",
    path: "/v1/runs/{runId}/simulations",
    summary: "List simulations in a run",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: runParams,
      query: parameters({ projectId: stringIdSchema, ...pageQuery }),
    },
    responses: {
      200: {
        description: "A bounded page of simulations.",
        schema: {
          type: "object",
          properties: {
            simulations: arrayOf(runSimulationSchema),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["simulations", "nextPageToken"],
          additionalProperties: false,
        },
      },
      ...commonReadRefusals,
    },
  }),

  listRunEvents: defineOperation({
    operationId: "listRunEvents",
    method: "GET",
    path: "/v1/runs/{runId}/events",
    summary: "List run events",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: runParams,
      query: parameters({ projectId: stringIdSchema, after: integerSchema }),
    },
    responses: {
      200: {
        description: "The run events after the requested sequence.",
        schema: {
          type: "object",
          properties: {
            events: arrayOf(runEventSchema),
            next: integerSchema,
            done: booleanSchema,
          },
          required: ["events", "next", "done"],
          additionalProperties: false,
        },
      },
      ...commonReadRefusals,
    },
  }),

  cancelRun: defineOperation({
    operationId: "cancelRun",
    method: "POST",
    path: "/v1/runs/{runId}/cancel",
    summary: "Cancel a run",
    tag: "Runs",
    security: "credentialed",
    request: { params: runParams, query: projectQuery },
    responses: {
      200: { description: "The bounded header for the canceled run.", schema: runHeaderSchema },
      ...commonWriteRefusals,
    },
  }),
} as const;
