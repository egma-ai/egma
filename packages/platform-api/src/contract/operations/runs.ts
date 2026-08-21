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
  enum: [
    "queued",
    "claimed",
    "running",
    "completed",
    "failed",
    "canceled",
    "skipped",
  ],
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

const skipReasonSchema = {
  type: "string",
  enum: [
    "required_capability_unsupported",
    "required_capability_unknown",
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

const mockToolDefaultSchema = {
  type: "object",
  properties: { ...mockToolProperties, mockToolId: stringIdSchema },
  required: ["tool", "delayMs", "mockToolId"],
  oneOf: [
    { type: "object", required: ["answer"] },
    { type: "object", required: ["error"] },
  ],
  additionalProperties: false,
} as const;

const mockToolSnapshotSchema = {
  type: "object",
  properties: {
    defaults: arrayOf(mockToolDefaultSchema),
    overrides: {
      type: "object",
      additionalProperties: arrayOf(mockToolSchema),
    },
  },
  required: ["defaults", "overrides"],
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

const unknownCapabilitiesSchema = {
  type: "object",
  properties: { state: { type: "string", enum: ["unknown"] } },
  required: ["state"],
  additionalProperties: false,
} as const;

const knownCapabilitiesSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["known"] },
    measured: arrayOf(stringSchema),
    supported: arrayOf(stringSchema),
    checkedAt: dateTimeSchema,
    source: stringSchema,
  },
  required: ["state", "measured", "supported", "checkedAt", "source"],
  additionalProperties: false,
} as const;

const runPlanSchema = {
  type: "object",
  properties: {
    agentId: stringIdSchema,
    connectionId: stringIdSchema,
    connection: {
      type: "object",
      properties: {
        agentPlatform: nullable(stringSchema),
        connectionKind: stringSchema,
        accessVariant: stringSchema,
        modality: modalitySchema,
        productLabel: stringSchema,
        environment: nullable(stringSchema),
        capabilities: {
          oneOf: [unknownCapabilitiesSchema, knownCapabilitiesSchema],
        },
      },
      required: [
        "agentPlatform",
        "connectionKind",
        "accessVariant",
        "modality",
        "productLabel",
        "environment",
        "capabilities",
      ],
      additionalProperties: false,
    },
    runnableSimulationCount: integerSchema,
    skippedSimulationCount: integerSchema,
    tests: arrayOf({
      type: "object",
      properties: {
        testId: stringIdSchema,
        testVersionId: stringIdSchema,
        testName: stringSchema,
        personas: arrayOf({
          type: "object",
          properties: {
            personaId: stringIdSchema,
            personaVersionId: stringIdSchema,
            name: stringSchema,
          },
          required: ["personaId", "personaVersionId", "name"],
          additionalProperties: false,
        }),
        requiredCapabilities: arrayOf(stringSchema),
        skip: nullable({
          type: "object",
          properties: {
            reason: skipReasonSchema,
            capabilities: arrayOf(stringSchema),
          },
          required: ["reason", "capabilities"],
          additionalProperties: false,
        }),
        graders: arrayOf(planItemSchema),
      },
      required: [
        "testId",
        "testVersionId",
        "testName",
        "personas",
        "requiredCapabilities",
        "skip",
        "graders",
      ],
      additionalProperties: false,
    }),
  },
  required: [
    "agentId",
    "connectionId",
    "connection",
    "runnableSimulationCount",
    "skippedSimulationCount",
    "tests",
  ],
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
    skipped: integerSchema,
  },
  required: [
    "queued",
    "claimed",
    "running",
    "completed",
    "failed",
    "canceled",
    "skipped",
  ],
  additionalProperties: false,
} as const;

const connectionSnapshotSchema = {
  type: "object",
  properties: {
    agentPlatform: nullable(stringSchema),
    connectionKind: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
    topology: stringSchema,
    environment: nullable(stringSchema),
    config: {},
  },
  required: [
    "agentPlatform",
    "connectionKind",
    "accessVariant",
    "modality",
    "topology",
    "environment",
    "config",
  ],
  additionalProperties: false,
} as const;

const byGraderSchema = {
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
} as const;

const runSimulationSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    position: integerSchema,
    testId: nullable(stringIdSchema),
    testName: nullable(stringSchema),
    testVersionId: nullable(stringIdSchema),
    personaId: stringIdSchema,
    personaName: stringSchema,
    personaVersionId: stringIdSchema,
    status: simulationStatusSchema,
    grading: gradingStandingSchema,
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    counts: nullable(verdictCountsSchema),
    diagnostics: nullable(outcomeSchema),
    verdicts: arrayOf(recordedVerdictSchema),
    reason: nullable(endingReasonSchema),
    skipReason: nullable(skipReasonSchema),
    skippedCapabilities: nullable(arrayOf(stringSchema)),
    mockToolCoverage: nullable(mockToolCoverageSchema),
    modality: modalitySchema,
    hasRecording: booleanSchema,
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
    "diagnostics",
    "verdicts",
    "reason",
    "skipReason",
    "skippedCapabilities",
    "mockToolCoverage",
    "modality",
    "hasRecording",
  ],
  additionalProperties: false,
} as const;

const runSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    status: runStatusSchema,
    agentId: stringIdSchema,
    connectionId: stringIdSchema,
    agentPlatform: nullable(stringSchema),
    connectionKind: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
    productLabel: stringSchema,
    connectionSnapshot: connectionSnapshotSchema,
    label: nullable(stringSchema),
    retryOfRunId: nullable(stringIdSchema),
    testVersions: arrayOf(stringIdSchema),
    mockTools: mockToolSnapshotSchema,
    expectedSimulationCount: integerSchema,
    completedCount: nullable(integerSchema),
    failedCount: nullable(integerSchema),
    canceledCount: nullable(integerSchema),
    skippedCount: nullable(integerSchema),
    resultsUrl: stringSchema,
    createdAt: dateTimeSchema,
    finishedAt: nullable(dateTimeSchema),
    gradedCount: integerSchema,
    finishedCount: integerSchema,
    gradableCount: integerSchema,
    simulationCounts: simulationCountsSchema,
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    counts: nullable(verdictCountsSchema),
    diagnostics: nullable(outcomeSchema),
    byGrader: arrayOf(byGraderSchema),
    simulations: arrayOf(runSimulationSchema),
  },
  required: [
    "id",
    "projectId",
    "status",
    "agentId",
    "connectionId",
    "agentPlatform",
    "connectionKind",
    "accessVariant",
    "modality",
    "productLabel",
    "connectionSnapshot",
    "label",
    "retryOfRunId",
    "testVersions",
    "mockTools",
    "expectedSimulationCount",
    "completedCount",
    "failedCount",
    "canceledCount",
    "skippedCount",
    "resultsUrl",
    "createdAt",
    "finishedAt",
    "gradedCount",
    "finishedCount",
    "gradableCount",
    "simulationCounts",
    "verdict",
    "score",
    "counts",
    "diagnostics",
    "byGrader",
    "simulations",
  ],
  additionalProperties: false,
} as const;

const gradingPlanSchema = {
  type: "object",
  properties: {
    state: {
      type: "string",
      enum: ["run_start", "migration_snapshot", "not_recorded"],
    },
    capturedAt: nullable(dateTimeSchema),
    groups: arrayOf({
      oneOf: [
        {
          type: "object",
          properties: {
            tag: { type: "string", enum: ["version"] },
            testId: stringIdSchema,
            testVersionId: stringIdSchema,
            testName: stringSchema,
            items: arrayOf(planItemSchema),
          },
          required: [
            "tag",
            "testId",
            "testVersionId",
            "testName",
            "items",
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            tag: { type: "string", enum: ["legacy_testless"] },
            items: arrayOf(planItemSchema),
          },
          required: ["tag", "items"],
          additionalProperties: false,
        },
      ],
    }),
  },
  required: ["state", "capturedAt", "groups"],
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

const runDetailSchema = {
  ...runSchema,
  properties: {
    ...runSchema.properties,
    gradingPlan: nullable(gradingPlanSchema),
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
  required: [...runSchema.required, "gradingPlan", "agent", "connection"],
} as const;

const historyEntrySchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    status: runStatusSchema,
    label: nullable(stringSchema),
    agentId: stringIdSchema,
    connectionId: stringIdSchema,
    agentPlatform: nullable(stringSchema),
    connectionKind: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
    productLabel: stringSchema,
    environment: nullable(stringSchema),
    retryOfRunId: nullable(stringIdSchema),
    expectedSimulationCount: integerSchema,
    completedCount: nullable(integerSchema),
    failedCount: nullable(integerSchema),
    canceledCount: nullable(integerSchema),
    skippedCount: nullable(integerSchema),
    simulationCounts: simulationCountsSchema,
    finishedCount: integerSchema,
    gradableCount: integerSchema,
    gradedCount: integerSchema,
    verdict: nullable(verdictSchema),
    score: nullable(numberSchema),
    verdictCounts: verdictCountsSchema,
    createdAt: dateTimeSchema,
    startedAt: nullable(dateTimeSchema),
    finishedAt: nullable(dateTimeSchema),
  },
  required: [
    "id",
    "projectId",
    "status",
    "label",
    "agentId",
    "connectionId",
    "agentPlatform",
    "connectionKind",
    "accessVariant",
    "modality",
    "productLabel",
    "environment",
    "retryOfRunId",
    "expectedSimulationCount",
    "completedCount",
    "failedCount",
    "canceledCount",
    "skippedCount",
    "simulationCounts",
    "finishedCount",
    "gradableCount",
    "gradedCount",
    "verdict",
    "score",
    "verdictCounts",
    "createdAt",
    "startedAt",
    "finishedAt",
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

const projectQuery = parameters({ projectId: stringIdSchema });
const runParams = parameters({ runId: stringIdSchema }, ["runId"]);
const simulationParams = parameters({ simulationId: stringIdSchema }, [
  "simulationId",
]);

const idempotentBody = {
  type: "object",
  properties: {
    idempotencyKey: stringSchema,
  },
  required: ["idempotencyKey"],
  additionalProperties: false,
} as const;

const commonReadRefusals = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  404: refusalResponse,
  429: rateLimitResponse,
} as const;

const commonWriteRefusals = {
  ...commonReadRefusals,
  409: refusalResponse,
  422: refusalResponse,
} as const;

export const runOperations = {
  getRunPlan: defineOperation({
    operationId: "getRunPlan",
    method: "GET",
    path: "/v1/run-plan",
    summary: "Preview a run",
    tag: "Runs",
    security: "credentialed",
    request: {
      query: parameters(
        {
          projectId: stringIdSchema,
          agentId: stringIdSchema,
          connectionId: stringIdSchema,
          testVersionIds: stringSchema,
        },
        ["connectionId", "testVersionIds"],
      ),
    },
    responses: {
      200: { description: "The run plan.", schema: runPlanSchema },
      ...commonWriteRefusals,
    },
  }),

  createRun: defineOperation({
    operationId: "createRun",
    method: "POST",
    path: "/v1/runs",
    summary: "Start a run",
    tag: "Runs",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          agentId: stringIdSchema,
          connectionId: stringIdSchema,
          testVersionIds: arrayOf(stringIdSchema),
          idempotencyKey: stringSchema,
          label: stringSchema,
        },
        required: ["connectionId", "testVersionIds", "idempotencyKey"],
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      201: { description: "The new run.", schema: runSchema },
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
        agentId: stringIdSchema,
        connectionId: stringIdSchema,
        testId: stringIdSchema,
        status: runStatusSchema,
        verdict: verdictSchema,
        since: dateTimeSchema,
        until: dateTimeSchema,
        pageSize: integerSchema,
        pageToken: stringSchema,
      }),
    },
    responses: {
      200: {
        description: "A page of runs.",
        schema: {
          type: "object",
          properties: {
            runs: arrayOf(historyEntrySchema),
            nextPageToken: nullable(stringSchema),
          },
          required: ["runs", "nextPageToken"],
          additionalProperties: false,
        },
      },
      ...commonReadRefusals,
      422: refusalResponse,
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
      200: { description: "The run and its evidence.", schema: runDetailSchema },
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

  retryRun: defineOperation({
    operationId: "retryRun",
    method: "POST",
    path: "/v1/runs/{runId}/retry",
    summary: "Retry a run",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: runParams,
      query: projectQuery,
      body: idempotentBody,
      bodyRequired: true,
    },
    responses: {
      201: { description: "The retry run.", schema: runSchema },
      ...commonWriteRefusals,
    },
  }),

  rerunSimulation: defineOperation({
    operationId: "rerunSimulation",
    method: "POST",
    path: "/v1/simulations/{simulationId}/rerun",
    summary: "Run one simulation again",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: simulationParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          idempotencyKey: stringSchema,
          label: stringSchema,
        },
        required: ["idempotencyKey", "label"],
        additionalProperties: false,
      },
      bodyRequired: true,
    },
    responses: {
      201: { description: "The new one-simulation run.", schema: runSchema },
      ...commonWriteRefusals,
    },
  }),

  cancelRun: defineOperation({
    operationId: "cancelRun",
    method: "POST",
    path: "/v1/runs/{runId}/cancel",
    summary: "Cancel a run",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: runParams,
      query: projectQuery,
    },
    responses: {
      200: { description: "The canceled run as it now stands.", schema: runSchema },
      ...commonWriteRefusals,
    },
  }),
} as const;
