/**
 * One span of a transcript, shared by the two reads that return one.
 *
 * A simulation and a production conversation are read through different
 * endpoints and are **the same shape**, deliberately: a developer who has
 * learned to read one has learned to read the other, and a shape that drifted
 * apart in two files would make that untrue quietly. It lives here as one
 * definition because the OpenAPI document holds one `traceSpan`, and two copies
 * of it were only ever an invitation to disagree.
 */
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
     * Whose POV of the conversation this span is.
     *
     * `agent` is what the agent's own process reported — its turns, its tool
     * calls and its timings — and `persona` is what egma's own simulator said,
     * heard, measured and recorded. A simulation holds both POVs under one
     * trace and this read returns both; a reader that wants one conversation
     * reads the agent's, because a transcript built from the two together is
     * one conversation told twice. A production conversation has only the
     * agent's.
     */
    pov: { type: "string", enum: ["persona", "agent"] },
    /**
     * That a mock tool answered this call, when one did.
     *
     * The one value is `mocked`, and the key is absent on every other span. A
     * real call is the ordinary case and says nothing extra; a mocked one is
     * the fact a reader of a transcript needs, because the answer they are
     * looking at came from the test rather than from their own backend.
     *
     * Read **by name** from the simulation's pinned test version, never from
     * anything stamped on the span: the pinned version is the authored world
     * the simulation ran against, it cannot change under a result, and a
     * second copy of the fact could only come to disagree with it. So it
     * appears on a simulation's transcript and never on a production one,
     * which has no test version and no mock tools.
     *
     * The mock tool's own name is not written beside it. Matching is by tool
     * name and by nothing else, so it is `toolName`, already here.
     */
    toolProvenance: { type: "string", enum: ["mocked"] },
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
