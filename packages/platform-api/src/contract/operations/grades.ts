import {
  arrayOf,
  dateTimeSchema,
  nullable,
  stringIdSchema,
} from "../schemas.ts";

const stringSchema = { type: "string" } as const;

export const normalizedScoreSchema = {
  type: "number",
  minimum: 0,
  maximum: 1,
} as const;

export const gradingStateSchema = {
  type: "string",
  enum: ["not_requested", "pending", "running", "complete", "error"],
} as const;

const assertionDetailsSchema = {
  type: "object",
  properties: {
    key: stringSchema,
    score: normalizedScoreSchema,
    rationale: stringSchema,
    citedSpanIds: arrayOf(stringSchema),
    error: stringSchema,
  },
  required: ["key"],
  additionalProperties: false,
} as const;

const gradeDetailsSchema = {
  type: "object",
  properties: {
    rationale: stringSchema,
    assertions: arrayOf(assertionDetailsSchema),
    error: stringSchema,
  },
  // Definition versions may add details under their declared output contract.
  additionalProperties: true,
} as const;

export const gradeSchema = {
  type: "object",
  properties: {
    projectGraderId: stringIdSchema,
    graderDefinitionId: stringIdSchema,
    graderDefinitionVersion: { type: "integer", minimum: 1 },
    graderName: stringSchema,
    score: nullable(normalizedScoreSchema),
    details: gradeDetailsSchema,
    passThreshold: normalizedScoreSchema,
    result: {
      type: "string",
      enum: ["passed", "failed", "errored"],
    },
    gradedAt: dateTimeSchema,
  },
  required: [
    "projectGraderId",
    "graderDefinitionId",
    "graderDefinitionVersion",
    "graderName",
    "score",
    "details",
    "passThreshold",
    "result",
    "gradedAt",
  ],
  additionalProperties: false,
} as const;

export const gradeProjectionProperties = {
  grades: arrayOf(gradeSchema),
  gradeHistory: arrayOf(gradeSchema),
  combinedScore: nullable(normalizedScoreSchema),
} as const;

export const gradeProjectionRequired = [
  "grades",
  "gradeHistory",
  "combinedScore",
] as const;
