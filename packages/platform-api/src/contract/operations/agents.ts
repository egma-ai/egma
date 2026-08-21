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

const capabilityKey = {
  type: "string",
  enum: ["dtmf", "barge_in", "raw_audio"],
} as const;

const capabilities = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["unknown", "known"] },
    measured: nullable(arrayOf(capabilityKey)),
    supported: nullable(arrayOf(capabilityKey)),
    checkedAt: nullable(dateTimeSchema),
    source: nullable({ type: "string" }),
    standing: {
      type: "object",
      properties: {
        dtmf: {
          type: "string",
          enum: ["supported", "unsupported", "not_measured"],
        },
        barge_in: {
          type: "string",
          enum: ["supported", "unsupported", "not_measured"],
        },
        raw_audio: {
          type: "string",
          enum: ["supported", "unsupported", "not_measured"],
        },
      },
      required: ["dtmf", "barge_in", "raw_audio"],
      additionalProperties: false,
    },
  },
  required: ["state", "measured", "supported", "checkedAt", "source", "standing"],
  additionalProperties: false,
} as const;

const agent = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    revision: stringIdSchema,
    archived: { type: "boolean" },
    archivedAt: nullable(dateTimeSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "name",
    "description",
    "revision",
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
    agentPlatform: nullable({
      type: "string",
      enum: ["retell", "livekit_agents"],
    }),
    connectionKind: {
      type: "string",
      enum: ["retell_chat_api", "phone_number", "livekit_room"],
    },
    accessVariant: {
      type: "string",
      enum: [
        "retell_chat_api.api_key",
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
    capabilities,
    revision: stringIdSchema,
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
    "connectionKind",
    "accessVariant",
    "modality",
    "productLabel",
    "topology",
    "environment",
    "config",
    "credentialPresent",
    "credentialsHint",
    "capabilities",
    "revision",
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
 * The external agent chosen through `agents:discover`.
 *
 * It exists only on the create request. The API rechecks it against the agent
 * platform immediately before the connection is written, then discards it.
 */
const agentPlatformSelection = {
  type: "object",
  description:
    "Required for a Retell phone connection. Egma revalidates the selected provider agent and route during creation, then discards this object.",
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
      enum: ["retell", "livekit_agents"],
    }),
    connectionKind: {
      type: "string",
      enum: ["retell_chat_api", "phone_number", "livekit_room"],
    },
    accessVariant: {
      type: "string",
      enum: [
        "retell_chat_api.api_key",
        "phone_number.public_e164",
        "livekit_room.project_credentials",
        "livekit_room.customer_token_endpoint",
      ],
    },
    modality: { type: "string", enum: ["voice", "chat"] },
    environment: { type: "string" },
    config: { type: "object", additionalProperties: true },
    credentials: { type: "object", additionalProperties: true },
    agentPlatformSelection,
  },
  required: ["agentPlatform", "connectionKind", "accessVariant", "modality"],
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
        },
        required: ["agentPlatform", "credentials"],
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
                connectionCandidates: arrayOf({
                  type: "object",
                  properties: {
                    agentPlatform: { type: "string", enum: ["retell"] },
                    connectionKind: {
                      type: "string",
                      enum: ["retell_chat_api", "phone_number"],
                    },
                    accessVariant: {
                      type: "string",
                      enum: [
                        "retell_chat_api.api_key",
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
                    "connectionKind",
                    "accessVariant",
                    "modality",
                    "productLabel",
                    "config",
                  ],
                  additionalProperties: false,
                }),
              },
              required: ["platformAgentId", "name", "connectionCandidates"],
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
      500: refusalResponse,
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
                  enum: ["retell", "livekit_agents"],
                }),
                agentPlatformLabel: { type: "string" },
                connectionKind: {
                  type: "string",
                  enum: ["retell_chat_api", "phone_number", "livekit_room"],
                },
                accessVariant: {
                  type: "string",
                  enum: [
                    "retell_chat_api.api_key",
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
                capabilityDiscovery: { type: "boolean" },
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
                "connectionKind",
                "accessVariant",
                "accessVariantLabel",
                "modality",
                "productLabel",
                "topology",
                "simulatorAdapter",
                "capabilityDiscovery",
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

  listCapabilities: defineOperation({
    operationId: "listCapabilities",
    method: "GET",
    path: "/v1/capabilities",
    summary: "List agent capabilities",
    tag: "Agents",
    security: "credentialed",
    responses: {
      200: {
        description: "The server-owned capability catalog.",
        schema: {
          type: "object",
          properties: {
            items: arrayOf({
              type: "object",
              properties: {
                key: capabilityKey,
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["key", "label", "description"],
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
          description: { type: "string" },
          connection: connectionInput,
        },
        required: ["name"],
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
          description: nullable({ type: "string" }),
          expectedRevision: stringIdSchema,
        },
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated agent.", schema: agentEnvelope },
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
        properties: { expectedRevision: stringIdSchema },
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
            canceledRuns: arrayOf(stringIdSchema),
          },
          required: ["agent", "archivedConnections", "canceledRuns"],
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
          expectedRevision: stringIdSchema,
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
          expectedRevision: stringIdSchema,
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
        properties: { expectedRevision: stringIdSchema },
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
            canceledRuns: arrayOf(stringIdSchema),
          },
          required: ["connection", "canceledRuns"],
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
          expectedRevision: stringIdSchema,
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

  refreshConnectionCapabilities: defineOperation({
    operationId: "refreshConnectionCapabilities",
    method: "POST",
    path: "/v1/agents/{agentId}/connections/{connectionId}/capabilities/refresh",
    summary: "Refresh connection capabilities",
    tag: "Connections",
    security: "credentialed",
    request: { params: connectionParams, query: projectQuery },
    responses: {
      200: { description: "The refreshed connection.", schema: connectionEnvelope },
      ...mutatingRefusals,
      502: refusalResponse,
    },
  }),
} as const;
