import type { JsonSchema, ParameterSchema } from "./definition.ts";

/** A value whose JSON shape is deliberately owned by another domain schema. */
export const anySchema = {} as const satisfies JsonSchema;

export const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies ParameterSchema;

export const refusalSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    details: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["error", "message"],
  additionalProperties: false,
} as const satisfies JsonSchema;

export const refusalResponse = {
  description: "The request was refused.",
  schema: refusalSchema,
} as const;

export const rateLimitResponse = {
  description: "The request rate limit was reached.",
  headers: {
    "Retry-After": {
      description: "Seconds to wait before trying again.",
      schema: { type: "integer", minimum: 1 },
    },
  },
  schema: refusalSchema,
} as const;

export const stringIdSchema = {
  type: "string",
  minLength: 1,
} as const satisfies JsonSchema;

export const dateTimeSchema = {
  type: "string",
  format: "date-time",
} as const satisfies JsonSchema;

export function nullable<const Schema extends JsonSchema>(schema: Schema) {
  return { anyOf: [schema, { type: "null" }] } as const;
}

export function arrayOf<const Schema extends JsonSchema>(schema: Schema) {
  return { type: "array", items: schema } as const;
}

export function parameters<
  const Properties extends Readonly<Record<string, JsonSchema>>,
  const Required extends readonly (keyof Properties & string)[],
>(properties: Properties, required: Required = [] as unknown as Required) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as const satisfies ParameterSchema;
}

/**
 * One observed metric as either conversation read answers it: the catalog
 * measure it names, the samples with the spans they happened in, and the one
 * reduction the platform computed — the mean, rounded once in the shared
 * measure module so no client ever rounds for itself. Shared here because two
 * operations answer it — a trace's transcript and one simulation's evidence —
 * and a projection written out at each door is two chances to disagree.
 */
export const metricSchema = {
  type: "object",
  properties: {
    measure: { type: "string" },
    unit: { type: "string" },
    derived: { type: "boolean" },
    reportedBy: { type: "string" },
    samples: { type: "array", items: { type: "number" } },
    spanIds: { type: "array", items: { type: "string" } },
    mean: { type: "number" },
    partial: { type: "boolean" },
  },
  required: [
    "measure",
    "unit",
    "derived",
    "samples",
    "spanIds",
    "mean",
    "partial",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;
