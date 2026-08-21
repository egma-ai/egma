import { defineOperation } from "../definition.ts";
import {
  anySchema,
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
    type: { type: "string" },
    owner: { type: "string", enum: ["egma", "organization"] },
    projectId: nullable(stringIdSchema),
    version: { type: "integer", minimum: 1 },
    prompt: nullable({ type: "string" }),
    params: arrayOf(anySchema),
    outputDefinition: anySchema,
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
    "version",
    "prompt",
    "params",
    "outputDefinition",
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
