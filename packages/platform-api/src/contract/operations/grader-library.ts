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

const libraryEntry = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    type: { type: "string", enum: ["llm_as_judge", "code"] },
    owner: { type: "string", enum: ["egma", "customer"] },
    projectId: nullable(stringIdSchema),
    scopeEditable: { type: "boolean" },
    currentDefinitionVersion: { type: "integer", minimum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "name",
    "description",
    "type",
    "owner",
    "projectId",
    "scopeEditable",
    "currentDefinitionVersion",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

export const graderLibraryOperations = {
  listGraderLibrary: defineOperation({
    operationId: "listGraderLibrary",
    method: "GET",
    path: "/v1/grader-library",
    summary: "List grader library entries",
    tag: "Graders",
    security: "credentialed",
    request: {
      query: parameters({
        projectId: stringIdSchema,
        pageToken: stringIdSchema,
      }),
    },
    responses: {
      200: {
        description: "Grader library entries.",
        schema: {
          type: "object",
          properties: {
            graderLibraryEntries: arrayOf(libraryEntry),
            nextPageToken: nullable(stringIdSchema),
          },
          required: ["graderLibraryEntries", "nextPageToken"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      429: rateLimitResponse,
    },
  }),
} as const;
