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
   * Start pulling production calls, for one platform agent or several at once.
   *
   * One commit does the whole of it: the key is sealed onto every agent it
   * names, each switch is flipped, and each notebook opens with the 30-day
   * historical window. An agent row is created for a platform agent this
   * project does not register yet, because watching one *means* registering it.
   *
   * **Every entry is attempted and every entry is answered.** A tick that
   * would put two switched-on agents on one platform agent comes back in
   * `refused` with a sentence naming the agent already watching it, and the
   * ticks beside it still start. The refusal is the database's own
   * uniqueness answer, caught — a check before the write would be a race
   * with the very next request.
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
   * Stop pulling one agent's production calls.
   *
   * Everything stored stays stored: the transcripts, the agent's binding, its
   * sealed key, and its machine row. The switch is what makes an agent due, so
   * turning it off is the whole of stopping.
   *
   * Turning it back on starts a new observation from that moment; it does not
   * go back for what arrived while the switch was off. No cursor crosses the
   * gap — the row survives so a later start can bump its generation and set
   * its floor, not so it can resume a window.
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
