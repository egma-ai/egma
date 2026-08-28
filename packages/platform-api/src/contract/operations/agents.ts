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

const agent = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    name: { type: "string" },
    agentPlatform: {
      type: "string",
      enum: ["retell", "livekit"],
    },
    platformAgentId: nullable({ type: "string" }),
    retellModality: nullable({ type: "string", enum: ["voice", "chat"] }),
    monitoringKeyPresent: { type: "boolean" },
    monitoringApiKeyHint: nullable({ type: "string" }),
    pullProductionCalls: { type: "boolean" },
    /**
     * The tick: every simulation against this agent runs in a mocked world.
     *
     * Standing consent. Egma creates a temporary version of the agent on its
     * platform at the start of each run, points every tool it can intercept at
     * its own mock endpoint, deletes the version when the run ends, and — where
     * a telephone number follows the platform's `latest` pointer — pins that
     * number to the version it already resolves to for the length of the run
     * and puts the binding back afterwards. It can only be on for an agent that
     * has its platform identity and key.
     */
    mockToolsDuringSimulations: { type: "boolean" },
    /** Whether pull monitoring has ever been started for this agent. */
    monitoringConfigured: { type: "boolean" },
    /**
     * When a production call last arrived for this agent, or null while none
     * has. A bare fact and never a condition: the agent says whether it pulls
     * and when it last received, and there is no health word anywhere near it
     * (ADR-0015, ruling 6).
     */
    lastReceivedAt: nullable(dateTimeSchema),
    archived: { type: "boolean" },
    archivedAt: nullable(dateTimeSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "name",
    "agentPlatform",
    "platformAgentId",
    "retellModality",
    "monitoringKeyPresent",
    "monitoringApiKeyHint",
    "pullProductionCalls",
    "mockToolsDuringSimulations",
    "monitoringConfigured",
    "lastReceivedAt",
    "archived",
    "archivedAt",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const connection = {
  type: "object",
  properties: {
    id: stringIdSchema,
    agentId: stringIdSchema,
    projectId: stringIdSchema,
    name: { type: "string" },
    agentPlatform: {
      type: "string",
      enum: ["retell", "livekit"],
    },
    connectionType: {
      type: "string",
      enum: [
        "retell_chat_api",
        "retell_web_call",
        "phone_number",
        "livekit_room",
      ],
    },
    accessVariant: {
      type: "string",
      enum: [
        "retell_chat_api.api_key",
        "retell_web_call.api_key",
        "phone_number.public_e164",
        "livekit_room.project_credentials",
        "livekit_room.customer_token_endpoint",
      ],
    },
    modality: { type: "string", enum: ["voice", "chat"] },
    productLabel: { type: "string" },
    topology: {
      type: "string",
      enum: ["agent-dials-out", "hosted-broker", "egma-dials-in"],
    },
    environment: nullable({ type: "string" }),
    config: { type: "object", additionalProperties: { type: "string" } },
    credentialPresent: { type: "boolean" },
    credentialsHint: nullable({ type: "string" }),
    archived: { type: "boolean" },
    archivedAt: nullable(dateTimeSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "agentId",
    "projectId",
    "name",
    "agentPlatform",
    "connectionType",
    "accessVariant",
    "modality",
    "productLabel",
    "topology",
    "environment",
    "config",
    "credentialPresent",
    "credentialsHint",
    "archived",
    "archivedAt",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const listedAgent = {
  ...agent,
  properties: {
    ...agent.properties,
    connections: arrayOf(connection),
  },
  required: [...agent.required, "connections"],
} as const;

/**
 * The external agent chosen through `agents:discover`, in the older envelope.
 *
 * **Superseded by `platformAgentId` beside `credentials`** (the founder's
 * ruling of 2026-08-24): a connect request names the picked agent directly,
 * and Egma confirms it with the key it was given or with the key already
 * sealed on the agent. The envelope stays accepted so existing API and CLI
 * callers keep working; it is read as exactly those two fields and nothing
 * else, so there is one path underneath and not two.
 */
const agentPlatformSelection = {
  type: "object",
  description:
    "Superseded by platformAgentId beside credentials, and still accepted. Egma revalidates the selected provider agent and route during creation, then discards this object.",
  properties: {
    platformAgentId: { type: "string" },
    credentials: {
      type: "object",
      properties: { apiKey: { type: "string" } },
      required: ["apiKey"],
      additionalProperties: false,
    },
  },
  required: ["platformAgentId", "credentials"],
  additionalProperties: false,
} as const;

const connectionInput = {
  type: "object",
  properties: {
    name: { type: "string" },
    agentPlatform: nullable({
      type: "string",
      enum: ["retell", "livekit"],
    }),
    connectionType: {
      type: "string",
      enum: [
        "retell_chat_api",
        "retell_web_call",
        "phone_number",
        "livekit_room",
      ],
    },
    accessVariant: {
      type: "string",
      enum: [
        "retell_chat_api.api_key",
        "retell_web_call.api_key",
        "phone_number.public_e164",
        "livekit_room.project_credentials",
        "livekit_room.customer_token_endpoint",
      ],
    },
    modality: { type: "string", enum: ["voice", "chat"] },
    environment: { type: "string" },
    config: { type: "object", additionalProperties: true },
    credentials: { type: "object", additionalProperties: true },
    platformAgentId: {
      type: "string",
      description:
        "The platform's own id for the agent this connection reaches, as " +
        "agents:discover listed it. Required for a Retell phone connection. " +
        "Egma confirms it against Retell with the key in credentials, or with " +
        "the key already sealed on the agent, immediately before the " +
        "connection is written, so a number that has stopped answering for " +
        "that agent is refused rather than stored. One Egma agent binds to " +
        "one platform agent: a second, different one is refused by name.",
    },
    pullProductionCalls: {
      type: "boolean",
      description:
        "Start pulling this agent's production calls with the same save. Off " +
        "unless the request says otherwise; the first switch-on imports the " +
        "fixed 30-day history.",
    },
    agentPlatformSelection,
  },
  required: ["agentPlatform", "connectionType", "accessVariant", "modality"],
  additionalProperties: false,
} as const;

const agentParams = parameters({ agentId: stringIdSchema }, ["agentId"]);
const connectionParams = parameters(
  { agentId: stringIdSchema, connectionId: stringIdSchema },
  ["agentId", "connectionId"],
);
const projectQuery = parameters({ projectId: stringIdSchema });
const agentReadQuery = parameters({
  projectId: stringIdSchema,
  archived: { type: "boolean" },
});
const listAgentsQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  search: { type: "string" },
  archived: { type: "boolean" },
  pageSize: { type: "integer", minimum: 1, maximum: 200 },
});

const connectionEnvelope = {
  type: "object",
  properties: { connection },
  required: ["connection"],
  additionalProperties: false,
} as const;

const agentEnvelope = {
  type: "object",
  properties: { agent },
  required: ["agent"],
  additionalProperties: false,
} as const;

const mutatingRefusals = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  404: refusalResponse,
  409: refusalResponse,
  422: refusalResponse,
  429: rateLimitResponse,
  503: refusalResponse,
} as const;

export const agentOperations = {
  discoverAgents: defineOperation({
    operationId: "discoverAgents",
    method: "POST",
    path: "/v1/agents:discover",
    summary: "Discover agents on an agent platform",
    tag: "Agents",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          agentPlatform: { type: "string", enum: ["retell"] },
          credentials: {
            type: "object",
            properties: { apiKey: { type: "string" } },
            required: ["apiKey"],
            additionalProperties: false,
          },
          /**
           * Read the account with the key already sealed on this agent,
           * rather than a pasted one. A key is asked for once per agent,
           * ever, so every later listing for the same agent spends the copy
           * Egma holds — plaintext that never leaves the server.
           */
          agentId: stringIdSchema,
        },
        required: ["agentPlatform"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "The agents and supported simulation connection candidates.",
        schema: {
          type: "object",
          properties: {
            agents: arrayOf({
              type: "object",
              properties: {
                platformAgentId: { type: "string" },
                name: { type: "string" },
                modality: {
                  type: "string",
                  enum: ["chat", "voice"],
                  description:
                    "The modality Retell reports for this agent, including when no supported connection candidate is available yet.",
                },
                connectionCandidates: arrayOf({
                  type: "object",
                  properties: {
                    agentPlatform: { type: "string", enum: ["retell"] },
                    connectionType: {
                      type: "string",
                      enum: [
                        "retell_chat_api",
                        "retell_web_call",
                        "phone_number",
                      ],
                    },
                    accessVariant: {
                      type: "string",
                      enum: [
                        "retell_chat_api.api_key",
                        "retell_web_call.api_key",
                        "phone_number.public_e164",
                      ],
                    },
                    modality: { type: "string", enum: ["chat", "voice"] },
                    productLabel: { type: "string" },
                    config: {
                      type: "object",
                      additionalProperties: { type: "string" },
                    },
                  },
                  required: [
                    "agentPlatform",
                    "connectionType",
                    "accessVariant",
                    "modality",
                    "productLabel",
                    "config",
                  ],
                  additionalProperties: false,
                }),
              },
              required: [
                "platformAgentId",
                "name",
                "modality",
                "connectionCandidates",
              ],
              additionalProperties: false,
            }),
          },
          required: ["agents"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),

  listConnectionOptions: defineOperation({
    operationId: "listConnectionOptions",
    method: "GET",
    path: "/v1/connection-options",
    summary: "List supported connection options",
    tag: "Connections",
    security: "credentialed",
    responses: {
      200: {
        description: "The server-owned connection option catalog.",
        schema: {
          type: "object",
          properties: {
            items: arrayOf({
              type: "object",
              properties: {
                agentPlatform: nullable({
                  type: "string",
                  enum: ["retell", "livekit"],
                }),
                agentPlatformLabel: { type: "string" },
                connectionType: {
                  type: "string",
                  enum: [
                    "retell_chat_api",
                    "retell_web_call",
                    "phone_number",
                    "livekit_room",
                  ],
                },
                accessVariant: {
                  type: "string",
                  enum: [
                    "retell_chat_api.api_key",
                    "retell_web_call.api_key",
                    "phone_number.public_e164",
                    "livekit_room.project_credentials",
                    "livekit_room.customer_token_endpoint",
                  ],
                },
                accessVariantLabel: { type: "string" },
                modality: { type: "string", enum: ["voice", "chat"] },
                productLabel: { type: "string" },
                topology: {
                  type: "string",
                  enum: ["agent-dials-out", "hosted-broker", "egma-dials-in"],
                },
                simulatorAdapter: { type: "boolean" },
                fields: arrayOf({
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["text", "url", "e164", "json"] },
                    required: { type: "boolean" },
                    help: { type: "string" },
                    afterCredentials: { type: "boolean" },
                  },
                  required: ["key", "label", "kind", "required", "help", "afterCredentials"],
                  additionalProperties: false,
                }),
                credentialRule: {
                  type: "string",
                  enum: ["required", "forbidden", "optional"],
                },
                credentialHelp: { type: "string" },
                credentialFields: arrayOf({
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["secret", "json"] },
                    required: { type: "boolean" },
                    help: { type: "string" },
                  },
                  required: ["field", "label", "kind", "required", "help"],
                  additionalProperties: false,
                }),
              },
              required: [
                "agentPlatform",
                "agentPlatformLabel",
                "connectionType",
                "accessVariant",
                "accessVariantLabel",
                "modality",
                "productLabel",
                "topology",
                "simulatorAdapter",
                "fields",
                "credentialRule",
                "credentialHelp",
                "credentialFields",
              ],
              additionalProperties: false,
            }),
          },
          required: ["items"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  registerAgent: defineOperation({
    operationId: "registerAgent",
    method: "POST",
    path: "/v1/agents",
    summary: "Register an agent",
    tag: "Agents",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          agentPlatform: {
            type: "string",
            enum: ["retell", "livekit"],
          },
          connection: connectionInput,
        },
        required: ["name", "agentPlatform"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "An existing agent reused by the registration.",
        schema: {
          type: "object",
          properties: {
            result: {
              type: "string",
              enum: ["reused"],
            },
            agent,
            connection,
          },
          required: ["result", "agent", "connection"],
          additionalProperties: false,
        },
      },
      201: {
        description: "An agent or connection created by the registration.",
        schema: {
          type: "object",
          properties: {
            result: {
              type: "string",
              enum: ["created", "connection_added"],
            },
            agent,
            connection,
          },
          required: ["result", "agent"],
          additionalProperties: false,
        },
      },
      ...mutatingRefusals,
    },
  }),

  listAgents: defineOperation({
    operationId: "listAgents",
    method: "GET",
    path: "/v1/agents",
    summary: "List agents",
    tag: "Agents",
    security: "credentialed",
    request: { query: listAgentsQuery },
    responses: {
      200: {
        description: "One page of agents and their active connections.",
        schema: {
          type: "object",
          properties: {
            agents: arrayOf(listedAgent),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["agents", "nextPageToken"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  getAgent: defineOperation({
    operationId: "getAgent",
    method: "GET",
    path: "/v1/agents/{agentId}",
    summary: "Get an agent",
    tag: "Agents",
    security: "credentialed",
    request: { params: agentParams, query: agentReadQuery },
    responses: {
      200: {
        description: "The agent and the requested set of connections.",
        schema: {
          type: "object",
          properties: { agent, connections: arrayOf(connection) },
          required: ["agent", "connections"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  addConnection: defineOperation({
    operationId: "addConnection",
    method: "POST",
    path: "/v1/agents/{agentId}/connections",
    summary: "Add an agent connection",
    tag: "Connections",
    security: "credentialed",
    request: { params: agentParams, query: projectQuery, body: connectionInput },
    responses: {
      201: { description: "The new connection.", schema: connectionEnvelope },
      ...mutatingRefusals,
    },
  }),

  updateAgent: defineOperation({
    operationId: "updateAgent",
    method: "PATCH",
    path: "/v1/agents/{agentId}",
    summary: "Update an agent",
    tag: "Agents",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          mockToolsDuringSimulations: {
            type: "boolean",
            description:
              "Turn the mocked world on or off for every simulation against " +
              "this agent. Refused for an agent with no platform identity and " +
              "key, because Egma builds the world by creating a temporary " +
              "version of the agent on its platform and would have nothing to " +
              "create one with. Absent leaves it as it is. Turning it on runs " +
              "discovery first and is refused with its reason where the agent " +
              "cannot be mocked; it also seeds a mock tool, with a " +
              "deterministic default answer, for every tool Egma can " +
              "intercept and does not already answer for.",
          },
          pinNumbersDuringRuns: {
            type: "boolean",
            description:
              "Consent to Egma pinning a telephone number that follows the " +
              "platform's `latest` pointer to the version it already resolves " +
              "to, for the length of each run, and putting the binding back " +
              "afterwards. Required only when such a number routes to this " +
              "agent: without it, branching a temporary version would send " +
              "real callers to it the instant it exists. Sending false, or " +
              "leaving it out where it is needed, refuses the tick with the " +
              "reason — a box promising isolation never quietly runs real " +
              "tools.",
          },
        },
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated agent.", schema: agentEnvelope },
      ...mutatingRefusals,
    },
  }),

  /**
   * What ticking the box would find, and — when asked — what it seeds.
   *
   * The consent screen's whole read: which response engine the agent runs on,
   * every tool in its three honest classes, the answer Egma would seed for each
   * one it can stand in front of, the tools that act outside the call and will
   * really act, and every telephone number's binding with what Egma would do
   * about it. It also carries the refusal, where there is one, so a person
   * reads *why* the tick is unavailable rather than finding a disabled control.
   *
   * `seed` is the re-discovery: it adds a mock tool for every interceptable
   * tool this project does not already answer for, and never overwrites an
   * authored answer.
   */
  discoverMockTools: defineOperation({
    operationId: "discoverMockTools",
    method: "POST",
    path: "/v1/agents/{agentId}/mock-tools:discover",
    summary: "Discover the tools a mocked run would stand in front of",
    tag: "Agents",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          seed: {
            type: "boolean",
            description:
              "Also seed a mock tool for every interceptable tool this " +
              "project does not answer for yet. Never overwrites an authored " +
              "answer: a known name keeps its row. Absent is a read.",
          },
        },
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "What a mocked run over this agent would cover.",
        schema: {
          type: "object",
          properties: {
            /**
             * Whether anything about this agent stops mocking outright. False
             * carries a `refusal` naming which reason it is.
             *
             * True is not by itself permission to turn the tick on: a number
             * riding the platform's `latest` pointer still has to be consented
             * to, and `numbers` below is where that question is read from. This
             * read deliberately does not refuse for it — refusing here would
             * hide the very numbers the question is about — and the tick itself
             * refuses without an answer.
             */
            mockable: { type: "boolean" },
            refusal: nullable({
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  enum: [
                    "custom_llm_engine",
                    "pin_consent_required",
                    "phone_only_agent",
                    "keys_disagree",
                    "platform_unavailable",
                  ],
                },
                message: { type: "string" },
              },
              required: ["reason", "message"],
              additionalProperties: false,
            }),
            engine: nullable({
              type: "string",
              enum: ["retell-llm", "conversation-flow", "custom-llm"],
            }),
            /** The version a mocked run would branch from, when it is known. */
            servingVersion: nullable({ type: "integer" }),
            tools: arrayOf({
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                coverage: {
                  type: "string",
                  enum: ["mocked", "notInterceptable", "notInThisVersion"],
                },
                /** Whether this project already answers for it. */
                answered: { type: "boolean" },
              },
              required: ["name", "type", "coverage", "answered"],
              additionalProperties: false,
            }),
            warnings: arrayOf({
              type: "object",
              properties: {
                toolName: { type: "string" },
                toolType: { type: "string" },
                effect: { type: "string" },
              },
              required: ["toolName", "toolType", "effect"],
              additionalProperties: false,
            }),
            numbers: arrayOf({
              type: "object",
              properties: {
                number: { type: "string" },
                label: { type: "string" },
                verdicts: arrayOf({
                  type: "string",
                  enum: [
                    "numeric",
                    "environment-tag",
                    "latest-published",
                    "hijackable",
                  ],
                }),
                pin: { type: "boolean" },
              },
              required: ["number", "label", "verdicts", "pin"],
              additionalProperties: false,
            }),
            /** The tool names seeded by this request. Empty on a read. */
            seeded: arrayOf({ type: "string" }),
          },
          required: [
            "mockable",
            "refusal",
            "engine",
            "servingVersion",
            "tools",
            "warnings",
            "numbers",
            "seeded",
          ],
          additionalProperties: false,
        },
      },
      ...mutatingRefusals,
    },
  }),

  archiveAgent: defineOperation({
    operationId: "archiveAgent",
    method: "POST",
    path: "/v1/agents/{agentId}/archive",
    summary: "Archive an agent",
    tag: "Agents",
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
        description: "The archived agent and the work stopped with it.",
        schema: {
          type: "object",
          properties: {
            agent,
            archivedConnections: arrayOf(stringIdSchema),
            canceledRunCount: { type: "integer", minimum: 0 },
          },
          required: ["agent", "archivedConnections", "canceledRunCount"],
          additionalProperties: false,
        },
      },
      ...mutatingRefusals,
    },
  }),

  restoreAgent: defineOperation({
    operationId: "restoreAgent",
    method: "POST",
    path: "/v1/agents/{agentId}/restore",
    summary: "Restore an agent",
    tag: "Agents",
    security: "credentialed",
    request: {
      params: agentParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      bodyRequired: false,
    },
    responses: {
      200: { description: "The restored agent.", schema: agentEnvelope },
      ...mutatingRefusals,
    },
  }),

  getConnection: defineOperation({
    operationId: "getConnection",
    method: "GET",
    path: "/v1/agents/{agentId}/connections/{connectionId}",
    summary: "Get an agent connection",
    tag: "Connections",
    security: "credentialed",
    request: { params: connectionParams, query: projectQuery },
    responses: {
      200: { description: "The connection.", schema: connectionEnvelope },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateConnection: defineOperation({
    operationId: "updateConnection",
    method: "PATCH",
    path: "/v1/agents/{agentId}/connections/{connectionId}",
    summary: "Update an agent connection",
    tag: "Connections",
    security: "credentialed",
    request: {
      params: connectionParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          environment: nullable({ type: "string" }),
          config: { type: "object", additionalProperties: true },
          credentials: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated connection.", schema: connectionEnvelope },
      ...mutatingRefusals,
    },
  }),

  archiveConnection: defineOperation({
    operationId: "archiveConnection",
    method: "POST",
    path: "/v1/agents/{agentId}/connections/{connectionId}/archive",
    summary: "Archive an agent connection",
    tag: "Connections",
    security: "credentialed",
    request: {
      params: connectionParams,
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
        description: "The archived connection and the runs stopped with it.",
        schema: {
          type: "object",
          properties: {
            connection,
            canceledRunCount: { type: "integer", minimum: 0 },
          },
          required: ["connection", "canceledRunCount"],
          additionalProperties: false,
        },
      },
      ...mutatingRefusals,
    },
  }),

  restoreConnection: defineOperation({
    operationId: "restoreConnection",
    method: "POST",
    path: "/v1/agents/{agentId}/connections/{connectionId}/restore",
    summary: "Restore an agent connection",
    tag: "Connections",
    security: "credentialed",
    request: {
      params: connectionParams,
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          credential: {
            oneOf: [
              {
                type: "object",
                properties: {
                  choice: { const: "replace" },
                  credentials: { type: "object", additionalProperties: true },
                },
                required: ["choice", "credentials"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { choice: { const: "clear" } },
                required: ["choice"],
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      },
      bodyRequired: false,
    },
    responses: {
      200: { description: "The restored connection.", schema: connectionEnvelope },
      ...mutatingRefusals,
    },
  }),

} as const;
