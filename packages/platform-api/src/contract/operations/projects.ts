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

const project = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
    slug: { type: "string" },
    description: nullable({ type: "string" }),
    organizationId: stringIdSchema,
    revision: stringIdSchema,
    createdAt: dateTimeSchema,
  },
  required: [
    "id",
    "name",
    "slug",
    "description",
    "organizationId",
    "revision",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const projectWithPermission = {
  ...project,
  properties: {
    ...project.properties,
    mayManageProjects: { type: "boolean" },
  },
  required: [...project.required, "mayManageProjects"],
} as const;

const createProjectBody = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    description: nullable({ type: "string" }),
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const updateProjectBody = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    description: nullable({ type: "string" }),
    expectedRevision: stringIdSchema,
  },
  additionalProperties: false,
} as const;

const projectParams = parameters({ projectId: stringIdSchema }, ["projectId"]);

export const projectOperations = {
  listProjects: defineOperation({
    operationId: "listProjects",
    method: "GET",
    path: "/v1/projects",
    summary: "List projects",
    tag: "Projects",
    security: "credentialed",
    responses: {
      200: {
        description: "Every project in the requester's organization.",
        schema: {
          type: "object",
          properties: {
            projects: arrayOf(project),
            mayManageProjects: { type: "boolean" },
          },
          required: ["projects", "mayManageProjects"],
          additionalProperties: false,
        },
      },
      401: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  getProject: defineOperation({
    operationId: "getProject",
    method: "GET",
    path: "/v1/projects/{projectId}",
    summary: "Get a project",
    tag: "Projects",
    security: "credentialed",
    request: { params: projectParams },
    responses: {
      200: { description: "The project.", schema: projectWithPermission },
      401: refusalResponse,
      404: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  createProject: defineOperation({
    operationId: "createProject",
    method: "POST",
    path: "/v1/projects",
    summary: "Create a project",
    tag: "Projects",
    security: "credentialed",
    request: { body: createProjectBody },
    responses: {
      201: { description: "The new project.", schema: project },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),

  updateProject: defineOperation({
    operationId: "updateProject",
    method: "PATCH",
    path: "/v1/projects/{projectId}",
    summary: "Update a project",
    tag: "Projects",
    security: "credentialed",
    request: { params: projectParams, body: updateProjectBody },
    responses: {
      200: { description: "The updated project.", schema: project },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      409: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
