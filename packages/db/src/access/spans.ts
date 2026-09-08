import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ClickHouseError } from "@clickhouse/client";

import { canonicalUsage, usageEvidenceHash, type ProviderUsageEvidence } from "../models/provider-usage.ts";

import { billing } from "../billing/ports.ts";

import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import {
  OversizeRecordError,
  TraceStoreRefusedError,
  UnstorableInstantError,
} from "./errors.ts";
import {
  EARLIEST_READABLE_MICROSECONDS,
  LATEST_READABLE_MICROSECONDS,
} from "./span-identity.ts";

/**
 * Append spans with organization and project stamped from AuthContext.
 * Span identity is organization, project, trace, and span. Callers compare
 * committedSpans before replaying. Usage variants also survive merges, so an
 * ambiguous concurrent insert cannot silently replace a committed charge.
 * Block and segment tokens reduce duplicate inserts within finite store windows;
 * identity-based reads handle exact replays afterward. Reject oversized fields whole.
 */

/**
 * `simulation` when a run produced it, `production` for everything else.
 * Explicit on the row rather than inferred from `run_id` being empty: comparing
 * a simulation against a production trace is the premise of the product, so the
 * two facts have to compose instead of sharing a slot.
 */
export type SpanSource = "simulation" | "production";

/**
 * Which side measured this. Egma's outside view of a trace and the agent's
 * inside view are different measurements, so they must not be averaged
 * together.
 */
export type SpanEmitter = "egma-runtime" | "agent" | "grader";

/**
 * One span, ready to be filed.
 *
 * Every field is required, including the empty ones. Absence is a case each
 * construction site has to state rather than one a caller can leave out and not
 * think about, which is the same reason `AuthContext.projectId` is
 * `string | undefined` rather than optional.
 */
export type NewSpan = {
  /**
   * Adopted from the wire, never minted here. OpenTelemetry ids are fixed-width
   * binary, which egma's own id format cannot be encoded in, so these two are
   * the recorded exception to the prefixed-id rule and carry no format
   * guarantee at all.
   */
  readonly traceId: string;
  readonly spanId: string;
  /** Empty on the root span, which is how a root is recognised. */
  readonly parentSpanId: string;
  readonly source: SpanSource;
  readonly emitter: SpanEmitter;
  /**
   * Discovered on first ingest rather than declared, with `'default'` when the
   * telemetry named none. Names beginning `egma` are reserved and the door
   * refuses them before a row gets here.
   */
  readonly environment: string;
  /**
   * **Microseconds** since the epoch, as the writer stamped it when the span
   * opened. OTLP carries nanoseconds; dividing happens before this call because
   * the column is `DateTime64(6)` and inserting raw nanoseconds would file every
   * row fifty thousand years from now.
   */
  readonly startedAtMicroseconds: bigint;
  /** Full nanoseconds — the precision `started_at` gives up lives here. */
  readonly durationNanoseconds: bigint;
  readonly name: string;
  /**
   * What kind of timed thing this is: `turn:human`, `turn:agent`, or one of the
   * steps inside a turn. The turn-grain view selects on the `turn:` prefix.
   */
  readonly kind: string;
  readonly status: string;
  readonly text: string;
  readonly audioUrl: string;
  readonly toolName: string;
  readonly toolArguments: string;
  readonly toolResult: string;
  /**
   * The vendor's own identifier for this trace — a room name, a job id,
   * whatever the provider hands out. Absence is normal.
   */
  readonly providerCallId: string;
  /** The product or framework that produced this production evidence. */
  readonly agentPlatform: string;
  /** The platform agent reference, when the platform supplies it. */
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
  readonly connectionType: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly testVersionId: string;
  readonly personaVersionId: string;
  /**
   * The provider's own document for this span, as it arrived.
   *
   * Never shortened and never rewritten. A platform adapter omits the transport
   * fields that are credentials by naming them exactly — Retell's top-level
   * `access_token` and the six authentication headers inside its own
   * `custom_sip_headers` map — and looks at nothing else on the way past. What
   * a value happens to contain is evidence.
   */
  readonly payload: string;
  /**
   * Explicit evidence that this span ends the trace, supplied by the normalizer.
   * Use false when unknown; a missing parent does not imply completion.
   */
  readonly endsTrace: boolean;
  readonly usage?: ProviderUsageEvidence | undefined;
};

export type AppendedSpans = {
  readonly appended: number;
  /** How many inserts it took. More than one means the batch was split. */
  readonly batches: number;
};

/**
 * How many rows one insert may carry.
 *
 * A batch larger than this is split rather than refused and never dropped: an
 * exporter that sends a hundred thousand spans at once is not doing anything
 * wrong, and a door that answered "too big" would lose a trace to a limit
 * nobody told it about.
 */
const MAXIMUM_ROWS_PER_INSERT = 5_000;

/**
 * And how many bytes, because rows are not the same size. A trace full of long
 * transcripts reaches a size limit long before a row count.
 *
 * Bytes of the UTF-8 the store is actually sent, counted on the serialised row
 * rather than on its JavaScript string length: a transcript of CJK or emoji is
 * three or four bytes a character, and a budget kept in UTF-16 code units would
 * be three or four times the one it claimed to be.
 */
const MAXIMUM_BYTES_PER_INSERT = 16 * 1024 * 1024;

/** The one table this module writes. */
const SPANS_TABLE = "spans";

/**
 * UTF-8 byte limits for normalized fields. Reject the whole record when exceeded;
 * never truncate evidence. payload has no field limit here and may form a large
 * single-row insert block.
 */
const FIELD_BOUNDS = {
  name: 1_024,
  kind: 128,
  status: 64,
  text: 65_536,
  audioUrl: 2_048,
  toolName: 256,
  toolArguments: 65_536,
  toolResult: 65_536,
  providerCallId: 512,
  agentPlatform: 64,
  platformAgentId: 512,
  platformAgentName: 512,
  platformAgentVersion: 128,
  connectionType: 64,
  environment: 128,
} as const satisfies Readonly<Record<string, number>>;

/** Which fields carry a bound, in the order a refusal reports them. */
const BOUNDED_FIELDS = Object.keys(FIELD_BOUNDS) as readonly (keyof typeof FIELD_BOUNDS)[];

/**
 * Sum of all bounded field limits for ingestion reservations. A record may use
 * every limit at once. This excludes payload and is not a total record-size bound.
 */
export const LARGEST_BOUNDED_RECORD_BYTES = BOUNDED_FIELDS.reduce(
  (total, field) => total + FIELD_BOUNDS[field],
  0,
);

/**
 * Reject the first field over its UTF-8 byte limit. Acceptance calls this before
 * staging; appendSpans repeats the same validation before sending any insert.
 */
export function refuseOversizeRecord(span: NewSpan): void {
  for (const field of BOUNDED_FIELDS) {
    const bound = FIELD_BOUNDS[field];
    const bytes = Buffer.byteLength(span[field]);
    if (bytes > bound) {
      throw new OversizeRecordError(field, bound, bytes);
    }
  }
}

/**
 * Require a span start within the identity probe's readable range. The upper
 * bound is exclusive because a half-open probe must extend beyond the span.
 */
export function refuseUnstorableInstant(span: NewSpan): void {
  const instant = span.startedAtMicroseconds;
  if (
    instant < EARLIEST_READABLE_MICROSECONDS ||
    instant >= LATEST_READABLE_MICROSECONDS
  ) {
    throw new UnstorableInstantError(instant, {
      earliest: EARLIEST_READABLE_MICROSECONDS,
      latest: LATEST_READABLE_MICROSECONDS,
    });
  }
}

/**
 * The exact literal ClickHouse's `DateTime64(6)` reads, built from an integer
 * count of microseconds so that no floating-point step can move a row into a
 * different granule — or, worse, make a retry land in a different one than the
 * original and defeat the dedup backstop.
 */
function asDateTime64(microseconds: bigint): string {
  const MILLION = 1_000_000n;
  // Floor division, so a timestamp before 1970 keeps a non-negative remainder.
  let seconds = microseconds / MILLION;
  let remainder = microseconds % MILLION;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLION;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole.replace("T", " ")}.${remainder.toString().padStart(6, "0")}`;
}

/**
 * Canonical evidence used by ingestion and storage fingerprints: sorted keys and
 * decimal strings for bigint values. Organization and project belong to the identity.
 * Keep connection_kind unchanged: stored hashes include this exact key. Changing
 * it requires an evidence migration, even though the source field is connectionType.
 */
function canonicalEvidence(span: NewSpan): string {
  const evidence: Record<string, string | boolean> = {
    agent_id: span.agentId,
    agent_platform: span.agentPlatform,
    agent_version_id: span.agentVersionId,
    audio_url: span.audioUrl,
    connection_kind: span.connectionType,
    duration_nanoseconds: span.durationNanoseconds.toString(),
    emitter: span.emitter,
    ends_trace: span.endsTrace,
    environment: span.environment,
    kind: span.kind,
    name: span.name,
    parent_span_id: span.parentSpanId,
    payload: span.payload,
    persona_version_id: span.personaVersionId,
    platform_agent_id: span.platformAgentId,
    platform_agent_name: span.platformAgentName,
    platform_agent_version: span.platformAgentVersion,
    provider_call_id: span.providerCallId,
    run_id: span.runId,
    source: span.source,
    span_id: span.spanId,
    started_at_microseconds: span.startedAtMicroseconds.toString(),
    status: span.status,
    test_version_id: span.testVersionId,
    text: span.text,
    tool_arguments: span.toolArguments,
    tool_name: span.toolName,
    tool_result: span.toolResult,
    trace_id: span.traceId,
  };
  if (span.usage) evidence["usage"] = usageEvidenceHash(span.usage);
  return JSON.stringify(evidence, Object.keys(evidence).sort());
}

/**
 * Hash canonical evidence to distinguish exact replay from conflicting content.
 * Acceptance and storage share this function; never overwrite a different stored hash.
 */
export function spanContentHash(span: NewSpan): string {
  return createHash("sha256").update(canonicalEvidence(span), "utf8").digest("hex");
}

/** The project every stored span must belong to. */
function projectForTrace(auth: AuthContext): string {
  if (auth.projectId === undefined) {
    throw new Error("trace spans require a project-scoped authorization context");
  }
  return auth.projectId;
}

/** One span as the columns of the `spans` table, tenancy included. */
function rowFor(auth: AuthContext, span: NewSpan): Record<string, unknown> {
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    organization_id: auth.organizationId,
    project_id: projectForTrace(auth),
    source: span.source,
    emitter: span.emitter,
    environment: span.environment,
    started_at: asDateTime64(span.startedAtMicroseconds),
    // A 64-bit count does not survive a JSON number, so it travels as a string.
    duration_ns: span.durationNanoseconds.toString(),
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
    connection_type: span.connectionType,
    run_id: span.runId,
    agent_id: span.agentId,
    agent_version_id: span.agentVersionId,
    test_version_id: span.testVersionId,
    persona_version_id: span.personaVersionId,
    payload: span.payload,
    content_hash: spanContentHash(span),
    usage_identity_hash: span.usage?.price ? usageEvidenceHash(span.usage) : "",
    usage_received_at: asDateTime64(BigInt(span.usage ? new Date(span.usage.receivedAt).getTime() : 0) * 1_000n),
    usage_occurred_at: asDateTime64(BigInt(span.usage ? new Date(span.usage.occurredAt).getTime() : 0) * 1_000n),
    usage_provider: span.usage?.provider ?? "",
    usage_model: span.usage?.model ?? "",
    usage_operation: span.usage?.operation ?? "",
    usage_payment_source: span.usage?.paymentSource ?? "",
    usage_measurement: span.usage?.measurement ?? "",
    usage_provider_ref: span.usage?.providerRef ?? "",
    usage_credential_ref: span.usage?.credentialRef ?? "",
    usage_unit: span.usage?.price?.unit ?? "",
    usage_quantities: span.usage?.quantities ?? {},
    usage_priced_by: span.usage?.price?.pricedBy ?? {},
    usage_amount_micros: String(span.usage?.price?.amountMicros ?? 0),
    usage_evidence: span.usage ? canonicalUsage(span.usage) : "",

  };
}

/**
 * One row, serialised exactly once.
 *
 * The line is what is sent, its byte count is what the batch budget is spent
 * from, and its month is which partition it lands in — three questions off one
 * `JSON.stringify` instead of one throwaway serialisation per row for sizing
 * and a second one inside the client for the wire.
 */
type SerialisedRow = {
  readonly line: string;
  readonly bytes: number;
  /** `YYYY-MM`, which is `toYYYYMM(started_at)` written the way the literal is. */
  readonly month: string;
};

function serialised(auth: AuthContext, span: NewSpan): SerialisedRow {
  const row = rowFor(auth, span);
  const line = JSON.stringify(row);
  return {
    line,
    bytes: Buffer.byteLength(line),
    month: String(row["started_at"]).slice(0, "YYYY-MM".length),
  };
}

/** One insert as it goes to the store. */
type InsertBlock = {
  readonly lines: readonly string[];
};

/** The observable shape of the pure work done before ClickHouse is asked. */
export type SpanInsertPlan = {
  readonly spans: number;
  readonly batches: number;
};

/**
 * Group rows by month, then split by row and byte limits within each month.
 * Preserve order within each month, not across months. A row over the byte limit
 * is sent alone. One month per block avoids multi-partition insert failures.
 */
function inserts(rows: readonly SerialisedRow[]): InsertBlock[] {
  // Insertion-ordered, so the first month to arrive is the first block written
  // and a retry of the same batch produces the same blocks in the same order.
  const months = new Map<string, SerialisedRow[]>();
  for (const row of rows) {
    const month = months.get(row.month);
    if (month === undefined) months.set(row.month, [row]);
    else month.push(row);
  }

  const blocks: InsertBlock[] = [];
  const close = (block: readonly SerialisedRow[]): void => {
    blocks.push({
      lines: block.map((row) => row.line),
    });
  };

  for (const month of months.values()) {
    let block: SerialisedRow[] = [];
    let bytes = 0;

    for (const row of month) {
      if (
        block.length > 0 &&
        (block.length >= MAXIMUM_ROWS_PER_INSERT ||
          bytes + row.bytes > MAXIMUM_BYTES_PER_INSERT)
      ) {
        close(block);
        block = [];
        bytes = 0;
      }
      block.push(row);
      bytes += row.bytes;
    }

    if (block.length > 0) close(block);
  }

  return blocks;
}

/**
 * Plan the exact inserts without performing I/O.
 *
 * This is an internal test seam, not part of the package export. It keeps the
 * 130-month safety proof on the same serialisation and grouping code that
 * `appendSpans` uses, without making ClickHouse execute 130 network writes.
 */
export function planSpanInserts(
  auth: AuthContext,
  spans: readonly NewSpan[],
): SpanInsertPlan {
  const blocks = preparedInserts(auth, spans);
  return {
    spans: spans.length,
    batches: blocks.length,
  };
}

/** The shared pure preparation behind planning and writing. */
function preparedInserts(
  auth: AuthContext,
  spans: readonly NewSpan[],
): InsertBlock[] {
  return inserts(spans.map((span) => serialised(auth, span)));
}

/**
 * Errors caused by invalid rows become permanent ingestion refusals. Leave all
 * other errors retryable. TOO_MANY_PARTS can reflect merge backlog, so it stays
 * retryable; monthly insert blocks avoid the partition-count case.
 */
const REFUSED_BY_THE_DATA: ReadonlySet<string> = new Set([
  "ARGUMENT_OUT_OF_BOUND",
  "CANNOT_PARSE_DATE",
  "CANNOT_PARSE_DATETIME",
  "CANNOT_PARSE_ESCAPE_SEQUENCE",
  "CANNOT_PARSE_INPUT_ASSERTION_FAILED",
  "CANNOT_PARSE_NUMBER",
  "CANNOT_PARSE_QUOTED_STRING",
  "CANNOT_PARSE_TEXT",
  "CANNOT_PARSE_UUID",
  "DUPLICATE_COLUMN",
  "INCORRECT_DATA",
  "NO_SUCH_COLUMN_IN_TABLE",
  "TOO_LARGE_STRING_SIZE",
  "TYPE_MISMATCH",
  "VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE",
  "VIOLATED_CONSTRAINT",
]);

/**
 * The store's answer to a batch, in egma's own vocabulary — or the original
 * error, when what went wrong was not about the batch.
 */
function refusal(cause: unknown): unknown {
  if (!(cause instanceof ClickHouseError)) return cause;
  if (cause.type === undefined || !REFUSED_BY_THE_DATA.has(cause.type)) {
    return cause;
  }
  return new TraceStoreRefusedError(cause.code, cause.type, cause.message, {
    cause,
  });
}

/**
 * A block as the newline-delimited body ClickHouse reads, one row at a time.
 *
 * A generator rather than a joined string, so the whole block is never held
 * twice: each line is terminated as it goes out and collected behind the
 * stream, which on a batch of large payloads is the difference between one copy
 * of sixteen mebibytes and two.
 */
function* lines(block: readonly string[]): Generator<string> {
  for (const line of block) yield `${line}\n`;
}

export type AppendSpansOptions = {
  /**
   * Optional source segment ID used with the block index as an insert deduplication
   * token. Replaying it requires the same deterministic block plan. Callers without
   * a segment ID use ordinary block deduplication and span identity checks.
   */
  readonly segmentId?: string | undefined;
};

/**
 * Validate all field sizes before sending blocks under the context's organization
 * and project. Later insert failures may leave earlier blocks stored. Callers must
 * check committedSpans before replay to prevent conflicting evidence.
 */
export async function appendSpans(
  auth: AuthContext,
  spans: readonly NewSpan[],
  options: AppendSpansOptions = {},
): Promise<AppendedSpans> {
  if (spans.length === 0) return { appended: 0, batches: 0 };

  for (const span of spans) {
    refuseOversizeRecord(span);
    if (span.usage && !span.usage.price) throw new Error("usage must be priced before ClickHouse append; retain the durable pending record");
  }

  const batches = preparedInserts(auth, spans);
  for (const [index, block] of batches.entries()) {
    // The rows go out as the lines they were already serialised into. The
    // client's own `insert` would take the objects and stringify each one
    // again, which on a batch of fat payloads is the whole batch materialised
    // twice for no gain — so the pre-serialised body is handed to the raw
    // path instead.
    try {
      const { stream } = await traceStore().exec({
        query: `INSERT INTO ${SPANS_TABLE} FORMAT JSONEachRow`,
        values: Readable.from(lines(block.lines), { objectMode: false }),
        ...deduplicationToken(options.segmentId, index),
      });
      // An insert answers with an empty body, and the empty body still has to
      // be read: a response left undrained keeps its socket out of the pool
      // and eventually arrives as a connection reset on somebody else's query.
      for await (const chunk of stream) void chunk;
    } catch (cause) {
      throw refusal(cause);
    }
  }

  const usage = spans.flatMap((span) => span.usage?.price ? [{
    id: JSON.stringify([auth.organizationId, auth.projectId, span.traceId, span.spanId]),
    organizationId: auth.organizationId, projectId: projectForTrace(auth),
    occurredAt: new Date(span.usage.occurredAt), provider: span.usage.provider,
    model: span.usage.model, paymentSource: span.usage.paymentSource,
    amountMicros: span.usage.price.amountMicros,
  }] : []);
  if (usage.length > 0) {
    try { await billing().usage.receive(usage); }
    catch (cause) { console.error("usage sink failed after durable ClickHouse append; its facts remain available", cause); }
  }
  return { appended: spans.length, batches: batches.length };
}

/**
 * The token one block goes out under, as a settings fragment to spread into the
 * call — or nothing at all, which is a caller that named no segment.
 *
 * The table is in the name because a segment writes more than one table and a
 * token is scoped to the table it is offered against; the block index is in it
 * because a segment large enough to split writes several, and one token across
 * them would suppress every block after the first.
 */
function deduplicationToken(
  segmentId: string | undefined,
  block: number,
): { readonly clickhouse_settings?: { readonly insert_deduplication_token: string } } {
  if (segmentId === undefined || segmentId === "") return {};
  return {
    clickhouse_settings: {
      insert_deduplication_token: `${segmentId}:${SPANS_TABLE}:${block}`,
    },
  };
}
