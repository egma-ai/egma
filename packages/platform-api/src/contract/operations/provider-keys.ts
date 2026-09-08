import { defineOperation } from "../definition.ts";
import {
  arrayOf,
  dateTimeSchema,
  nullable,
  parameters,
  refusalResponse,
  rateLimitResponse,
} from "../schemas.ts";
const provider = {
  type: "string",
  enum: ["openai", "deepgram", "cartesia"],
} as const;
const row = {
  type: "object",
  properties: {
    provider,
    label: { type: "string" },
    credential: nullable({
      type: "object",
      properties: {
        hint: { type: "string" },
        revision: { type: "string" },
        updatedAt: dateTimeSchema,
      },
      required: ["hint", "revision", "updatedAt"],
      additionalProperties: false,
    }),
  },
  required: ["provider", "label", "credential"],
  additionalProperties: false,
} as const;
const errors = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  409: refusalResponse,
  422: refusalResponse,
  429: rateLimitResponse,
};
export const providerKeyOperations = {
  listProviderKeys: defineOperation({
    operationId: "listProviderKeys",
    method: "GET",
    path: "/v1/provider-keys",
    summary: "List organization provider API keys",
    tag: "Provider API keys",
    security: "credentialed",
    responses: {
      200: {
        description: "Supported providers and masked credential metadata.",
        schema: {
          type: "object",
          properties: {
            providers: arrayOf(row),
            mayManageProviderKeys: { type: "boolean" },
          },
          required: ["providers", "mayManageProviderKeys"],
          additionalProperties: false,
        },
      },
      ...errors,
    },
  }),
  putProviderKey: defineOperation({
    operationId: "putProviderKey",
    method: "PUT",
    path: "/v1/provider-keys/{provider}",
    summary: "Add or replace an organization provider API key",
    tag: "Provider API keys",
    security: "credentialed",
    request: {
      params: parameters({ provider }, ["provider"]),
      body: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 8, maxLength: 4096 },
          expectedRevision: nullable({ type: "string" }),
        },
        required: ["key", "expectedRevision"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description:
          "The saved credential metadata. Secret values are never returned.",
        schema: row,
      },
      ...errors,
    },
  }),
  deleteProviderKey: defineOperation({
    operationId: "deleteProviderKey",
    method: "DELETE",
    path: "/v1/provider-keys/{provider}",
    summary: "Remove an organization provider API key",
    tag: "Provider API keys",
    security: "credentialed",
    request: {
      params: parameters({ provider }, ["provider"]),
      body: {
        type: "object",
        properties: { expectedRevision: { type: "string" } },
        required: ["expectedRevision"],
        additionalProperties: false,
      },
    },
    responses: {
      200: {
        description: "The provider with no saved credential.",
        schema: row,
      },
      ...errors,
    },
  }),
} as const;
