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

const monitoredAgent = {
  type: "object",
  properties: {
    id: stringIdSchema,
    platformAgentId: { type: "string" },
    platformAgentName: { type: "string" },
    state: { type: "string" },
    scanKind: nullable({ type: "string" }),
    lastSuccessAt: optionalInstant,
    lastConversationAt: optionalInstant,
    lastErrorKind: nullable({ type: "string" }),
    lastErrorAt: optionalInstant,
    consecutiveFailures: { type: "integer", minimum: 0 },
    failures: arrayOf(importFailure),
  },
  required: [
    "id",
    "platformAgentId",
    "platformAgentName",
    "state",
    "scanKind",
    "lastSuccessAt",
    "lastConversationAt",
    "lastErrorKind",
    "lastErrorAt",
    "consecutiveFailures",
    "failures",
  ],
  additionalProperties: false,
} as const;

const monitoringSource = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    agentPlatform: { type: "string" },
    strategy: { type: "string" },
    credentialsHint: nullable({ type: "string" }),
    health: {
      type: "object",
      properties: {
        state: { type: "string" },
        blockedUntil: optionalInstant,
        consecutiveFailures: { type: "integer", minimum: 0 },
        lastErrorAt: optionalInstant,
        lastRecoveredAt: optionalInstant,
        lastReceivedAt: optionalInstant,
      },
      required: [
        "state",
        "blockedUntil",
        "consecutiveFailures",
        "lastErrorAt",
        "lastRecoveredAt",
        "lastReceivedAt",
      ],
      additionalProperties: false,
    },
    agents: arrayOf(monitoredAgent),
  },
  required: [
    "id",
    "projectId",
    "agentPlatform",
    "strategy",
    "credentialsHint",
    "health",
    "agents",
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
  listMonitoringSources: defineOperation({
    operationId: "listMonitoringSources",
    method: "GET",
    path: "/v1/monitoring",
    summary: "List monitoring sources",
    tag: "Monitoring",
    security: "credentialed",
    request: { query: projectQuery },
    responses: {
      200: {
        description: "Configured monitoring sources.",
        schema: {
          type: "object",
          properties: { monitoringSources: arrayOf(monitoringSource) },
          required: ["monitoringSources"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),

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

  configureRetellMonitoring: defineOperation({
    operationId: "configureRetellMonitoring",
    method: "PUT",
    path: "/v1/monitoring/retell",
    summary: "Configure Retell monitoring",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          apiKey: { type: "string" },
          agents: arrayOf(retellAgent),
        },
        required: ["apiKey", "agents"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "The configured monitoring source.",
        schema: {
          type: "object",
          properties: { monitoringSource },
          required: ["monitoringSource"],
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

  configureLiveKitMonitoring: defineOperation({
    operationId: "configureLiveKitMonitoring",
    method: "PUT",
    path: "/v1/monitoring/livekit-agents",
    summary: "Configure LiveKit Agents monitoring",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      query: projectQuery,
    },
    responses: {
      200: {
        description: "The configured monitoring source.",
        schema: {
          type: "object",
          properties: { monitoringSource },
          required: ["monitoringSource"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
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

  deleteMonitoringSource: defineOperation({
    operationId: "deleteMonitoringSource",
    method: "DELETE",
    path: "/v1/monitoring/{platform}",
    summary: "Delete a monitoring source",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      params: parameters({ platform: { type: "string" } }, ["platform"]),
      query: projectQuery,
    },
    responses: {
      204: { description: "The monitoring source was deleted." },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
