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
        "retell_text_mode",
        "retell_web_call",
        "phone_number",
        "livekit_room",
      ],
    },
    accessVariant: {
      type: "string",
      enum: [
        "retell_chat_api.api_key",
        "retell_text_mode.api_key",
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
  description:
    "Choose one supported agentPlatform, connectionType, accessVariant, and modality from List supported connection options. " +
    "Its fields describe config and its credentialFields describe credentials. Egma validates the complete combination before saving it.",
  properties: {
    name: {
      type: "string",
      description: "Optional connection display name. If omitted, Egma chooses the next available numbered name.",
      examples: ["Staging voice"],
    },
    agentPlatform: nullable({
      type: "string",
      enum: ["retell", "livekit"],
      description: "The platform that runs the agent. It must be compatible with the selected connection type and agent.",
    }),
    connectionType: {
      type: "string",
      description: "Connection type from the options catalog. Retell text mode tests a voice agent through chat; a Retell web call uses voice. LiveKit room connections can use voice or chat.",
      enum: [
        "retell_chat_api",
        "retell_text_mode",
        "retell_web_call",
        "phone_number",
        "livekit_room",
      ],
    },
    accessVariant: {
      type: "string",
      description: "Credential method for the connection type, copied from the same catalog entry.",
      enum: [
        "retell_chat_api.api_key",
        "retell_text_mode.api_key",
        "retell_web_call.api_key",
        "phone_number.public_e164",
        "livekit_room.project_credentials",
        "livekit_room.customer_token_endpoint",
      ],
    },
    modality: {
      type: "string",
      enum: ["voice", "chat"],
      description: "How simulations communicate with the agent. Use a modality offered by the selected catalog entry.",
    },
    environment: {
      type: "string",
      description: "Optional label identifying the environment this connection reaches.",
      examples: ["staging"],
    },
    config: {
      type: "object",
      additionalProperties: true,
      description:
        "Non-secret settings for the selected access variant. Use only its catalog fields. " +
        "Retell API variants use retellAgentId; a Retell phone connection uses phoneNumber. " +
        "LiveKit project credentials use url and agentName. LiveKit token endpoints use tokenEndpoint and agentName; " +
        "tokenEndpoint must be a public HTTPS URL. agentName must match the name registered by your LiveKit worker. " +
        "When platformAgentId is supplied for a Retell API variant, Egma derives and confirms retellAgentId from that selection.",
      examples: [
        { retellAgentId: "agent_receptionist" },
        { url: "wss://example.livekit.cloud", agentName: "receptionist" },
        { tokenEndpoint: "https://voice.example.com/egma/token", agentName: "receptionist" },
      ],
    },
    credentials: {
      type: "object",
      additionalProperties: true,
      description:
        "Secret fields for the selected access variant. Retell uses apiKey. LiveKit project credentials use apiKey and apiSecret. " +
        "A LiveKit token endpoint requires headers: a JSON-encoded string containing a non-empty object of header names to string values. " +
        "For an additional Retell connection, platformAgentId can reuse the agent's saved Retell key when credentials are omitted. " +
        "For a Retell phone connection, the key confirms provider identity and is held on the agent; the phone connection itself stores no key. " +
        "Responses return credential presence and hints, never the secret values.",
      examples: [
        { apiKey: "YOUR_RETELL_API_KEY" },
        { apiKey: "YOUR_LIVEKIT_API_KEY", apiSecret: "YOUR_LIVEKIT_API_SECRET" },
        { headers: '{"Authorization":"Bearer YOUR_ENDPOINT_TOKEN"}' },
      ],
    },
    platformAgentId: {
      type: "string",
      description:
        "Retell's agent ID from Discover agents, not an Egma agent ID. Supply it with the selected candidate to confirm " +
        "the provider agent and save its identity on the Egma agent. Required for Retell phone connections. Egma uses " +
        "credentials.apiKey or the key already saved on that agent. A different Retell identity on the same Egma agent is refused. " +
        "Do not send this together with the older agentPlatformSelection field.",
      examples: ["agent_receptionist"],
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
  examples: [
    {
      name: "Retell chat",
      agentPlatform: "retell",
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      platformAgentId: "agent_receptionist",
      config: { retellAgentId: "agent_receptionist" },
      credentials: { apiKey: "YOUR_RETELL_API_KEY" },
    },
    {
      name: "LiveKit voice",
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://example.livekit.cloud", agentName: "receptionist" },
      credentials: { apiKey: "YOUR_LIVEKIT_API_KEY", apiSecret: "YOUR_LIVEKIT_API_SECRET" },
    },
    {
      name: "LiveKit token endpoint",
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: { tokenEndpoint: "https://voice.example.com/egma/token", agentName: "receptionist" },
      credentials: { headers: '{"Authorization":"Bearer YOUR_ENDPOINT_TOKEN"}' },
    },
  ],
} as const;

const agentParams = parameters({ agentId: {
  ...stringIdSchema,
  description: "The Egma agent ID returned by Register an agent or List agents.",
  examples: ["agt_01M0E4J0BBE1FVDVTZ1BSS5C97"],
} }, ["agentId"]);
const connectionParams = parameters(
  { agentId: stringIdSchema, connectionId: stringIdSchema },
  ["agentId", "connectionId"],
);
const projectQuery = parameters({ projectId: {
  ...stringIdSchema,
  description: "Project to act in. A project-scoped API key already identifies its project.",
} });
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
    description:
      "List the Retell agents visible to a provider API key and the connection candidates available for each. " +
      "Supply either credentials.apiKey or an existing Egma agentId whose saved Retell key should be used, never both. " +
      "This request does not register an agent or save a new credential. Choose a returned candidate, then use Register an agent " +
      "or Add an agent connection with its fields and platformAgentId. LiveKit uses List supported connection options instead of provider discovery.",
    tag: "Agents",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          agentPlatform: {
            type: "string",
            enum: ["retell"],
            description: "Provider to query. Agent discovery currently supports Retell.",
          },
          credentials: {
            type: "object",
            description: "Retell account credential for this discovery request. Omit it when using agentId to reuse a saved key.",
            properties: { apiKey: {
              type: "string",
              description: "Retell API key with access to the agents you want to list.",
              examples: ["YOUR_RETELL_API_KEY"],
            } },
            required: ["apiKey"],
            additionalProperties: false,
          },
          /**
           * Read the account with the key already sealed on this agent,
           * rather than a pasted one. A key is asked for once per agent,
           * ever, so every later listing for the same agent spends the copy
           * Egma holds — plaintext that never leaves the server.
           */
          agentId: {
            ...stringIdSchema,
            description: "Existing Egma agent whose stored Retell key should be used. Omit credentials when supplying this field.",
            examples: ["agt_01M0E4J0BBE1FVDVTZ1BSS5C97"],
          },
        },
        required: ["agentPlatform"],
        additionalProperties: false,
        examples: [
          { agentPlatform: "retell", credentials: { apiKey: "YOUR_RETELL_API_KEY" } },
          { agentPlatform: "retell", agentId: "agt_01M0E4J0BBE1FVDVTZ1BSS5C97" },
        ],
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
                        "retell_text_mode",
                        "retell_web_call",
                        "phone_number",
                      ],
                    },
                    accessVariant: {
                      type: "string",
                      enum: [
                        "retell_chat_api.api_key",
                        "retell_text_mode.api_key",
                        "retell_web_call.api_key",
                        "phone_number.public_e164",
                      ],
                    },
                    modality: { type: "string", enum: ["chat", "voice"] },
                    productLabel: { type: "string" },
                    config: {
                      type: "object",
                      additionalProperties: { type: "string" },
                      description: "Confirmed non-secret settings for this candidate. Copy these with its connection type, access variant, and modality when creating the connection.",
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
    description:
      "Read the connection catalog used by this Egma server. Each item is one supported platform, connection type, " +
      "access variant, and modality. Use fields to construct config and credentialFields to construct credentials " +
      "for Register an agent or Add an agent connection. The catalog does not check a provider account; use Discover agents " +
      "to obtain Retell identities and confirmed candidates. simulatorAdapter describes implementation support, " +
      "not whether this deployment's provider or carrier credentials are ready.",
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
                    "retell_text_mode",
                    "retell_web_call",
                    "phone_number",
                    "livekit_room",
                  ],
                },
                accessVariant: {
                  type: "string",
                  enum: [
                    "retell_chat_api.api_key",
                    "retell_text_mode.api_key",
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
                    key: { type: "string", description: "Property name to include in the connection request's config object." },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["text", "url", "e164", "json"] },
                    required: { type: "boolean", description: "Whether this config field must be supplied for the selected option." },
                    help: { type: "string" },
                    afterCredentials: { type: "boolean", description: "Whether provider credentials are needed before the setup flow can resolve choices for this field." },
                  },
                  required: ["key", "label", "kind", "required", "help", "afterCredentials"],
                  additionalProperties: false,
                }),
                credentialRule: {
                  type: "string",
                  enum: ["required", "forbidden", "optional"],
                  description: "Whether the connection stores credentials for this access variant. Retell phone setup can still need an agent-level provider key to confirm the phone route.",
                },
                credentialHelp: { type: "string" },
                credentialFields: arrayOf({
                  type: "object",
                  properties: {
                    field: { type: "string", description: "Property name in the connection request's credentials object." },
                    label: { type: "string" },
                    kind: { type: "string", enum: ["secret", "json"], description: "Input type. JSON credential values such as headers are encoded as strings containing JSON." },
                    required: { type: "boolean", description: "Whether this credential field is required for the selected option." },
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
    description:
      "Create an Egma agent identity in the selected project. Send name and agentPlatform for an agent without connections, " +
      "or include connection to configure its first simulation connection in the same request. " +
      "Registration with a connection can reuse the existing agent for the same provider identity and can add a new connection " +
      "to that agent. Inspect result: created, connection_added, or reused. Keep the returned agent.id and connection.id for run creation.",
    tag: "Agents",
    security: "credentialed",
    request: {
      query: projectQuery,
      body: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name for the agent in Egma.", examples: ["Receptionist"] },
          agentPlatform: {
            type: "string",
            enum: ["retell", "livekit"],
            description: "The product or framework that runs your agent.",
          },
          connection: connectionInput,
        },
        required: ["name", "agentPlatform"],
        additionalProperties: false,
        examples: [
          { name: "Receptionist", agentPlatform: "retell" },
          {
            name: "Receptionist",
            agentPlatform: "livekit",
            connection: {
              agentPlatform: "livekit",
              connectionType: "livekit_room",
              accessVariant: "livekit_room.project_credentials",
              modality: "voice",
              config: { url: "wss://example.livekit.cloud", agentName: "receptionist" },
              credentials: { apiKey: "YOUR_LIVEKIT_API_KEY", apiSecret: "YOUR_LIVEKIT_API_SECRET" },
            },
          },
        ],
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
    description:
      "Add a simulation connection to an existing Egma agent. Select its platform, connection type, access variant, " +
      "and modality from List supported connection options, then supply that option's config and credentials. " +
      "For Retell, include platformAgentId from discovery; Egma confirms the selection with the supplied or stored " +
      "Retell key before saving. For LiveKit, supply the exact worker dispatch name as config.agentName. " +
      "Use the returned connection.id with this agent's ID when creating a run.",
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
        properties: { name: { type: "string" } },
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
