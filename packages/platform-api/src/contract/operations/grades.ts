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
    decision: { type: "string", enum: ["met", "not_met", "cannot_determine"] },
    score: normalizedScoreSchema,
    rationale: stringSchema,
    citedSpanIds: arrayOf(stringSchema),
    citedTurns: arrayOf({ type: "integer", minimum: 1 }),
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
  // Executors may retain additional details in the stable result envelope.
  additionalProperties: true,
} as const;

export const gradeSchema = {
  type: "object",
  properties: {
    projectGraderId: stringIdSchema,
    graderDefinitionId: stringIdSchema,
    graderDefinitionVersion: { type: "integer", minimum: 1 },
    parameterValues: { type: "object", additionalProperties: true },
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
    "parameterValues",
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
