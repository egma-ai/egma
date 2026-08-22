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
const agentParams = parameters({ agentId: stringIdSchema }, ["agentId"]);

/**
 * One agent on the Retell account a pasted key opens, and what this project
 * already knows about it.
 *
 * The registration facts are what make the list a picker rather than a
 * catalogue: an account agent that is already an egma agent is *recognized*
 * and confirmed, and one that is not can be ticked to be registered and
 * watched in the same commit. They are read from (project, agent platform,
 * platform agent id) — the same triple the pull-uniqueness index is built on.
 */
const retellAgent = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    /** The egma agent already bound to this platform agent, or null. */
    registeredAgentId: nullable(stringIdSchema),
    registeredAgentName: nullable({ type: "string" }),
    /** Whether that egma agent already pulls this platform agent's calls. */
    pullProductionCalls: { type: "boolean" },
  },
  required: [
    "id",
    "name",
    "registeredAgentId",
    "registeredAgentName",
    "pullProductionCalls",
  ],
  additionalProperties: false,
} as const;

/**
 * One platform agent this commit is asked to watch.
 *
 * `agentId` is the egma agent the flow started from, where there is one.
 * Left out, the commit resolves the agent by (project, agent platform,
 * platform agent id) and creates one under `name` when nothing answers —
 * watching an unregistered platform agent *means* registering it (ADR-0015).
 */
const watchRequest = {
  type: "object",
  properties: {
    platformAgentId: { type: "string" },
    name: { type: "string" },
    agentId: stringIdSchema,
  },
  required: ["platformAgentId"],
  additionalProperties: false,
} as const;

const watched = {
  type: "object",
  properties: {
    agentId: stringIdSchema,
    agentName: { type: "string" },
    platformAgentId: { type: "string" },
    /** Whether this commit brought the agent row into existence. */
    created: { type: "boolean" },
    pullProductionCalls: { type: "boolean" },
  },
  required: [
    "agentId",
    "agentName",
    "platformAgentId",
    "created",
    "pullProductionCalls",
  ],
  additionalProperties: false,
} as const;

/** What the switch says about one agent. No health, no progress. */
const pullState = {
  type: "object",
  properties: {
    agentId: stringIdSchema,
    pullProductionCalls: { type: "boolean" },
    agentPlatform: nullable({
      type: "string",
      enum: ["retell", "livekit_agents"],
    }),
    platformAgentId: nullable({ type: "string" }),
    monitoringApiKeyHint: nullable({ type: "string" }),
    lastReceivedAt: optionalInstant,
  },
  required: [
    "agentId",
    "pullProductionCalls",
    "agentPlatform",
    "platformAgentId",
    "monitoringApiKeyHint",
    "lastReceivedAt",
  ],
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

  /**
   * Start pulling production calls, for one platform agent or several at once.
   *
   * One commit does the whole of it: the key is sealed onto every agent it
   * names, each switch is flipped, and each notebook opens with the 30-day
   * historical window. An agent row is created for a platform agent this
   * project does not register yet, because watching one *means* registering it.
   *
   * A tick that would put two switched-on agents on one platform agent is
   * refused with `409` and a sentence naming the agent already watching it.
   * The refusal is the database's own uniqueness answer, caught — a check
   * before the write would be a race with the next request.
   */
  startMonitoring: defineOperation({
    operationId: "startMonitoring",
    method: "POST",
    path: "/v1/monitoring/start",
    summary: "Start pulling an agent's production calls",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          agentPlatform: { type: "string", enum: ["retell"] },
          apiKey: { type: "string" },
          watch: arrayOf(watchRequest),
        },
        required: ["agentPlatform", "apiKey", "watch"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "Every agent now pulling its production calls.",
        schema: {
          type: "object",
          properties: { watching: arrayOf(watched) },
          required: ["watching"],
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
      503: refusalResponse,
    },
  }),

  /**
   * Stop pulling one agent's production calls.
   *
   * Everything stored stays stored: the transcripts, the agent's binding, its
   * sealed key, and the notebook whose cursor a later start resumes from. The
   * switch is what makes an agent due, so turning it off is the whole of
   * stopping.
   */
  stopMonitoring: defineOperation({
    operationId: "stopMonitoring",
    method: "POST",
    path: "/v1/monitoring/agents/{agentId}/stop",
    summary: "Stop pulling an agent's production calls",
    tag: "Monitoring",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      bodyRequired: false,
    },
    responses: {
      200: {
        description: "The agent, with its pull switch off.",
        schema: {
          type: "object",
          properties: { monitoring: pullState },
          required: ["monitoring"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
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

} as const;
