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
  outcomeSchema,
  recordedVerdictSchema,
} from "./runs.ts";

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const numberSchema = { type: "number" } as const;
const booleanSchema = { type: "boolean" } as const;

const turnCountsSchema = {
  type: "object",
  properties: { human: integerSchema, agent: integerSchema },
  required: ["human", "agent"],
  additionalProperties: false,
} as const;

const traceFactsSchema = {
  type: "object",
  properties: {
    traceId: stringSchema,
    startedAt: dateTimeSchema,
    endedAt: dateTimeSchema,
    durationNs: stringSchema,
    spanCount: integerSchema,
    turnCounts: turnCountsSchema,
    toolSpanCount: integerSchema,
    erroredSpanCount: integerSchema,
    source: { type: "string", enum: ["simulation", "production"] },
    emitter: stringSchema,
    environment: stringSchema,
    connectionType: stringSchema,
    providerCallId: stringSchema,
    agentPlatform: stringSchema,
    platformAgentId: stringSchema,
    platformAgentName: stringSchema,
    platformAgentVersion: stringSchema,
    runId: stringSchema,
    agentId: stringSchema,
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
    "source",
    "emitter",
    "environment",
    "connectionType",
    "providerCallId",
    "agentPlatform",
    "platformAgentId",
    "platformAgentName",
    "platformAgentVersion",
    "runId",
    "agentId",
  ],
  additionalProperties: false,
} as const;

const traceSummarySchema = {
  ...traceFactsSchema,
  properties: { ...traceFactsSchema.properties, preview: stringSchema },
  required: [...traceFactsSchema.required, "preview"],
} as const;

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

const traceDetailSchema = {
  $defs: { traceSpan: traceSpanSchema },
  type: "object",
  properties: {
    trace: traceFactsSchema,
    turns: arrayOf(traceSpanReference),
    spans: arrayOf(traceSpanReference),
    spansTruncated: booleanSchema,
    metrics: arrayOf(metricSchema),
    simulationId: nullable(stringIdSchema),
    verdicts: arrayOf(recordedVerdictSchema),
    outcome: nullable(outcomeSchema),
    diagnostics: nullable(outcomeSchema),
  },
  required: [
    "trace",
    "turns",
    "spans",
    "spansTruncated",
    "metrics",
    "simulationId",
    "verdicts",
    "outcome",
    "diagnostics",
  ],
  additionalProperties: false,
} as const;

const windowQuery = {
  from: dateTimeSchema,
  to: dateTimeSchema,
  projectId: stringIdSchema,
} as const;

export const traceReadOperations = {
  listTraces: defineOperation({
    operationId: "listTraces",
    method: "GET",
    path: "/v1/traces",
    summary: "List traces",
    tag: "Traces",
    security: "credentialed",
    request: {
      query: parameters(
        {
          ...windowQuery,
          source: {
            type: "string",
            enum: ["simulation", "production"],
          },
          pageSize: integerSchema,
          pageToken: stringSchema,
        },
        ["from", "to"],
      ),
    },
    responses: {
      200: {
        description: "A page of traces inside the requested window.",
        schema: {
          type: "object",
          properties: {
            traces: arrayOf(traceSummarySchema),
            nextPageToken: nullable(stringSchema),
            window: {
              type: "object",
              properties: { from: dateTimeSchema, to: dateTimeSchema },
              required: ["from", "to"],
              additionalProperties: false,
            },
          },
          required: ["traces", "nextPageToken", "window"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  getTrace: defineOperation({
    operationId: "getTrace",
    method: "GET",
    path: "/v1/traces/{traceId}",
    summary: "Get a trace",
    tag: "Traces",
    security: "credentialed",
    request: {
      params: parameters({ traceId: stringSchema }, ["traceId"]),
      query: parameters(windowQuery, ["from", "to"]),
    },
    responses: {
      200: { description: "The trace and its judgments.", schema: traceDetailSchema },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
