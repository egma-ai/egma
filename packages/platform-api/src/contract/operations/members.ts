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

const role = { type: "string", enum: ["admin", "member", "viewer"] } as const;

const member = {
  type: "object",
  properties: {
    userId: stringIdSchema,
    email: { type: "string" },
    name: nullable({ type: "string" }),
    role,
    joinedAt: dateTimeSchema,
    deactivatedAt: nullable(dateTimeSchema),
  },
  required: ["userId", "email", "name", "role", "joinedAt", "deactivatedAt"],
  additionalProperties: false,
} as const;

const invitation = {
  type: "object",
  properties: {
    id: stringIdSchema,
    email: { type: "string" },
    role,
    expiresAt: dateTimeSchema,
    createdBy: nullable(stringIdSchema),
    createdAt: dateTimeSchema,
  },
  required: ["id", "email", "role", "expiresAt", "createdBy", "createdAt"],
  additionalProperties: false,
} as const;

const memberParams = parameters({ userId: stringIdSchema }, ["userId"]);

export const memberOperations = {
  listMembers: defineOperation({
    operationId: "listMembers",
    method: "GET",
    path: "/v1/members",
    summary: "List organization members",
    tag: "Members",
    security: "credentialed",
    responses: {
      200: {
        description: "The organization's members.",
        schema: {
          type: "object",
          properties: {
            members: arrayOf(member),
            mayManageMembers: { type: "boolean" },
          },
          required: ["members", "mayManageMembers"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  listInvitations: defineOperation({
    operationId: "listInvitations",
    method: "GET",
    path: "/v1/invitations",
    summary: "List pending invitations",
    tag: "Members",
    security: "credentialed",
    responses: {
      200: {
        description: "Pending invitations.",
        schema: {
          type: "object",
          properties: { invitations: arrayOf(invitation) },
          required: ["invitations"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  createInvitation: defineOperation({
    operationId: "createInvitation",
    method: "POST",
    path: "/v1/invitations",
    summary: "Invite an organization member",
    tag: "Members",
    security: "credentialed",
    request: {
      body: {
        type: "object",
        properties: { email: { type: "string" }, role },
        required: ["email"],
        additionalProperties: false,
      },
    },
    responses: {
      201: {
        description: "The new invitation.",
        headers: {
          "Cache-Control": {
            description: "Prevents storage of the invitation acceptance URL.",
            schema: { type: "string", const: "no-store" },
          },
        },
        schema: {
          ...invitation,
          properties: {
            ...invitation.properties,
            delivered: { type: "boolean" },
            acceptUrl: { type: "string", format: "uri" },
          },
          required: [...invitation.required, "delivered"],
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      409: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  changeMemberRole: defineOperation({
    operationId: "changeMemberRole",
    method: "POST",
    path: "/v1/members/{userId}/role",
    summary: "Change a member role",
    tag: "Members",
    security: "credentialed",
    request: {
      params: memberParams,
      body: {
        type: "object",
        properties: { role },
        required: ["role"],
        additionalProperties: false,
      },
    },
    responses: {
      200: { description: "The changed member.", schema: member },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  removeMember: defineOperation({
    operationId: "removeMember",
    method: "POST",
    path: "/v1/members/{userId}/remove",
    summary: "Remove an organization member",
    tag: "Members",
    security: "credentialed",
    request: { params: memberParams },
    responses: {
      200: {
        description: "The removed member and revoked key count.",
        schema: {
          type: "object",
          properties: {
            userId: stringIdSchema,
            keysRevoked: { type: "integer", minimum: 0 },
          },
          required: ["userId", "keysRevoked"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  deactivateMember: defineOperation({
    operationId: "deactivateMember",
    method: "POST",
    path: "/v1/members/{userId}/deactivate",
    summary: "Deactivate a member account",
    tag: "Members",
    security: "credentialed",
    request: { params: memberParams },
    responses: {
      200: { description: "The deactivated member.", schema: member },
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
