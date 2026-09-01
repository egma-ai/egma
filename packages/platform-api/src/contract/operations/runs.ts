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
import { gradingStateSchema, normalizedScoreSchema } from "./grades.ts";

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const booleanSchema = { type: "boolean" } as const;
const pageSizeSchema = { type: "integer", minimum: 1, maximum: 200 } as const;

const runStatusSchema = {
  type: "string",
  enum: ["pending", "running", "completed", "canceled"],
} as const;

export const simulationStatusSchema = {
  type: "string",
  enum: ["queued", "claimed", "running", "completed", "failed", "canceled"],
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

/**
 * How isolated one simulation was, in three lists: what the agent has, what
 * Egma answered for, and what reached its real implementation.
 *
 * **Written by the LiveKit in-room seam and by nothing else.** There the agent
 * declares its tools per conversation, so two simulations of one run can
 * honestly differ and the stamp belongs at the simulation. The Retell lanes
 * decide what they answer for once per run and mark each answered call on the
 * transcript, so they leave it absent — which is the report saying nobody was
 * ever asked, a different sentence from three empty lists.
 */
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

/**
 * The note a mocked run leaves behind, as a reader sees it.
 *
 * It is on the run's header because it is a fact about the whole run: one
 * engine, read once, that the temporary copy's tools were built from. Naming it
 * is what lets a reader go and look at the version this run was conducted
 * against.
 *
 * **It once carried a list of touched phone numbers**, because Egma pinned a
 * number that follows Retell's latest pointer for the length of a run and put
 * it back afterwards. Egma writes to no customer's numbers any more (developer
 * ruling, 2026-08-31), so there is nothing of theirs to promise back and
 * nothing to list. The one thing a mocked run makes is its own temporary
 * version, and the two cleanup fields beside this note are what say whether it
 * is still standing.
 */
export const mockMetadataSchema = {
  type: "object",
  properties: {
    engine: {
      type: "object",
      properties: {
        type: stringSchema,
        engineId: stringSchema,
        version: nullable(integerSchema),
      },
      required: ["type", "engineId", "version"],
      additionalProperties: false,
    },
  },
  required: ["engine"],
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
    agentVersion: nullable(integerSchema),
    mockToolsEnabled: booleanSchema,
    expectedSimulationCount: integerSchema,
    completedCount: nullable(integerSchema),
    failedCount: nullable(integerSchema),
    canceledCount: nullable(integerSchema),
    simulationCounts: simulationCountsSchema,
    finishedCount: integerSchema,
    gradableCount: integerSchema,
    gradedCount: integerSchema,
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
    "agentVersion",
    "mockToolsEnabled",
    "expectedSimulationCount",
    "completedCount",
    "failedCount",
    "canceledCount",
    "simulationCounts",
    "finishedCount",
    "gradableCount",
    "gradedCount",
    "resultsUrl",
    "createdAt",
    "startedAt",
    "finishedAt",
  ],
  additionalProperties: false,
} as const;

/**
 * One run asked for by name, which is where the temporary platform world is
 * answered.
 *
 * It is on the detail read and on no list, deliberately: the world carries every
 * touched number's inbound routing verbatim, and repeating all of it once per
 * row of a two-hundred-run page would put somebody's telephone routing in front
 * of a reader who asked for a list of runs.
 */
const runDetailSchema = {
  ...runHeaderSchema,
  properties: {
    ...runHeaderSchema.properties,
    eventThrough: integerSchema,
    tempMockAgentVersion: nullable(integerSchema),
    tempMockAgentVersionCleanup: nullable(booleanSchema),
    mockMetadata: nullable(mockMetadataSchema),
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
    "eventThrough",
    "tempMockAgentVersion",
    "tempMockAgentVersionCleanup",
    "mockMetadata",
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
    gradingState: nullable(gradingStateSchema),
    combinedScore: nullable(normalizedScoreSchema),
    reason: nullable(endingReasonSchema),
    executionFailure: nullable(stringSchema),
    startedAt: nullable(dateTimeSchema),
    endedAt: nullable(dateTimeSchema),
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
    "gradingState",
    "combinedScore",
    "reason",
    "executionFailure",
    "startedAt",
    "endedAt",
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
        reason: nullable(endingReasonSchema),
        executionFailure: nullable(stringSchema),
      },
      required: [
        "seq",
        "at",
        "kind",
        "simulationId",
        "testName",
        "personaName",
        "status",
        "reason",
        "executionFailure",
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
      // A run over a lane that pins a version reads the agent's own platform
      // before anything is written. A platform that would not answer is not
      // the caller's mistake and is not fixed by changing the request — it is
      // fixed by asking again — so it takes its own code and its own status.
      503: refusalResponse,
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
            caughtUp: booleanSchema,
            done: booleanSchema,
          },
          required: ["events", "next", "caughtUp", "done"],
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
