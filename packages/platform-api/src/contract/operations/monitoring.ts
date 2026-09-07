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

const optionalInstant = nullable(dateTimeSchema);

const projectQuery = parameters({ projectId: stringIdSchema });
const agentParams = parameters({ agentId: stringIdSchema }, ["agentId"]);

/**
 * A discovered Retell agent and its registration in this project. Match by
 * project, agent platform, and platform agent ID, as the pull-uniqueness index
 * does.
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

/**
 * One ticked platform agent that did not start, and why.
 *
 * **A refusal is per tick, not per request.** Starting one agent is a whole
 * act on its own, so one entry losing the one-switched-on-agent rule cannot be
 * allowed to hide the entries that did start — a request answered with only a
 * refusal would leave switches on that nothing on screen mentions.
 */
const refusedWatch = {
  type: "object",
  properties: {
    platformAgentId: { type: "string" },
    reason: {
      type: "string",
      enum: ["contested", "name_taken", "not_found", "archived"],
    },
    /** The whole sentence, ready to show. Never a constraint name. */
    message: { type: "string" },
  },
  required: ["platformAgentId", "reason", "message"],
  additionalProperties: false,
} as const;

/**
 * What the switch says about one agent: its binding, the hint for its sealed
 * key, and when a production call last arrived.
 */
const pullState = {
  type: "object",
  properties: {
    agentId: stringIdSchema,
    pullProductionCalls: { type: "boolean" },
    agentPlatform: {
      type: "string",
      enum: ["retell", "livekit"],
    },
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
   * Enable production pull for the selected platform agents, registering any
   * missing agents and sealing their monitoring keys. Each selection receives
   * an answer; a uniqueness refusal for one does not stop the others. Initial
   * pull includes the 30-day historical window.
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
          apiKey: {
            type: "string",
            description:
              "A Retell key for new agents. It may be omitted only when every watch entry names an existing agent that already stores its monitoring key.",
          },
          watch: arrayOf(watchRequest),
        },
        required: ["agentPlatform", "watch"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description:
          "What each ticked platform agent turned out to be: the ones now " +
          "pulling their production calls, and the ones refused.",
        schema: {
          type: "object",
          properties: {
            watching: arrayOf(watched),
            refused: arrayOf(refusedWatch),
          },
          required: ["watching", "refused"],
          additionalProperties: false,
        },
      },
      // No 404 and no 409: a request naming at least one platform agent is
      // answered per entry, and an entry that could not start is a row in
      // `refused` rather than the whole request failing.
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),

  /**
   * Disable production pull while retaining evidence, the platform binding,
   * and the monitoring key. Restarting creates a new observation window;
   * it does not backfill the period while pull was disabled.
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
} as const;
