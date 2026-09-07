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
