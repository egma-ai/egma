import { defineOperation } from "../definition.ts";
import {
  anySchema,
  arrayOf,
  dateTimeSchema,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const optionalInstant = nullable(dateTimeSchema);

const importFailure = {
  type: "object",
  properties: {
    id: stringIdSchema,
    providerCallId: { type: "string" },
    errorKind: { type: "string" },
    attempts: { type: "integer", minimum: 0 },
    status: { type: "string" },
    lastAttemptAt: dateTimeSchema,
    createdAt: dateTimeSchema,
  },
  required: [
    "id",
    "providerCallId",
    "errorKind",
    "attempts",
    "status",
    "lastAttemptAt",
    "createdAt",
  ],
  additionalProperties: false,
} as const;


const projectQuery = parameters({ projectId: stringIdSchema });
const retellAgent = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

export const monitoringOperations = {
  discoverRetellVoiceAgents: defineOperation({
    operationId: "discoverRetellVoiceAgents",
    method: "POST",
    path: "/v1/monitoring/retell/discover",
    summary: "Discover Retell voice agents",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: { apiKey: { type: "string" } },
        required: ["apiKey"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "Retell voice-agent identities.",
        schema: {
          type: "object",
          properties: { agents: arrayOf(retellAgent) },
          required: ["agents"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),


  replayMonitoringImportFailure: defineOperation({
    operationId: "replayMonitoringImportFailure",
    method: "POST",
    path: "/v1/monitoring/retell/failures/{failureId}/replay",
    summary: "Replay a monitoring import failure",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      params: parameters({ failureId: stringIdSchema }, ["failureId"]),
      query: projectQuery,
    },
    responses: {
      200: {
        description: "The resolved failure and imported trace.",
        schema: {
          type: "object",
          properties: {
            monitoringImportFailure: {
              type: "object",
              properties: {
                id: stringIdSchema,
                status: { type: "string", const: "resolved" },
              },
              required: ["id", "status"],
              additionalProperties: false,
            },
            trace: {
              type: "object",
              properties: { id: { type: "string" }, write: anySchema },
              required: ["id", "write"],
              additionalProperties: false,
            },
          },
          required: ["monitoringImportFailure", "trace"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),

} as const;
