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
  description:
    "Simulation execution status. A completed run can contain failed simulations, and grading may still be in progress.",
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
    "provider_key_unavailable",
  ],
} as const;

/**
 * The serving engine version used to prepare a run's temporary Retell version.
 * The adjacent cleanup fields state whether the temporary version remains.
 * Egma does not change phone-number routing.
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
    /** The connection's current name, or null when its row is gone. */
    connectionName: nullable(stringSchema),
    agentPlatform: nullable(stringSchema),
    connectionType: stringSchema,
    accessVariant: stringSchema,
    modality: modalitySchema,
    productLabel: stringSchema,
    environment: nullable(stringSchema),
    agentVersion: nullable(integerSchema),
    concurrency: {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
      description: "Maximum active simulations in this run, fixed when the run starts.",
    },
    expectedSimulationCount: {
      ...integerSchema,
      description: "Number of test-and-persona combinations captured when the run started.",
    },
    completedCount: nullable(integerSchema),
    failedCount: nullable(integerSchema),
    canceledCount: nullable(integerSchema),
    simulationCounts: simulationCountsSchema,
    finishedCount: {
      ...integerSchema,
      description: "Simulations whose execution completed, failed, or was canceled.",
    },
    gradableCount: {
      ...integerSchema,
      description: "Simulations eligible for grading under the run's frozen grader selection.",
    },
    gradedCount: {
      ...integerSchema,
      description: "Gradable simulations whose grading is complete or errored. This is not a count of passed simulations.",
    },
    resultsUrl: {
      ...stringSchema,
      description: "Open this URL in a browser to follow the run and inspect its results.",
    },
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
    "connectionName",
    "agentPlatform",
    "connectionType",
    "accessVariant",
    "modality",
    "productLabel",
    "environment",
    "agentVersion",
    "concurrency",
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
export const workBlockSchema = {
  type: "object",
  properties: {
    error: { type: "string", enum: ["allowance_spent", "providers_unfunded"] },
    message: stringSchema,
  },
  required: ["error", "message"],
  additionalProperties: false,
} as const;

const runDetailSchema = {
  ...runHeaderSchema,
  properties: {
    ...runHeaderSchema.properties,
    eventThrough: integerSchema,
    workBlock: nullable(workBlockSchema),
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
    "workBlock",
    "tempMockAgentVersion",
    "tempMockAgentVersionCleanup",
    "mockMetadata",
    "connectionSnapshot",
    "agent",
    "connection",
  ],
} as const;

/**
 * How the current grades of one simulation stand against its frozen plan.
 *
 * `selected` counts the project graders the plan holds. The three results
 * count the current grade of each of them, so they sum to `selected` only
 * once every grader has a result.
 */
const gradeTallySchema = {
  type: "object",
  properties: {
    passed: integerSchema,
    failed: integerSchema,
    errored: integerSchema,
    selected: integerSchema,
  },
  required: ["passed", "failed", "errored", "selected"],
  additionalProperties: false,
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
    /** Null when the simulation has no grading state to count. */
    gradeTally: nullable(gradeTallySchema),
    reason: nullable(endingReasonSchema),
    executionFailure: nullable(stringSchema),
    startedAt: nullable(dateTimeSchema),
    endedAt: nullable(dateTimeSchema),
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
    "gradingState",
    "combinedScore",
    "gradeTally",
    "reason",
    "executionFailure",
    "startedAt",
    "endedAt",
    "modality",
    "hasRecording",
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
    testId: { ...stringIdSchema, description: "The test identity to check." },
    versionId: { ...stringIdSchema, description: "The current test version expected at run creation." },
  },
  required: ["testId", "versionId"],
  additionalProperties: false,
} as const;

const projectQuery = parameters({
  projectId: {
    ...stringIdSchema,
    description: "Project to act in. A project-scoped API key already identifies its project.",
  },
});
const runParams = parameters({
  runId: {
    ...stringIdSchema,
    description: "Run ID returned by Create a run or List runs.",
    examples: ["run_01M0E4J0BBE1FVDVTZ1BSS5C97"],
  },
}, ["runId"]);
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
    summary: "Create a run",
    description:
      "Run every active test in a suite against one agent connection. Execution and grading continue after this request returns. Keep the returned id to follow progress and inspect results.",
    tag: "Runs",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          suiteId: {
            ...stringIdSchema,
            description: "The active, non-empty test suite to execute in full. It must belong to the selected project.",
            examples: ["ste_01M0E4J0BBE1FVDVTZ1BSS5C97"],
          },
          agentId: {
            ...stringIdSchema,
            description: "The Egma agent to test, not its Retell provider ID or LiveKit dispatch name.",
            examples: ["agt_01M0E4J0BBE1FVDVTZ1BSS5C97"],
          },
          connectionId: {
            ...stringIdSchema,
            description: "An active connection on that agent in the same project. Its modality determines whether simulations use voice or chat.",
            examples: ["con_01M0E4J0BBE1FVDVTZ1BSS5C97"],
          },
          name: {
            ...stringSchema,
            description: "Optional display name for the run.",
            examples: ["Appointment booking release check"],
          },
          expectedTestVersions: {
            ...arrayOf(expectedTestVersionSchema),
            description: "Optional exact list of the suite's test IDs and current version IDs. Each test and version must appear once. The request is refused if the suite membership or any version changed. Omit this field to use the current suite.",
          },
          concurrency: {
            type: "integer", minimum: 1, maximum: 2147483647,
            description: "Maximum active simulations in this run. Defaults to 4 for voice and 10 for chat. Worker and provider limits still apply.",
          },
        },
        required: ["suiteId", "agentId", "connectionId"],
        additionalProperties: false,
        examples: [{
          suiteId: "ste_01M0E4J0BBE1FVDVTZ1BSS5C97",
          agentId: "agt_01M0E4J0BBE1FVDVTZ1BSS5C97",
          connectionId: "con_01M0E4J0BBE1FVDVTZ1BSS5C97",
          name: "Appointment booking release check",
        }],
      },
      bodyRequired: true,
    },
    responses: {
      201: { description: "The run header for a new request or an idempotent replay. The run may still be executing or grading.", schema: runHeaderSchema },
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
    description:
      "Read run events in sequence order. Pass each response’s next value as after. Continue until done is true, then inspect the simulation grades for pass or fail results.",
    tag: "Runs",
    security: "credentialed",
    request: {
      params: runParams,
      query: parameters({
        projectId: projectQuery.properties.projectId,
        after: {
          ...integerSchema,
          description: "Return events with a sequence greater than this value. Use zero or omit it for the first page; use the previous response's next value to continue.",
          examples: [0],
        },
      }),
    },
    responses: {
      200: {
        description: "The run events after the requested sequence.",
        schema: {
          type: "object",
          properties: {
            events: arrayOf(runEventSchema),
            next: {
              ...integerSchema,
              description: "Cursor to send as after on the next request. An empty page returns the same cursor.",
            },
            caughtUp: {
              ...booleanSchema,
              description: "This page includes all execution events available when it was read. More events or grades may arrive later.",
            },
            done: {
              ...booleanSchema,
              description: "Execution finished, no execution events remain in the backlog, and every gradable simulation has complete or errored grading. Inspect individual grades to decide whether the run meets your requirements.",
            },
          },
          required: ["events", "next", "caughtUp", "done"],
          additionalProperties: false,
          examples: [{ events: [], next: 12, caughtUp: true, done: false }],
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
