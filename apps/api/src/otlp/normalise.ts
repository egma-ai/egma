import type { NewSpan, SpanEmitter, SpanSource } from "@egma/db";
import { SPAN_DERIVED_MEASURES } from "@egma/simulation-contract";

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
 * **Everything that arrives is kept, exactly.** What the columns do not have a
 * place for stays in the payload, resource and scope attributes included, byte
 * for byte. Nothing here reads an attribute's name or a value's shape and
 * decides it looks like a credential: a transcript containing the word
 * `password`, a tool argument called `secret`, an attribute whose value starts
 * with `Bearer` are all evidence, and a scanner that rewrote them would have
 * edited the one thing the product exists to show a team. Operational
 * credentials are excluded by position instead — the HTTP `Authorization`
 * header and the service token live outside the payload and never reach here.
 *
 * **Tenancy is not the payload's business.** A resource attribute naming an
 * organization or a project is read by nothing here, deliberately. The customer
 * comes from the credential, which is what makes a copied key unable to write
 * into somebody else's account by asking nicely. The one resource attribute the
 * simulator path does read — `egma.simulation_id` — names a conversation, not
 * a customer: the door resolves whose it is from egma's own row, so the
 * payload's claim still decides nothing.
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
 * How egma's own simulator names the timed things inside a conversation — the
 * scope-gated entry beside LiveKit's, and the ingest half of the emitter
 * contract: the scope, the span names and the attribute keys are pinned by the
 * golden fixtures in `packages/simulation-contract`, whose document says what
 * each shape means. The simulator emits exactly those shapes; this table is
 * what they land as.
 *
 * A timing span is named for the measure it takes and its duration *is* the
 * measurement, so the timing names here are **read out of the measure catalog**
 * rather than listed again: every measure the catalog says comes off a span of
 * its own lands as `timing`, and a measure joining the catalog is filed
 * correctly by the release that adds it. A hand-kept copy of that list is how a
 * measure comes to be emitted, stored as `other`, and then never computed —
 * green, silent, and wrong, which is the exact failure the catalog exists to
 * prevent.
 */
const SIMULATOR_SCOPE = "egma-simulator";

const SIMULATOR_KINDS: Readonly<Record<string, string>> = {
  // **The catalog first, so the four structural names below win a collision.**
  // A measure joining the catalog under one of their names — a measure called
  // `agent_turn`, say — would otherwise re-file the span carrying what the agent
  // said as a measurement, and a transcript would quietly lose its turns. The
  // structural shapes are this vocabulary's own and are not a measure's to take.
  ...Object.fromEntries(
    SPAN_DERIVED_MEASURES.map((measure) => [measure, "timing"]),
  ),
  // The one span the whole conversation happened inside, emitted last: when it
  // arrives, the conversation is over.
  simulation: "root",
  human_turn: "turn:human",
  agent_turn: "turn:agent",
  tool_call: "tool",
};

/** The two turn names, which are where the one text attribute is read. */
const SIMULATOR_TURN_NAMES: ReadonlySet<string> = new Set([
  "human_turn",
  "agent_turn",
]);

const SIMULATOR_TURN_TEXT = "egma.turn.text";

/**
 * The result key is here now, and the reason it was once absent is the reason
 * it belongs: this file refuses invented structure, and a result egma itself
 * served is not invented. The simulator answers a mocked tool call from inside
 * the exchange, so the answer is authored rather than observed — and the
 * vocabulary only lets it be written down beside the provenance stamp saying
 * where it came from. A call egma merely watched go past still carries
 * neither.
 *
 * The stamp itself, the mock tool that answered, and the late-attached flag
 * have no columns of their own and are not given one here. They are in the
 * span's payload, whole, like every other attribute the row does not lift out;
 * a column earns its place by being queried, and nothing queries these yet.
 */
const SIMULATOR_TOOL = {
  name: "egma.tool.name",
  arguments: "egma.tool.arguments",
  result: "egma.tool.result",
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

/** A scope proves the framework, not how the caller reached the agent. */
const AGENT_PLATFORM_BY_SCOPE: Readonly<Record<string, string>> = {
  [LIVEKIT_SCOPE]: "livekit_agents",
};

const PLATFORM_AGENT_ID_ATTRIBUTES = ["lk.cloud_agent_id", "lk.agent_id"];
// `lk.agent_name` is the dispatched worker name when LiveKit has one.
// `lk.agent_label` is preserved in the provider payload. Its product meaning
// is not settled, so it must not be relabelled as platform-agent identity.
const PLATFORM_AGENT_NAME_ATTRIBUTES = ["lk.agent_name"];
const PLATFORM_AGENT_VERSION_ATTRIBUTES = ["lk.agent_version"];
const CONNECTION_KIND_ATTRIBUTES = ["egma.connection_kind"];

/**
 * How much of one export egma will turn into rows.
 *
 * Neither of these is a limit on how much telemetry a customer may send — an
 * exporter flushes as often as it likes — and neither drops anything silently:
 * what does not fit is reported in the partial-success field the specification
 * has for exactly this, so the client is told how much was refused and knows
 * not to retry it.
 *
 * Both caps are needed because they answer different requests. A body inside
 * the wire limit can still carry a hundred thousand tiny spans, which is what
 * the count is for; and it can carry two thousand spans sharing one enormous
 * resource, where every row repeats that resource and a 1.3 MiB
 * request becomes gigabytes of rows. The byte budget is measured on what the
 * rows actually weigh, which is the only number that predicts the memory.
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
 * A decimal count of nanoseconds, however the encoding wrote it. The JSON
 * mapping says string and every exporter obeys, but a number is what a
 * hand-written client sends.
 *
 * A string is read exactly, digit for digit, into a `bigint`. A number cannot
 * be: JSON parsed it into a float before this saw it, so a count above
 * 2^53 has already lost its low digits and nothing here can put them back —
 * which is the whole reason the mapping says to send a string.
 */
function nanoseconds(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  const digits = String(value).trim();
  if (!DECIMAL_DIGITS.test(digits)) return null;
  return BigInt(digits);
}

/**
 * Where a duration stops, which is Int64's ceiling and not `UInt64`'s.
 *
 * The column is a `UInt64`, but every read that adds a duration to a start time
 * does so in signed 64-bit arithmetic, so a count past this comes back negative
 * and the trace ends before it began. Nearly three centuries in nanoseconds is a
 * broken clock rather than a long call — an exporter sending `0` for a start and
 * `now` for an end reaches it — so it is clamped here, where the number is still
 * explainable, and the pair of timestamps it was measured from stays untouched
 * in the payload.
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

/**
 * An id off the wire in the one form egma stores it in, or `""` for anything
 * that is not one.
 *
 * Hex of the right width is the whole of what an id must be. Uppercase is
 * accepted and lowered rather than refused — the JSON mapping says lowercase
 * and every exporter obeys, but a hand-written client that shouts its hex means
 * the same id, and storing the two spellings as two different traces would
 * split one conversation in half.
 */
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
    const key = LIVEKIT_TURN_TEXT[span.name ?? ""];
    return key === undefined ? "" : attribute(span.attributes, key);
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
    { readonly name: string; readonly arguments: string; readonly result?: string }
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
 * Turn one export into rows.
 *
 * `attributionFor` is the door's knowledge of each resource, resolved before
 * this runs: absent on the customer path, where every resource is production
 * traffic from the customer's agent; present on the service path, where the
 * door has already resolved each resource's simulation row and answers the
 * stamp its spans carry. It is asked once per resource, because attribution is
 * a fact about where the spans came from and every span of a resource came
 * from the same place.
 */
export function normaliseOtlpExport(
  request: OtlpExport,
  attributionFor?: (resourceSpans: OtlpResourceSpans) => SpanAttribution,
): NormalisedExport {
  const spans: NewSpan[] = [];
  const rejected: RejectedSpan[] = [];

  // The whole of what an over-budget request is told, made once and pushed by
  // reference: a client that sent a hundred thousand spans is owed a count of
  // what was refused, not a hundred thousand copies of one sentence.
  let excess: RejectedSpan | undefined;
  let normalisedBytes = 0;

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
          spans.length >= MAXIMUM_SPANS_PER_REQUEST ||
          normalisedBytes >= MAXIMUM_NORMALISED_BYTES
        ) {
          excess ??= {
            reason:
              spans.length >= MAXIMUM_SPANS_PER_REQUEST
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
        normalisedBytes += Buffer.byteLength(payload);

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
          toolName: tool === undefined ? "" : attribute(attributes, tool.name),
          toolArguments:
            tool === undefined ? "" : attribute(attributes, tool.arguments),
          toolResult:
            tool?.result === undefined
              ? ""
              : attribute(attributes, tool.result),
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
          // production connection-kind fact.
          connectionType:
            attribution.source === "simulation"
              ? firstAttribute(
                  [attributes, resourceSpans.resource?.attributes],
                  CONNECTION_KIND_ATTRIBUTES,
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
           * The platform's own statement that the conversation is over, and
           * only where a platform this door recognises made it.
           *
           * Two conditions, both required. `root` says the framework's session
           * span arrived — the one span the whole trace happened inside, named
           * in that framework's own vocabulary rather than guessed from the
           * shape of the trace. `agentPlatform` says the scope is a production
           * platform this release supports. A scope nobody recognises reaches
           * `other` and says nothing here, which is the point: a parentless
           * span is not an ending, and an exporter flush whose parent never
           * arrived produces one.
           *
           * A simulation's root is deliberately `false`. Its scope maps to no
           * production platform, and the completion fact for a simulation
           * belongs to the lifecycle that ends the run — asserting it here as
           * well would be two producers of one fact, which is how one
           * conversation comes to be graded twice.
           */
          endsTrace: kind === "root" && agentPlatform !== "",
        });
      }
    }
  }

  return { spans, rejected };
}
