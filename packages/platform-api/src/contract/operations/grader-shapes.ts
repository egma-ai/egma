import { arrayOf, dateTimeSchema, nullable, stringIdSchema } from "../schemas.ts";

const stringSchema = { type: "string" } as const;
const booleanSchema = { type: "boolean" } as const;
const integerSchema = { type: "integer" } as const;

export const graderTypeSchema = {
  type: "string",
  enum: ["llm_as_judge", "code"],
} as const;

export const graderOwnerSchema = {
  type: "string",
  enum: ["egma", "organization"],
} as const;

export const graderModalitySchema = {
  type: "string",
  enum: ["chat", "voice"],
} as const;

export const graderModalitiesSchema = {
  type: "array",
  items: graderModalitySchema,
  minItems: 1,
  uniqueItems: true,
} as const;

const allSimulationSelectorSchema = {
  type: "object",
  properties: { kind: { type: "string", enum: ["all"] } },
  required: ["kind"],
  additionalProperties: false,
} as const;

const identifiedSimulationSelectorSchema = (
  kind: "test_suite" | "test",
) =>
  ({
    type: "object",
    properties: {
      kind: { type: "string", enum: [kind] },
      id: stringIdSchema,
    },
    required: ["kind", "id"],
    additionalProperties: false,
  }) as const;

export const graderScopeSchema = {
  type: "object",
  properties: {
    simulations: arrayOf({
      oneOf: [
        allSimulationSelectorSchema,
        identifiedSimulationSelectorSchema("test_suite"),
        identifiedSimulationSelectorSchema("test"),
      ],
    }),
    production: nullable({
      type: "object",
      properties: {
        samplePercent: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["samplePercent"],
      additionalProperties: false,
    }),
  },
  required: ["simulations", "production"],
  additionalProperties: false,
} as const;

/**
 * The small settings language the current product can render and validate.
 * It has one value type because Response latency is the one setting-bearing
 * grader in this release. A later real setting can extend the closed union.
 */
export const graderSettingDefinitionSchema = {
  type: "object",
  properties: {
    key: stringSchema,
    label: stringSchema,
    valueType: { type: "string", enum: ["integer"] },
    defaultValue: integerSchema,
    unit: nullable(stringSchema),
    minimum: nullable(integerSchema),
    maximum: nullable(integerSchema),
  },
  required: [
    "key",
    "label",
    "valueType",
    "defaultValue",
    "unit",
    "minimum",
    "maximum",
  ],
  additionalProperties: false,
} as const;

export const graderSettingsSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const graderRequiredEvidenceSchema = {
  type: "string",
  enum: [
    "transcript",
    "ending_outcome",
    "tool_calls",
    "observed_metrics",
    "test_expected_behaviors",
    "turn_response_latency",
  ],
} as const;

export const graderLibraryEntrySchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: stringSchema,
    description: nullable(stringSchema),
    owner: graderOwnerSchema,
    type: graderTypeSchema,
    scopeEditable: booleanSchema,
    currentDefinitionVersion: { type: "integer", minimum: 1 },
    definitionVersion: { type: "integer", minimum: 1 },
    modalities: graderModalitiesSchema,
    gradingInstructions: nullable(stringSchema),
    requiredEvidence: arrayOf(graderRequiredEvidenceSchema),
    settingDefinitions: arrayOf(graderSettingDefinitionSchema),
    activeProjectGraderId: nullable(stringIdSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "name",
    "description",
    "owner",
    "type",
    "scopeEditable",
    "currentDefinitionVersion",
    "definitionVersion",
    "modalities",
    "gradingInstructions",
    "requiredEvidence",
    "settingDefinitions",
    "activeProjectGraderId",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

export const projectGraderSchema = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: stringIdSchema,
    graderDefinitionId: stringIdSchema,
    name: stringSchema,
    description: nullable(stringSchema),
    owner: graderOwnerSchema,
    type: graderTypeSchema,
    modalities: graderModalitiesSchema,
    scopeEditable: booleanSchema,
    removable: booleanSchema,
    scope: graderScopeSchema,
    settings: graderSettingsSchema,
    passThreshold: { type: "number", minimum: 0, maximum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "graderDefinitionId",
    "name",
    "description",
    "owner",
    "type",
    "modalities",
    "scopeEditable",
    "removable",
    "scope",
    "settings",
    "passThreshold",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

export const projectGraderPolicyInputProperties = {
  scope: graderScopeSchema,
  settings: graderSettingsSchema,
  passThreshold: { type: "number", minimum: 0, maximum: 1 },
} as const;
