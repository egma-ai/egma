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
    parameterValues: {
      type: "object", additionalProperties: true,
      description: "The model or numeric settings used for this grading attempt. Retained for successful and errored grades, including after temporary jobs are removed. Contains no credentials.",
    },
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
  grades: {
    ...arrayOf(gradeSchema),
    description: "The current result for each selected grader. Each grade has its own score, frozen threshold, result, and supporting details.",
  },
  gradeHistory: {
    ...arrayOf(gradeSchema),
    description: "Recorded grade results, including previous grading attempts. Regrading preserves this history.",
  },
  combinedScore: {
    ...nullable(normalizedScoreSchema),
    description: "Display-only arithmetic mean when every selected grader has a current score. Null while a required score is missing or errored. This is not an overall pass/fail result.",
  },
} as const;

export const gradeProjectionRequired = [
  "grades",
  "gradeHistory",
  "combinedScore",
] as const;
