import { defineOperation } from "../definition.ts";
import {
  dateTimeSchema,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const organization = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
    slug: { type: "string" },
    createdAt: dateTimeSchema,
    mayManageOrganization: { type: "boolean" },
  },
  required: ["id", "name", "slug", "createdAt", "mayManageOrganization"],
  additionalProperties: false,
} as const;

export const organizationOperations = {
  getOrganization: defineOperation({
    operationId: "getOrganization",
    method: "GET",
    path: "/v1/organization",
    summary: "Get the requester's organization",
    tag: "Organization",
    security: "credentialed",
    responses: {
      200: { description: "The requester's organization.", schema: organization },
      401: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateOrganization: defineOperation({
    operationId: "updateOrganization",
    method: "PATCH",
    path: "/v1/organization",
    summary: "Update the requester's organization",
    tag: "Organization",
    security: "credentialed",
    request: {
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The updated organization.", schema: organization },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
