/** Shared span response for simulation evidence and production trace reads. */
import { arrayOf, dateTimeSchema } from "../schemas.ts";

const stringSchema = { type: "string" } as const;

/** The recursive reference, for a span's own children. */
export const traceSpanReference = { $ref: "#/$defs/traceSpan" } as const;

export const traceSpanSchema = {
  type: "object",
  properties: {
    spanId: stringSchema,
    parentSpanId: stringSchema,
    name: stringSchema,
    kind: stringSchema,
    status: stringSchema,
    startedAt: dateTimeSchema,
    durationNs: stringSchema,
    text: stringSchema,
    audioUrl: stringSchema,
    toolName: stringSchema,
    toolArguments: stringSchema,
    toolResult: stringSchema,
    /**
     * The evidence POV: agent for the agent's reported spans, persona for
     * the simulator's spans. A simulation can return both; transcript readers
     * must select one POV rather than merge them. Production has only agent POV.
     */
    pov: {
      type: "string",
      enum: ["persona", "agent"],
      description: "Whose account this span records: agent for the agent’s own turns and tools, or persona for Egma’s caller. Read the agent spans for one transcript; combining both repeats the conversation.",
    },
    /**
     * Set to mocked when toolName matches a mock tool in the simulation's pinned
     * test version. Absent for real tool calls and production traces. Derived
     * at read time, not copied from span attributes.
     */
    toolProvenance: {
      type: "string",
      enum: ["mocked"],
      description: "Present when a mock with this toolName answered the call. Read from the simulation’s pinned test version. Absent on ordinary tool calls and production traces.",
    },
    spans: arrayOf(traceSpanReference),
  },
  required: [
    "spanId",
    "parentSpanId",
    "name",
    "kind",
    "status",
    "startedAt",
    "durationNs",
    "text",
    "audioUrl",
    "toolName",
    "toolArguments",
    "toolResult",
    "pov",
    "spans",
  ],
  additionalProperties: false,
} as const;
