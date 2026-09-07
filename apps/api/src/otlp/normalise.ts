import type { NewSpan, SpanEmitter, SpanSource } from "@egma/db";
import { TIMING_SPAN_MEASURES } from "@egma/metrics";

import type {
  OtlpAttribute,
  OtlpExport,
  OtlpResourceSpans,
  OtlpScope,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpValue,
} from "./decode.ts";

/**
 * Normalize accepted OTLP spans into storage rows without inventing spans
 * from aggregates. Keep decoded span, resource, and scope fields in the JSON
 * payload; this preserves values, not original wire formatting.
 * Do not redact evidence by matching words or credential-like values. Request
 * credentials remain outside this payload. Organization/project scope comes
 * from authentication and resolved simulation state, not resource attributes.
 */

/**
 * What the door knows about an export beyond what the payload says: which kind
 * of traffic it is, which side measured it, and — for a simulation — the run
 * and pins the door resolved from egma's own row. Everything a row carries
 * that the wire cannot be trusted to carry.
 */
export type SpanAttribution = {
  readonly source: SpanSource;
  readonly emitter: SpanEmitter;
  readonly runId: string;
  readonly agentId: string;
  readonly testVersionId: string;
  readonly personaVersionId: string;
};

/** What this door can know about a customer key's spans, and it is not much. */
const INGESTED_AT_THIS_DOOR: SpanAttribution = {
  /**
   * Everything arriving on a customer key is `production`. This path cannot
   * know a run exists: a run's conversations are conducted by egma's own
   * simulator, which posts through the same door holding the service token,
   * and `source` is an explicit column precisely so it is never inferred from
   * `run_id` being empty.
   */
  source: "production",
  /**
   * And it came from the customer's agent, which is the only thing a customer
   * key speaks for. egma's own runtime emits `egma-runtime` through this door
   * on the service path, and the two views of one trace will find each other
   * by `provider_call_id`, since there is no way to carry trace context across
   * an audio channel.
   */
  emitter: "agent",
  /**
   * A run, an agent and the versions it pinned are the control plane's, and a
   * trace arriving on a customer key was not started by egma.
   */
  runId: "",
  agentId: "",
  testVersionId: "",
  personaVersionId: "",
};

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
const PROVIDER_CALL_ID_ATTRIBUTES = [
  "session.id",
  "lk.pii.room_name",
  "lk.room_name",
];

/**
 * Recognize LiveKit span kinds only under its instrumentation scope.
 * Unknown names remain other with their payload retained.
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
const LIVEKIT_TURN_TEXT: Readonly<Record<string, readonly string[]>> = {
  user_turn: ["lk.pii.user_transcript", "lk.user_transcript"],
  agent_turn: ["lk.pii.response.text", "lk.response.text"],
};

const LIVEKIT_TOOL = {
  name: ["lk.function_tool.name"],
  arguments: [
    "lk.pii.function_tool.arguments",
    "lk.function_tool.arguments",
  ],
  result: ["lk.pii.function_tool.output", "lk.function_tool.output"],
} as const;

/**
 * Map the simulator contract's span names to storage kinds. Derive timing
 * names from the measure catalog so emitted measures are not filed as other.
 * Golden fixtures in simulation-contract pin this vocabulary.
 */
const SIMULATOR_SCOPE = "egma-simulator";

const SIMULATOR_KINDS: Readonly<Record<string, string>> = {
  // **The catalog first, so the four structural names below win a collision.**
  // A measure joining the catalog under one of their names — a measure called
  // `agent_turn`, say — would otherwise re-file the span carrying what the agent
  // said as a measurement, and a transcript would quietly lose its turns. The
  // structural shapes are this vocabulary's own and are not a measure's to take.
  ...Object.fromEntries(
    TIMING_SPAN_MEASURES.map((measure) => [measure, "timing"]),
  ),
  // The one span the whole conversation happened inside, emitted last: when it
  // arrives, the conversation is over.
  simulation: "root",
  recording: "recording",
  human_turn: "turn:human",
  agent_turn: "turn:agent",
  tool_call: "tool",
  // What one provider request cost, as its own kind. The row is kept like any
  // other span — the record that prices it is written into Postgres beside
  // this, because a balance has to be readable in milliseconds and a
  // ReplacingMergeTree collapses when it feels like it.
  provider_usage: "usage",
};

/** The two turn names, which are where the one text attribute is read. */
const SIMULATOR_TURN_NAMES: ReadonlySet<string> = new Set([
  "human_turn",
  "agent_turn",
]);

const SIMULATOR_TURN_TEXT = "egma.turn.text";

/**
 * Lift simulator tool name, arguments, and result into columns. Remaining
 * attributes stay in payload; these keys alone do not establish mock provenance.
 */
const SIMULATOR_TOOL = {
  name: ["egma.tool.name"],
  arguments: ["egma.tool.arguments"],
  result: ["egma.tool.result"],
} as const;

/**
 * How a resource on the service path names the simulation its spans are
 * evidence of. Read by the door, which resolves everything tenant-shaped from
 * the named row; on the customer path it is not consulted at all — it rides
 * the payload like any other attribute.
 */
export const SIMULATION_ID_ATTRIBUTE = "egma.simulation_id";

/** Which simulation this resource speaks for, or `""` for naming none. */
export function simulationNamedBy(resourceSpans: OtlpResourceSpans): string {
  return attribute(resourceSpans.resource?.attributes, SIMULATION_ID_ATTRIBUTE);
}

/**
 * Agent exports identify simulations by provider reference, such as a LiveKit
 * room name. Resolve the reference within the authenticated project.
 * The simulator service path instead uses egma.simulation_id.
 */
export const PROVIDER_REFERENCE_ATTRIBUTE = "egma.provider_reference";

/**
 * Prefer a resource-level provider reference. If absent, use the single
 * reference agreed by stamped spans; unstamped spans can predate SDK setup.
 * Multiple span references are ambiguous. An explicitly empty reference stays
 * distinct from absence so the route can reject it instead of filing production.
 * A resource-level value takes precedence without comparing span values.
 */
export type ProviderReferenceClaim =
  /** No resource attribute and no span carrying the key: production traffic. */
  | { readonly kind: "none" }
  /**
   * One conversation: named on the resource, or the one value every stamped
   * span agrees on. Spans in this resource that carry no reference are filed
   * under it too.
   */
  | { readonly kind: "named"; readonly reference: string }
  /** Stamped spans name more than one conversation, so this names none. */
  | { readonly kind: "disagreeing"; readonly references: readonly string[] };

export function providerReferenceClaimedBy(
  resourceSpans: OtlpResourceSpans,
): ProviderReferenceClaim {
  if (namesAProviderReference(resourceSpans)) {
    return { kind: "named", reference: providerReferenceNamedBy(resourceSpans) };
  }

  const spans = (resourceSpans.scopeSpans ?? []).flatMap(
    (scopeSpans) => scopeSpans.spans ?? [],
  );
  const claimed = new Set<string>();
  for (const span of spans) {
    if (
      (span.attributes ?? []).some(
        (entry) => entry.key === PROVIDER_REFERENCE_ATTRIBUTE,
      )
    ) {
      claimed.add(attribute(span.attributes, PROVIDER_REFERENCE_ATTRIBUTE));
    }
  }

  if (claimed.size === 0) return { kind: "none" };
  const [only] = [...claimed];
  if (claimed.size === 1 && only !== undefined) {
    return { kind: "named", reference: only };
  }
  return { kind: "disagreeing", references: [...claimed].sort() };
}

/** Which conversation this **resource** is the agent's POV of, or `""`. */
export function providerReferenceNamedBy(
  resourceSpans: OtlpResourceSpans,
): string {
  return attribute(
    resourceSpans.resource?.attributes,
    PROVIDER_REFERENCE_ATTRIBUTE,
  );
}

/**
 * Distinguish an absent provider-reference key from an explicitly empty one.
 * Empty simulation attribution must not become production traffic.
 */
export function namesAProviderReference(
  resourceSpans: OtlpResourceSpans,
): boolean {
  return (resourceSpans.resource?.attributes ?? []).some(
    (entry) => entry.key === PROVIDER_REFERENCE_ATTRIBUTE,
  );
}

/**
 * Payload key preserving the exporter's trace ID when filing under a
 * simulation trace ID. Reserve this key for Egma; duplicate JSON keys do not
 * have portable first-value semantics.
 */
export const WIRE_TRACE_ID_PAYLOAD_KEY = "egma.wire_trace_id";

/** A scope proves the framework, not how the caller reached the agent. */
const AGENT_PLATFORM_BY_SCOPE: Readonly<Record<string, string>> = {
  [LIVEKIT_SCOPE]: "livekit",
};

const PLATFORM_AGENT_ID_ATTRIBUTES = ["lk.cloud_agent_id", "lk.agent_id"];
// `lk.agent_name` is the dispatched worker name when LiveKit has one.
// `lk.agent_label` is preserved in the provider payload. Its product meaning
// is not settled, so it must not be relabelled as platform-agent identity.
const PLATFORM_AGENT_NAME_ATTRIBUTES = ["lk.agent_name"];
const PLATFORM_AGENT_VERSION_ATTRIBUTES = [
  "lk.deployment_id",
  "lk.agent_version",
];
const CONNECTION_TYPE_ATTRIBUTES = ["egma.connection_type"];

/**
 * Per-request span-count and normalized-byte caps. Repeated resource payloads
 * can make stored rows much larger than the wire body. Report excluded spans
 * as partial success instead of silently discarding them.
 */
const MAXIMUM_SPANS_PER_REQUEST = 10_000;
const MAXIMUM_NORMALISED_BYTES = 64 * 1024 * 1024;

/** A span egma refused, and why, so a partial success can say what happened. */
export type RejectedSpan = {
  readonly reason: string;
};

export type NormalisedExport = {
  readonly spans: readonly NewSpan[];
  readonly rejected: readonly RejectedSpan[];
};

/**
 * Share one budget across normalization calls for the same HTTP request,
 * including resources resolved to different simulations.
 */
export type NormalisationBudget = {
  spans: number;
  bytes: number;
};

/** A request's budget, untouched. */
export function budgetForOneRequest(): NormalisationBudget {
  return { spans: 0, bytes: 0 };
}

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

const DECIMAL_DIGITS = /^\d+$/;

/**
 * Read decimal nanoseconds as bigint. Numeric JSON input may already have
 * lost precision; decimal strings preserve the exact value.
 */
function nanoseconds(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  const digits = String(value).trim();
  if (!DECIMAL_DIGITS.test(digits)) return null;
  return BigInt(digits);
}

/**
 * Clamp duration at Int64's ceiling because reads use signed arithmetic
 * even though storage is UInt64. Keep original timestamps in the payload.
 */
const MAXIMUM_DURATION_NANOSECONDS = 2n ** 63n - 1n;

/**
 * The two id widths OpenTelemetry defines, as the hex they are written in.
 * Compiled once: an export is tens of thousands of spans and building a regular
 * expression per id is work nobody asked for.
 */
const WIRE_ID_PATTERNS: Readonly<Record<number, RegExp>> = {
  8: /^[0-9a-f]{16}$/,
  16: /^[0-9a-f]{32}$/,
};

/** Normalize fixed-width hex IDs to lowercase; return empty for invalid shape. */
function wireId(id: string | undefined, bytes: 8 | 16): string {
  const lowered = (id ?? "").toLowerCase();
  return WIRE_ID_PATTERNS[bytes]?.test(lowered) === true ? lowered : "";
}

/** The registry itself: which vocabulary each known scope's names land as. */
const KINDS_BY_SCOPE: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [LIVEKIT_SCOPE]: LIVEKIT_KINDS,
  [SIMULATOR_SCOPE]: SIMULATOR_KINDS,
};

function kindOf(scope: OtlpScope | undefined, span: OtlpSpan): string {
  const known = KINDS_BY_SCOPE[scope?.name ?? ""]?.[span.name ?? ""];
  if (known !== undefined) return known;
  // A scope this table does not know is `other`, including one emitting the
  // GenAI semantic conventions: reading those arrives with the first unknown
  // provider, recognised by scope like everything else here rather than by an
  // attribute any framework might set on any span.
  return "other";
}

function textFor(scope: OtlpScope | undefined, span: OtlpSpan): string {
  if (scope?.name === LIVEKIT_SCOPE) {
    const keys = LIVEKIT_TURN_TEXT[span.name ?? ""];
    return keys === undefined ? "" : firstAttribute([span.attributes], keys);
  }
  if (scope?.name === SIMULATOR_SCOPE) {
    return SIMULATOR_TURN_NAMES.has(span.name ?? "")
      ? attribute(span.attributes, SIMULATOR_TURN_TEXT)
      : "";
  }
  return "";
}

/**
 * Where a scope's tool spans keep their facts, or nothing for a scope whose
 * vocabulary this table does not know. `result` is optional because not every
 * emitter observes one, and an absent fact stays absent.
 */
const TOOL_KEYS_BY_SCOPE: Readonly<
  Record<
    string,
    {
      readonly name: readonly string[];
      readonly arguments: readonly string[];
      readonly result?: readonly string[];
    }
  >
> = {
  [LIVEKIT_SCOPE]: LIVEKIT_TOOL,
  [SIMULATOR_SCOPE]: SIMULATOR_TOOL,
};

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
        `for Egma's own use; pick another and the spans will be stored.`,
    };
  }
  return { environment: declared };
}

/**
 * Everything on a row except the span itself, serialised once for the whole
 * scope rather than once per span.
 *
 * The resource and the scope ride every row on purpose — a row has to say
 * where it came from without a join — but they are the same two objects for
 * every span in the group. Built lazily, so a group whose spans are all
 * refused never pays for serialization.
 */
function payloadPrefixFor(
  resourceSpans: OtlpResourceSpans,
  scopeSpans: OtlpScopeSpans,
): string {
  return (
    `{"resource":${JSON.stringify(resourceSpans.resource ?? {})},` +
    `"resourceSchemaUrl":${JSON.stringify(resourceSpans.schemaUrl ?? "")},` +
    `"scope":${JSON.stringify(scopeSpans.scope ?? {})},` +
    `"scopeSchemaUrl":${JSON.stringify(scopeSpans.schemaUrl ?? "")},` +
    `"span":`
  );
}

/** The two ways one request can ask for more than egma turns into rows. */
const TOO_MANY_SPANS =
  `this export carried more than the ${MAXIMUM_SPANS_PER_REQUEST.toLocaleString("en-US")} ` +
  "spans Egma turns into rows from one request. The spans that fitted were " +
  "stored and the rest were refused rather than retried: send them as more " +
  "than one export, which is what an exporter's own batch size is for.";

const TOO_MANY_BYTES =
  `this export's spans came to more than the ${MAXIMUM_NORMALISED_BYTES / (1024 * 1024)} MiB of rows Egma ` +
  "writes from one request — every span carries its resource and scope, " +
  "so a large resource repeated across many spans reaches this long " +
  "before the body does. The spans that fitted were stored and the rest were " +
  "refused rather than retried; flush smaller batches.";

/**
 * Normalize spans using optional per-resource attribution resolved by the
 * route. Without it, attribution defaults to production/agent. Reuse budget
 * when several calls process one request.
 */
export function normaliseOtlpExport(
  request: OtlpExport,
  attributionFor?: (resourceSpans: OtlpResourceSpans) => SpanAttribution,
  budget: NormalisationBudget = budgetForOneRequest(),
): NormalisedExport {
  const spans: NewSpan[] = [];
  const rejected: RejectedSpan[] = [];

  // The whole of what an over-budget request is told, made once and pushed by
  // reference: a client that sent a hundred thousand spans is owed a count of
  // what was refused, not a hundred thousand copies of one sentence.
  let excess: RejectedSpan | undefined;

  for (const resourceSpans of request.resourceSpans ?? []) {
    const environment = environmentOf(resourceSpans);
    const attribution =
      attributionFor?.(resourceSpans) ?? INGESTED_AT_THIS_DOOR;

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scope = scopeSpans.scope;
      let payloadPrefix: string | undefined;

      for (const span of scopeSpans.spans ?? []) {
        // Asked before anything is built, because building the row is the cost
        // the caps exist to bound.
        if (
          budget.spans >= MAXIMUM_SPANS_PER_REQUEST ||
          budget.bytes >= MAXIMUM_NORMALISED_BYTES
        ) {
          excess ??= {
            reason:
              budget.spans >= MAXIMUM_SPANS_PER_REQUEST
                ? TOO_MANY_SPANS
                : TOO_MANY_BYTES,
          };
          rejected.push(excess);
          continue;
        }

        if ("refusal" in environment) {
          rejected.push({ reason: environment.refusal });
          continue;
        }

        const traceId = wireId(span.traceId, 16);
        const spanId = wireId(span.spanId, 8);
        if (traceId === "" || spanId === "") {
          rejected.push({
            reason:
              "a span arrived without a usable trace id and span id. Egma " +
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
        const measured =
          endedAt === null || endedAt < startedAt ? 0n : endedAt - startedAt;
        // Clamped, so that no read has to add a negative one to a start time.
        const duration =
          measured > MAXIMUM_DURATION_NANOSECONDS
            ? MAXIMUM_DURATION_NANOSECONDS
            : measured;

        const attributes = span.attributes;
        const kind = kindOf(scope, span);
        const tool = TOOL_KEYS_BY_SCOPE[scope?.name ?? ""];
        const agentPlatform = AGENT_PLATFORM_BY_SCOPE[scope?.name ?? ""] ?? "";

        payloadPrefix ??= payloadPrefixFor(resourceSpans, scopeSpans);
        const payload = `${payloadPrefix}${JSON.stringify(span)}}`;
        // Bytes rather than code units, because bytes are what the store holds
        // and what the memory this bounds is made of.
        budget.bytes += Buffer.byteLength(payload);
        budget.spans += 1;

        spans.push({
          traceId,
          spanId,
          // A parent that is not a usable id is dropped to `''`, which is how a
          // root is recognised — so a span whose parent arrived malformed reads
          // as a second root rather than as a child of nothing. The original is
          // still in the payload, and the nesting ticket treats a span whose
          // parent is not in the trace as top-level under the real root.
          parentSpanId: wireId(span.parentSpanId, 8),
          source: attribution.source,
          emitter: attribution.emitter,
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
          // Nothing here holds audio, and neither emitter offers a reference
          // to any yet. A guess would be worse than an empty column.
          audioUrl: "",
          toolName:
            tool === undefined
              ? ""
              : firstAttribute([attributes], tool.name),
          toolArguments:
            tool === undefined
              ? ""
              : firstAttribute([attributes], tool.arguments),
          toolResult:
            tool?.result === undefined
              ? ""
              : firstAttribute([attributes], tool.result),
          providerCallId: firstAttribute(
            [attributes, resourceSpans.resource?.attributes],
            PROVIDER_CALL_ID_ATTRIBUTES,
          ),
          agentPlatform,
          platformAgentId: firstAttribute(
            [attributes, resourceSpans.resource?.attributes],
            PLATFORM_AGENT_ID_ATTRIBUTES,
          ),
          platformAgentName: firstAttribute(
            [attributes, resourceSpans.resource?.attributes],
            PLATFORM_AGENT_NAME_ATTRIBUTES,
          ),
          platformAgentVersion: firstAttribute(
            [attributes, resourceSpans.resource?.attributes],
            PLATFORM_AGENT_VERSION_ATTRIBUTES,
          ),
          // The service-token path is Egma's own simulator and may state the
          // connection type it used. Customer OTLP is production evidence;
          // this release does not let an arbitrary payload create a shared
          // production connection-type fact.
          connectionType:
            attribution.source === "simulation"
              ? firstAttribute(
                  [attributes, resourceSpans.resource?.attributes],
                  CONNECTION_TYPE_ATTRIBUTES,
                )
              : "",
          // The run and pins ride the attribution: the door resolved them from
          // egma's own simulation row on the service path, and a customer
          // key's traffic has none — a trace arriving there was not started by
          // egma. Agents are not versioned, so nothing has a version to pin.
          runId: attribution.runId,
          agentId: attribution.agentId,
          agentVersionId: "",
          testVersionId: attribution.testVersionId,
          personaVersionId: attribution.personaVersionId,
          payload,
          /*
           * Only recognized agent-platform root spans mark production completion.
           * A parentless span alone is insufficient. Simulation filing clears this
           * marker because its lifecycle report controls completion.
           */
          endsTrace: kind === "root" && agentPlatform !== "",
        });
      }
    }
  }

  return { spans, rejected };
}
