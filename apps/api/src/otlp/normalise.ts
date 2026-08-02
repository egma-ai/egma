import type { NewSpan } from "@egma/db";

import type {
  OtlpAttribute,
  OtlpExport,
  OtlpResourceSpans,
  OtlpScope,
  OtlpSpan,
  OtlpValue,
} from "./decode.ts";

/**
 * An OpenTelemetry export, as rows of the `spans` table.
 *
 * Three rules run through everything below and each of them is a decision taken
 * elsewhere rather than a preference expressed here:
 *
 * **Nothing is invented.** One arriving span becomes one row, and a span that
 * did not arrive is never conjured from an aggregate somebody reported. A
 * provider that reports latency as a bag of samples with no turn attached gets
 * those samples kept verbatim on the row they came on, and no fabricated
 * per-turn spans — inventing structure that was never measured would corrupt
 * every comparison the numbers exist for.
 *
 * **Nothing is dropped.** What the columns do not have a place for stays in the
 * verbatim payload, resource and scope attributes included, because the one
 * mistake no later migration can undo is not having captured something.
 *
 * **Tenancy is not the payload's business.** A resource attribute naming an
 * organization or a project is read by nothing here, deliberately. The customer
 * comes from the credential, which is what makes a copied key unable to write
 * into somebody else's account by asking nicely.
 */

/** What this door can know about a span's provenance, and it is not much. */
const INGESTED_AT_THIS_DOOR = {
  /**
   * Everything arriving here is `production`. This door cannot know a run
   * exists: a run is created by a simulation runtime that does not yet exist,
   * and `source` is an explicit column precisely so it is never inferred from
   * `run_id` being empty. When the runtime lands it arrives through this same
   * door and says which it is.
   */
  source: "production",
  /**
   * And it came from the customer's agent, which is the only thing emitting
   * today. egma's own runtime will emit `egma-runtime` through this door and
   * the two views of one trace will find each other by `provider_call_id`,
   * since there is no way to carry trace context across an audio channel.
   */
  emitter: "agent",
} as const;

/** The sentinel the schema declares for telemetry that named no environment. */
const DEFAULT_ENVIRONMENT = "default";

/**
 * Environment names egma keeps for itself, so that a name egma one day gives a
 * meaning cannot already mean something else in a customer's data. Copied from
 * the reference implementation that retrofitted environments and reserved its
 * own prefix on the way.
 */
const RESERVED_ENVIRONMENT_PREFIX = "egma";

/**
 * Where an environment is declared. The current semantic convention first, then
 * the name it replaced, because an agent pinned to an older SDK is the ordinary
 * case rather than a mistake.
 */
const ENVIRONMENT_ATTRIBUTES = [
  "deployment.environment.name",
  "deployment.environment",
];

/**
 * The vendor's own identifier for the trace. LiveKit puts its room name on
 * `session.id` — its wire fact, kept as it arrived — and repeats the room name
 * on the root span. Absence is normal: several providers give nothing to join
 * on.
 */
const PROVIDER_CALL_ID_ATTRIBUTES = ["session.id", "lk.room_name"];

/**
 * How LiveKit names the timed things inside a trace.
 *
 * Recognised by the instrumentation scope rather than guessed from the span
 * name, so another framework that happens to call something `user_turn` is not
 * silently read as LiveKit. What is not in this table is `other`, and that is a
 * complete answer — the row is stored either way, its payload intact, and a
 * later ticket that learns a new name adds a line here rather than a migration.
 *
 * There is deliberately no speech-to-text entry: this version of the framework
 * emits no such span, and recognition arrives as attributes on the human's
 * turn. A kind for a span nobody sends would be exactly the invented structure
 * this file refuses.
 */
const LIVEKIT_SCOPE = "livekit-agents";

const LIVEKIT_KINDS: Readonly<Record<string, string>> = {
  // The one span the whole trace happened inside. Its kind is `root` rather
  // than `trace`, because a trace is the whole thing and a span is one timed
  // thing within it — borrowing the word for a row would collapse the two
  // storage words into one.
  agent_session: "root",
  user_turn: "turn:human",
  agent_turn: "turn:agent",
  function_tool: "tool",
  eou_detection: "end-of-turn",
  llm_node: "model",
  llm_fallback_adapter: "model",
  llm_request: "model",
  llm_request_run: "model",
  tts_node: "tts",
  tts_stream_adapter: "tts",
  tts_fallback_adapter: "tts",
  tts_request: "tts",
  tts_request_run: "tts",
  // How long somebody's audio ran, which is neither a recognition step nor a
  // synthesis one.
  user_speaking: "speaking",
  agent_speaking: "speaking",
};

/** Where LiveKit puts what a turn's speaker actually said. */
const LIVEKIT_TURN_TEXT: Readonly<Record<string, string>> = {
  user_turn: "lk.user_transcript",
  agent_turn: "lk.response.text",
};

const LIVEKIT_TOOL = {
  name: "lk.function_tool.name",
  arguments: "lk.function_tool.arguments",
  result: "lk.function_tool.output",
} as const;

/**
 * The connection an agent was reached over, when the telemetry says so. Only
 * the framework is knowable from a scope name; the audio band is measured
 * rather than declared, and nothing here measured it.
 */
const CONNECTION_TYPE_BY_SCOPE: Readonly<Record<string, string>> = {
  [LIVEKIT_SCOPE]: "livekit",
};

/** A span egma refused, and why, so a partial success can say what happened. */
export type RejectedSpan = {
  readonly reason: string;
};

export type NormalisedExport = {
  readonly spans: readonly NewSpan[];
  readonly rejected: readonly RejectedSpan[];
};

function textOf(value: OtlpValue | undefined): string {
  if (value === undefined) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return String(value.boolValue);
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.bytesValue !== undefined) return value.bytesValue;
  // A list or a map has no plain reading, so it keeps its structure rather than
  // being flattened into something that looks like a sentence.
  if (value.arrayValue !== undefined) return JSON.stringify(value.arrayValue);
  if (value.kvlistValue !== undefined) return JSON.stringify(value.kvlistValue);
  return "";
}

function attribute(
  attributes: readonly OtlpAttribute[] | undefined,
  key: string,
): string {
  const found = (attributes ?? []).find((entry) => entry.key === key);
  return found === undefined ? "" : textOf(found.value);
}

function firstAttribute(
  sources: readonly (readonly OtlpAttribute[] | undefined)[],
  keys: readonly string[],
): string {
  for (const key of keys) {
    for (const attributes of sources) {
      const value = attribute(attributes, key);
      if (value !== "") return value;
    }
  }
  return "";
}

/** OTLP's status codes as the column's vocabulary. */
function statusOf(span: OtlpSpan): string {
  switch (span.status?.code) {
    case "STATUS_CODE_OK":
    case 1:
      return "ok";
    case "STATUS_CODE_ERROR":
    case 2:
      return "error";
    default:
      return "unset";
  }
}

/**
 * A decimal count of nanoseconds, however the encoding wrote it. The JSON
 * mapping says string and every exporter obeys, but a number is what a
 * hand-written client sends, and both are read exactly rather than through a
 * float.
 */
function nanoseconds(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  const digits = String(value).trim();
  if (!/^\d+$/.test(digits)) return null;
  return BigInt(digits);
}

/** Lowercase hex of the right width, which is the whole of what an id must be. */
function isWireId(id: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(id);
}

function kindOf(scope: OtlpScope | undefined, span: OtlpSpan): string {
  if (scope?.name === LIVEKIT_SCOPE) {
    const known = LIVEKIT_KINDS[span.name ?? ""];
    if (known !== undefined) return known;
  }
  // The published convention for a model call, which several frameworks emit
  // and which costs nothing to recognise.
  if (attribute(span.attributes, "gen_ai.operation.name") !== "") return "model";
  return "other";
}

function textFor(scope: OtlpScope | undefined, span: OtlpSpan): string {
  if (scope?.name !== LIVEKIT_SCOPE) return "";
  const key = LIVEKIT_TURN_TEXT[span.name ?? ""];
  return key === undefined ? "" : attribute(span.attributes, key);
}

/**
 * The environment this resource's spans were recorded in, discovered here on
 * first ingest rather than declared anywhere in advance — which is what makes a
 * self-hoster's throwaway environment free. A reserved name is refused rather
 * than silently rewritten, because a customer whose environment quietly became
 * something else would find out from a chart that was missing rows.
 */
function environmentOf(
  resourceSpans: OtlpResourceSpans,
): { environment: string } | { refusal: string } {
  const declared = firstAttribute(
    [resourceSpans.resource?.attributes],
    ENVIRONMENT_ATTRIBUTES,
  );
  if (declared === "") return { environment: DEFAULT_ENVIRONMENT };
  if (declared.toLowerCase().startsWith(RESERVED_ENVIRONMENT_PREFIX)) {
    return {
      refusal:
        `the environment name "${declared}" starts with the reserved prefix ` +
        `"${RESERVED_ENVIRONMENT_PREFIX}". Names beginning that way are kept ` +
        `for egma's own use; pick another and the spans will be stored.`,
    };
  }
  return { environment: declared };
}

export function normaliseOtlpExport(request: OtlpExport): NormalisedExport {
  const spans: NewSpan[] = [];
  const rejected: RejectedSpan[] = [];

  for (const resourceSpans of request.resourceSpans ?? []) {
    const environment = environmentOf(resourceSpans);

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scope = scopeSpans.scope;

      for (const span of scopeSpans.spans ?? []) {
        if ("refusal" in environment) {
          rejected.push({ reason: environment.refusal });
          continue;
        }

        const traceId = span.traceId ?? "";
        const spanId = span.spanId ?? "";
        if (!isWireId(traceId, 16) || !isWireId(spanId, 8)) {
          rejected.push({
            reason:
              "a span arrived without a usable trace id and span id. egma " +
              "adopts both from the wire and mints neither, so there is no " +
              "row to write for one that named itself nothing.",
          });
          continue;
        }

        const startedAt = nanoseconds(span.startTimeUnixNano);
        if (startedAt === null) {
          rejected.push({
            reason:
              `span ${spanId} carries no start time. It is stamped when the ` +
              "span opens and never re-derived, so nothing downstream can " +
              "supply one for it.",
          });
          continue;
        }

        const endedAt = nanoseconds(span.endTimeUnixNano);
        const duration =
          endedAt === null || endedAt < startedAt ? 0n : endedAt - startedAt;

        const attributes = span.attributes;
        const kind = kindOf(scope, span);
        const isLiveKit = scope?.name === LIVEKIT_SCOPE;

        spans.push({
          traceId,
          spanId,
          parentSpanId: isWireId(span.parentSpanId ?? "", 8)
            ? (span.parentSpanId ?? "")
            : "",
          source: INGESTED_AT_THIS_DOOR.source,
          emitter: INGESTED_AT_THIS_DOOR.emitter,
          environment: environment.environment,
          // Microseconds, because the column is DateTime64(6). The nanoseconds
          // are not lost — the full-precision duration is the column beside it,
          // and the payload still holds what arrived.
          startedAtMicroseconds: startedAt / 1000n,
          durationNanoseconds: duration,
          name: span.name ?? "",
          kind,
          status: statusOf(span),
          text: textFor(scope, span),
          // Nothing here holds audio, and the fixture's provider does not offer
          // a reference to any. A guess would be worse than an empty column.
          audioUrl: "",
          toolName: isLiveKit ? attribute(attributes, LIVEKIT_TOOL.name) : "",
          toolArguments: isLiveKit
            ? attribute(attributes, LIVEKIT_TOOL.arguments)
            : "",
          toolResult: isLiveKit ? attribute(attributes, LIVEKIT_TOOL.result) : "",
          providerCallId: firstAttribute(
            [attributes, resourceSpans.resource?.attributes],
            PROVIDER_CALL_ID_ATTRIBUTES,
          ),
          connectionType: CONNECTION_TYPE_BY_SCOPE[scope?.name ?? ""] ?? "",
          // Measured, never declared — and nothing on this path measured it.
          audioSampleRateHz: 0,
          audioEncoding: "",
          // A run, an agent and the versions it pinned are the control plane's,
          // and this door has none of them: a trace arriving here was not
          // started by egma.
          runId: "",
          agentId: "",
          agentVersionId: "",
          testVersionId: "",
          digitalHumanVersionId: "",
          payload: JSON.stringify({
            resource: resourceSpans.resource ?? {},
            resourceSchemaUrl: resourceSpans.schemaUrl ?? "",
            scope: scope ?? {},
            scopeSchemaUrl: scopeSpans.schemaUrl ?? "",
            span,
          }),
        });
      }
    }
  }

  return { spans, rejected };
}
