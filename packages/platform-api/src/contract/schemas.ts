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
 * Shared metric response: measure name, evidence samples, and reductions
 * computed by @egma/metrics. Clients format these values without repeating
 * the metric calculation.
 */
const povSeriesSchema = {
  type: "object",
  properties: {
    pov: { type: "string", enum: ["persona", "agent"] },
    derived: { type: "boolean" },
    reportedBy: { type: "string" },
    samples: { type: "array", items: { type: "number" } },
    spanIds: { type: "array", items: { type: "string" } },
    partial: { type: "boolean" },
  },
  required: ["pov", "derived", "samples", "spanIds", "partial"],
  additionalProperties: false,
} as const satisfies JsonSchema;

export const metricSchema = {
  type: "object",
  properties: {
    measure: { type: "string" },
    unit: { type: "string" },
    derived: { type: "boolean" },
    /**
     * Whose account of the conversation this number is — the persona's,
     * measured off egma's own recording, or the agent's, off its own process
     * (ADR-0024 §5). `derived` says which machinery produced it; this says
     * whose conversation it describes, which is the fact that decides whether
     * two numbers may be compared at all.
     */
    pov: { type: "string", enum: ["persona", "agent"] },
    reportedBy: { type: "string" },
    samples: { type: "array", items: { type: "number" } },
    spanIds: { type: "array", items: { type: "string" } },
    mean: { type: "number" },
    p50: { type: "number" },
    p90: { type: "number" },
    partial: { type: "boolean" },
    /**
     * The same measure as the other POV measured it, where both measured it —
     * a simulation only. Never averaged into the headline and never appended
     * to it: two units, each saying which POV took it. Absent on every
     * conversation only one POV measured, which is every production trace.
     */
    otherPov: povSeriesSchema,
  },
  required: [
    "measure",
    "unit",
    "derived",
    "pov",
    "samples",
    "spanIds",
    "mean",
    "p50",
    "p90",
    "partial",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;
