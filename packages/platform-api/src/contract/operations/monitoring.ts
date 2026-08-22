import { defineOperation } from "../definition.ts";
import {
  arrayOf,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

/**
 * Monitoring configuration is the agent's, so this tag holds only what the
 * start-monitoring flow needs: reading a platform account with a key it has
 * just been given, and the per-agent pull switch itself.
 *
 * There is no setup object and no source list. Pull is declared on the agent;
 * push is observed through its traffic and has no server state at all.
 */
const pullSwitch = {
  type: "object",
  properties: {
    agentId: stringIdSchema,
    agentPlatform: nullable({
      type: "string",
      enum: ["retell", "livekit_agents"],
    }),
    platformAgentId: nullable({ type: "string" }),
    monitoringKeyHint: nullable({ type: "string" }),
    pullProductionCalls: { type: "boolean" },
  },
  required: [
    "agentId",
    "agentPlatform",
    "platformAgentId",
    "monitoringKeyHint",
    "pullProductionCalls",
  ],
  additionalProperties: false,
} as const;

const projectQuery = parameters({ projectId: stringIdSchema });
const agentParams = parameters({ agentId: stringIdSchema }, ["agentId"]);
const retellAgent = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const pullSwitchResponse = {
  description: "The agent's pull switch as it now stands.",
  schema: {
    type: "object",
    properties: { pullSwitch },
    required: ["pullSwitch"],
    additionalProperties: false,
  },
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

  startPullingProductionCalls: defineOperation({
    operationId: "startPullingProductionCalls",
    method: "PUT",
    path: "/v1/agents/{agentId}/production-pull",
    summary: "Pull this agent's production calls",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          agentPlatform: { type: "string", enum: ["retell"] },
          platformAgentId: { type: "string" },
          apiKey: { type: "string" },
        },
        required: ["agentPlatform", "platformAgentId", "apiKey"],
        additionalProperties: false,
      },
    },
    responses: {
      200: pullSwitchResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),

  stopPullingProductionCalls: defineOperation({
    operationId: "stopPullingProductionCalls",
    method: "DELETE",
    path: "/v1/agents/{agentId}/production-pull",
    summary: "Stop pulling this agent's production calls",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
    },
    responses: {
      200: pullSwitchResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
