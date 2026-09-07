import {
  LARGEST_BOUNDED_RECORD_BYTES,
  spanContentHash,
  type NewSpan,
  type ProviderUsageEvidence,
} from "@egma/db";

/**
 * Versioned durable span format shared by the local log, segments, and drainer.
 * Changing keys requires format compatibility work. Store 64-bit timestamps
 * and durations as decimal strings to preserve exact values through JSON.
 * Keep delivery metadata out of evidence so retries retain the same fingerprint.
 */

/**
 * The format version, carried on every record and in every segment header.
 *
 * A constant rather than a setting: it is a property of the code that wrote the
 * object, and two deployments that could disagree about it would be two
 * deployments writing objects a third cannot read.
 */
export const RECORD_FORMAT_VERSION = 1;

/**
 * `simulation` when a run produced it, `production` for everything else.
 *
 * Written out here rather than borrowed from the span type, and the same for
 * the emitter below. They look like duplication and are the version rule doing
 * its work: a third value added to the stored type would stop this build at
 * `recordFor` instead of silently starting to write a value into objects that
 * an older reader has no case for.
 */
export type RecordSource = "simulation" | "production";

/** Which side measured this — Egma's outside view, or the agent's inside one. */
export type RecordEmitter = "egma-runtime" | "agent" | "grader";

/**
 * One normalized span, as it is written down.
 *
 * Every field is present on every record, including the empty ones. Absence is
 * a case the construction site states rather than one a caller can leave out:
 * an optional key would make two records with the same evidence serialise to
 * different bytes, and the content hash is over the bytes.
 */
export type IngestionRecord = {
  /** The format version. See `RECORD_FORMAT_VERSION`. */
  readonly v: number;
  /** Adopted from the wire, never minted here. */
  readonly trace_id: string;
  readonly span_id: string;
  /** Empty on the root span, which is how a root is recognised. */
  readonly parent_span_id: string;
  readonly source: RecordSource;
  readonly emitter: RecordEmitter;
  readonly environment: string;
  /** Microseconds since the epoch, as a decimal string. */
  readonly started_at_microseconds: string;
  /** Full nanoseconds, as a decimal string. */
  readonly duration_nanoseconds: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly text: string;
  readonly audio_url: string;
  readonly tool_name: string;
  readonly tool_arguments: string;
  readonly tool_result: string;
  readonly provider_call_id: string;
  readonly agent_platform: string;
  readonly platform_agent_id: string;
  readonly platform_agent_name: string;
  readonly platform_agent_version: string;
  /**
   * The connection's type, under the envelope's own frozen name.
   *
   * The TypeScript field became `connectionType` (ADR-0015) and this key did
   * not follow it. The envelope is versioned by `v` (ADR-0014), so its key
   * names are a wire contract with objects already written under them —
   * changing one is a version change with a reader for both spellings behind
   * it, never a rename.
   */
  readonly connection_kind: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly agent_version_id: string;
  readonly test_version_id: string;
  readonly persona_version_id: string;
  readonly payload: string;
  /**
   * The agent platform's own statement that this span ends its trace.
   *
   * Carried from the platform normalizer rather than derived downstream: a
   * parentless span is not an ending, and inferring one from the shape of a
   * trace is what let a mid-conversation span mark a production conversation
   * complete. False is the ordinary value and means the platform said nothing.
   */
  readonly ends_trace: boolean;
  readonly usage?: ProviderUsageEvidence | undefined;
};

/**
 * Readiness reserve for bounded fields, worst-case JSON escaping (6×),
 * and envelope overhead. Payload has no size bound and is excluded, so a
 * large payload can encounter backpressure while readiness is still green.
 */
export const LARGEST_STAGEABLE_RECORD_BYTES =
  LARGEST_BOUNDED_RECORD_BYTES * 6 + 4_096;

/** Every key of a record, in the one order canonical bytes are written in. */
const RECORD_KEYS = [
  "agent_id",
  "agent_platform",
  "agent_version_id",
  "audio_url",
  "connection_kind",
  "duration_nanoseconds",
  "emitter",
  "ends_trace",
  "environment",
  "kind",
  "name",
  "parent_span_id",
  "payload",
  "persona_version_id",
  "platform_agent_id",
  "platform_agent_name",
  "platform_agent_version",
  "provider_call_id",
  "run_id",
  "source",
  "span_id",
  "started_at_microseconds",
  "status",
  "test_version_id",
  "text",
  "tool_arguments",
  "tool_name",
  "tool_result",
  "trace_id",
  "v",
  "usage",
] as const satisfies readonly (keyof IngestionRecord)[];

/**
 * Serialize keys in a fixed order so equivalent records produce the same
 * bytes regardless of construction order. Keep RECORD_KEYS complete when
 * changing IngestionRecord; satisfies checks key validity, not exhaustiveness.
 */
export function canonicalRecordJson(record: IngestionRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const key of RECORD_KEYS) ordered[key] = record[key];
  return JSON.stringify(ordered);
}

/**
 * One record as the span it will be stored as.
 *
 * The two shapes carry the same evidence under two spellings, and this is the
 * only place that knows both. Tenancy is deliberately not here: a span is filed
 * under the organization and project the *segment* was sealed for, so a record
 * has no way to name a tenant even in principle.
 */
export function spanFor(record: IngestionRecord): NewSpan {
  return {
    traceId: record.trace_id,
    spanId: record.span_id,
    parentSpanId: record.parent_span_id,
    source: record.source,
    emitter: record.emitter,
    environment: record.environment,
    startedAtMicroseconds: BigInt(record.started_at_microseconds),
    durationNanoseconds: BigInt(record.duration_nanoseconds),
    name: record.name,
    kind: record.kind,
    status: record.status,
    text: record.text,
    audioUrl: record.audio_url,
    toolName: record.tool_name,
    toolArguments: record.tool_arguments,
    toolResult: record.tool_result,
    providerCallId: record.provider_call_id,
    agentPlatform: record.agent_platform,
    platformAgentId: record.platform_agent_id,
    platformAgentName: record.platform_agent_name,
    platformAgentVersion: record.platform_agent_version,
    connectionType: record.connection_kind,
    runId: record.run_id,
    agentId: record.agent_id,
    agentVersionId: record.agent_version_id,
    testVersionId: record.test_version_id,
    personaVersionId: record.persona_version_id,
    payload: record.payload,
    endsTrace: record.ends_trace,
    ...(record.usage ? { usage: record.usage } : {}),
  };
}

/** And back: one normalized span as the record that will be written down. */
export function recordFor(span: NewSpan): IngestionRecord {
  return {
    v: RECORD_FORMAT_VERSION,
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    source: span.source,
    emitter: span.emitter,
    environment: span.environment,
    started_at_microseconds: span.startedAtMicroseconds.toString(),
    duration_nanoseconds: span.durationNanoseconds.toString(),
    name: span.name,
    kind: span.kind,
    status: span.status,
    text: span.text,
    audio_url: span.audioUrl,
    tool_name: span.toolName,
    tool_arguments: span.toolArguments,
    tool_result: span.toolResult,
    provider_call_id: span.providerCallId,
    agent_platform: span.agentPlatform,
    platform_agent_id: span.platformAgentId,
    platform_agent_name: span.platformAgentName,
    platform_agent_version: span.platformAgentVersion,
    connection_kind: span.connectionType,
    run_id: span.runId,
    agent_id: span.agentId,
    agent_version_id: span.agentVersionId,
    test_version_id: span.testVersionId,
    persona_version_id: span.personaVersionId,
    payload: span.payload,
    ends_trace: span.endsTrace,
    ...(span.usage ? { usage: span.usage } : {}),
  };
}

/**
 * Use the database's canonical span fingerprint so staged and stored evidence
 * compare identically. The record format version is excluded from that hash.
 */
export function contentHashOf(record: IngestionRecord): string {
  return spanContentHash(spanFor(record));
}

/**
 * Validate exact keys, field types, version, and decimal integer syntax.
 * Do not repair accepted evidence or parse its text/payload content. Invalid
 * records cause the containing segment to be retained by the drainer.
 */
export function recordFrom(value: unknown): IngestionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedRecordError("a record is a JSON object");
  }
  const offered = value as Record<string, unknown>;

  const extra = Object.keys(offered).filter(
    (key) => !(RECORD_KEYS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new MalformedRecordError(
      `a record carries fields this version does not know: ${extra.sort().join(", ")}`,
    );
  }

  for (const key of RECORD_KEYS) {
    const held = offered[key];
    if (key === "usage") {
      if (held !== undefined && (typeof held !== "object" || held === null || Array.isArray(held))) throw new MalformedRecordError("usage is an object");
      continue;
    }
    const wanted =
      key === "v" ? "number" : key === "ends_trace" ? "boolean" : "string";
    if (typeof held !== wanted) {
      throw new MalformedRecordError(
        `a record's ${key} is ${held === undefined ? "missing" : `a ${typeof held}`} rather than a ${wanted}`,
      );
    }
  }

  if (offered["v"] !== RECORD_FORMAT_VERSION) {
    throw new MalformedRecordError(
      `a record states format version ${String(offered["v"])} and this Egma reads ${RECORD_FORMAT_VERSION}`,
    );
  }

  for (const key of ["started_at_microseconds", "duration_nanoseconds"] as const) {
    if (!/^-?(0|[1-9][0-9]*)$/u.test(offered[key] as string)) {
      throw new MalformedRecordError(
        `a record's ${key} is not a decimal integer: ${String(offered[key])}`,
      );
    }
  }

  return offered as unknown as IngestionRecord;
}

/**
 * A record this side will not treat as evidence.
 *
 * It is an internal defect wherever it is raised after acceptance — the object
 * holding it stays where it is and an operator is told — and it is never
 * reported to a customer as a validation failure, because the request that
 * carried the evidence was answered as accepted long before anything read this
 * back.
 */
export class MalformedRecordError extends Error {}
