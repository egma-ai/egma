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
 * measure it names, the samples with the spans they happened in, and the
 * reductions the platform computed — the mean, the median and the p90, each
 * worked out once in the shared measure module so no client ever reduces for
 * itself. Which one a page leads with is the page's decision; today it is the
 * p90, the number the tail of the call is felt in. Shared here because two
 * operations answer it — a trace's transcript and one simulation's evidence —
 * and a projection written out at each door is two chances to disagree.
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
  description: "One metric from one side of the conversation. Turn response latency and first response latency prefer the agent's series when available. A second series stays separate in otherPov.",
  properties: {
    measure: {
      type: "string",
      description: "Metric identifier. turn_response_latency measures the wait from the end of the caller's turn to the start of the agent's reply, using speech boundaries for voice when available. first_response_latency measures the time from conversation start to the agent's first reply. Both use milliseconds.",
    },
    unit: { type: "string" },
    derived: { type: "boolean" },
    /**
     * Whose account of the conversation this number is — the persona's,
     * measured off egma's own recording, or the agent's, off its own process
     * (ADR-0024 §5). `derived` says which machinery produced it; this says
     * whose conversation it describes, which is the fact that decides whether
     * two numbers may be compared at all.
     */
    pov: {
      type: "string",
      enum: ["persona", "agent"],
      description: "The source of these measurements: agent for the agent's own evidence, or persona for Egma's simulated caller. The samples and summary values describe only this source.",
    },
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
    otherPov: {
      ...povSeriesSchema,
      description: "The same metric measured from the other side of a simulation. Keep its samples separate from the primary series. Absent when only one side measured the conversation, including production traces.",
    },
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
