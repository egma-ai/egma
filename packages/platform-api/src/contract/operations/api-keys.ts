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

const apiKey = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: nullable({ type: "string" }),
    scope: { type: "string", enum: ["organization", "project"] },
    organizationId: stringIdSchema,
    projectId: nullable(stringIdSchema),
    looksLike: { type: "string" },
    createdByUserId: stringIdSchema,
    createdAt: dateTimeSchema,
    lastUsedAt: nullable(dateTimeSchema),
    revokedAt: nullable(dateTimeSchema),
  },
  required: [
    "id",
    "name",
    "scope",
    "organizationId",
    "projectId",
    "looksLike",
    "createdByUserId",
    "createdAt",
    "lastUsedAt",
    "revokedAt",
  ],
  additionalProperties: false,
} as const;

const listedApiKey = {
  ...apiKey,
  properties: {
    ...apiKey.properties,
    createdByEmail: { type: "string" },
  },
  required: [...apiKey.required, "createdByEmail"],
} as const;

const apiKeyParams = parameters({ apiKeyId: stringIdSchema }, ["apiKeyId"]);

export const apiKeyOperations = {
  listApiKeys: defineOperation({
    operationId: "listApiKeys",
    method: "GET",
    path: "/v1/keys",
    summary: "List API keys",
    tag: "API keys",
    security: "credentialed",
    responses: {
      200: {
        description: "The API keys visible to the requester.",
        schema: {
          type: "object",
          properties: { keys: arrayOf(listedApiKey) },
          required: ["keys"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  createApiKey: defineOperation({
    operationId: "createApiKey",
    method: "POST",
    path: "/v1/keys",
    summary: "Create an API key",
    tag: "API keys",
    security: "credentialed",
    request: {
      body: {
        oneOf: [
          {
            type: "object",
            properties: {
              name: { type: "string" },
              projectId: nullable(stringIdSchema),
            },
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1 },
              projectId: stringIdSchema,
              monitoringAgentId: {
                ...stringIdSchema,
                description:
                  "The living LiveKit agent this worker key serves. Egma derives and reserves its key-name prefix on the server.",
              },
            },
            required: ["name", "projectId", "monitoringAgentId"],
            additionalProperties: false,
          },
        ],
      },
    },
    responses: {
      201: {
        description: "The new API key and its one-time secret.",
        headers: {
          "Cache-Control": {
            description: "Prevents storage of the one-time secret response.",
            schema: { type: "string", const: "no-store" },
          },
        },
        schema: {
          ...apiKey,
          properties: {
            ...apiKey.properties,
            secret: { type: "string" },
          },
          required: [...apiKey.required, "secret"],
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  revokeApiKey: defineOperation({
    operationId: "revokeApiKey",
    method: "POST",
    path: "/v1/keys/{apiKeyId}/revoke",
    summary: "Revoke an API key",
    tag: "API keys",
    security: "credentialed",
    request: { params: apiKeyParams },
    responses: {
      200: { description: "The revoked API key.", schema: apiKey },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
