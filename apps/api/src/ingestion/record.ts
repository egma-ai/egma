import {
  LARGEST_BOUNDED_RECORD_BYTES,
  spanContentHash,
  type NewSpan,
} from "@egma/db";

/**
 * The one written-down form of one span of evidence, and what makes two copies
 * of it the same evidence.
 *
 * Everything downstream of acceptance reads this shape and nothing else. A
 * record is appended to the local log, sealed into a segment, uploaded, read
 * back by the drainer after a restart it did not survive, and turned into a row
 * — so it is a **durable contract with a version on it**, not an internal
 * struct. The names here are the names in the object, and changing one is a
 * format change rather than a rename.
 *
 * ## Why the keys are not the column names
 *
 * They are close and deliberately not identical. `started_at_microseconds` is
 * an integer count; the column it eventually reaches is a `DateTime64(6)`
 * literal. Naming the record's field after the column would say that the
 * record holds what the row holds, and the day the row's encoding changes the
 * record would be carrying a lie in its own key. The record is the evidence;
 * the row is one projection of it.
 *
 * ## Numbers travel as decimal strings
 *
 * A microsecond timestamp and a nanosecond duration are 64-bit counts and JSON
 * numbers are doubles, so a round trip through `JSON.parse` would quietly move
 * a span by a few microseconds — which is invisible, survives every test that
 * compares a transcript, and makes a replay hash differently from the evidence
 * it replays. They are written as decimal strings for the same reason
 * `appendSpans` sends `duration_ns` as one.
 *
 * ## Nothing about delivery is in here
 *
 * There is no receive time, no request identifier, no source address, no
 * attempt count, and no credential of any kind. Two facts depend on that. The
 * content hash is over this evidence, so a delivery-only value would make an
 * exact replay hash differently from the evidence it replays and turn every
 * retry into an integrity defect. And the sealed object is handed to an object
 * store, so anything operational written into a record would be written into
 * the spool as well.
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
export type RecordEmitter = "egma-runtime" | "agent";

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
};

/**
 * How much room one more record needs, in bytes of the frame it is staged as.
 *
 * What a caller reserves when it asks whether the local log will take more
 * evidence. It has to be the *largest* record the acceptance path will stage
 * rather than a typical one: readiness is a promise about the next request,
 * whatever that request turns out to carry, and a reserve sized for an average
 * record is a green health check in front of a door already refusing.
 *
 * Three parts, in the order they add up:
 *
 * - the evidence itself, at every bound the record module enforces at once;
 * - the JSON it is written as — keys, quotes, separators, and the staged
 *   frame's own envelope around all of it;
 * - escaping, because a string is measured before it is written and written
 *   longer than it was measured. One byte becomes six as `\uXXXX`, so the
 *   worst case is the whole of the evidence at six times its size. That is a
 *   transcript of nothing but control characters, which is not a thing anybody
 *   sends — and a reserve that only covered what people usually send would
 *   fail exactly on the request nobody expected.
 *
 * **It does not cover `payload`, which has no bound to cover.** A provider
 * document arrives as it is, and no part of this path refuses one for its
 * size. A record whose payload is larger than this reserve can still meet
 * backpressure while readiness is green; what this rules out is the far more
 * ordinary case, where a log with room for a hundred more records reports
 * writable and refuses every one of them.
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
] as const satisfies readonly (keyof IngestionRecord)[];

/**
 * One record as the bytes it is written as: every key present, in one fixed
 * order, and `JSON.stringify`'s own escaping for the values.
 *
 * The order is written out above rather than taken from `Object.keys`, because
 * insertion order is what `Object.keys` answers and that is a property of
 * whichever construction site built the object. Two acceptance paths building
 * the same evidence in a different field order would seal two segments with
 * different bytes, and a retry that re-grouped the same records would then be
 * asked to create an object that does not match the one already there.
 *
 * The list is checked against the type at compile time, so a field added to
 * `IngestionRecord` and not added here stops the build rather than silently
 * dropping out of the written form.
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
  };
}

/**
 * What makes two copies of one span the same evidence.
 *
 * **The arithmetic is not here, and that is the point.** The stored
 * `content_hash` is what a replay is judged against, so the value computed over
 * a record on its way into a segment and the value computed over the row it
 * becomes have to be the same value — and two implementations of one
 * fingerprint is one of them quietly deciding that a conflict is a replay. The
 * canonical form lives beside the span type it describes, in `@egma/db`, and
 * this function is the record's way of asking it.
 *
 * The format version is outside the hash as a consequence: it says how the
 * evidence is written down, not what the evidence says. Two segments written
 * under two versions carrying one span's evidence are an exact replay of each
 * other, which is what a reader of either would expect.
 */
export function contentHashOf(record: IngestionRecord): string {
  return spanContentHash(spanFor(record));
}

/**
 * A record read back out of a segment, checked far enough to be trusted as one.
 *
 * The drainer meets bytes that were written by an older Egma, or by nothing at
 * all. This refuses a shape rather than repairing it: a record missing a field,
 * carrying an extra one, or holding the wrong type for one is an internal
 * defect, and the segment holding it is retained rather than partly written.
 *
 * Nothing here looks at what a value *says*. A transcript is not validated, a
 * tool result is not parsed, and no string is measured against a bound —
 * evidence was already accepted, and refusing it after acknowledgement would be
 * this side reclassifying its own promise as bad customer input.
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
