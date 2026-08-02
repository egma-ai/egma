import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";

/**
 * Writing spans, and the only way anything ever does.
 *
 * The ClickHouse client is as private as the Postgres pool beside it, so a door
 * that has decoded some telemetry hands rows to this function and never touches
 * the store. Tenancy is stamped here from the `AuthContext` and from nothing a
 * caller passed: `NewSpan` has no organization and no project on it, so a
 * payload claiming one cannot be obeyed even by a handler that wanted to.
 *
 * **Append only, and it is the whole contract.** No read before the write, no
 * update, no delete, no merge of a later part into an earlier one. A span
 * arrives once, complete. Duplicates are not resolved at read time on this
 * table — the obligation not to send twice belongs to whoever wrote the span,
 * and ClickHouse's block-level insert dedup is the backstop under it, which is
 * why the rows this function builds are a pure function of its arguments: an
 * exporter's retry of the same batch has to produce the same bytes or the
 * backstop does not fire.
 */

/**
 * `simulation` when a run produced it, `production` for everything else.
 * Explicit on the row rather than inferred from `run_id` being empty: comparing
 * a simulation against a production trace is the premise of the product, so the
 * two dimensions have to compose instead of sharing a slot.
 */
export type SpanSource = "simulation" | "production";

/**
 * Which side measured this. egma's outside view of a trace and the agent's
 * inside view are different measurements, and averaging them together is the
 * same error as mixing two audio bands.
 */
export type SpanEmitter = "egma-runtime" | "agent";

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
  readonly connectionType: string;
  /** Measured, never declared. Zero when nothing measured it. */
  readonly audioSampleRateHz: number;
  readonly audioEncoding: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly testVersionId: string;
  readonly digitalHumanVersionId: string;
  /**
   * The provider's payload for this span, exactly as it arrived, and the reason
   * truncating the columns above loses nothing: whatever a cap shortened is
   * still here in full. Never truncated, never normalised — data that was not
   * captured cannot be recovered by any later migration.
   */
  readonly payload: string;
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
 */
const MAXIMUM_BYTES_PER_INSERT = 16 * 1024 * 1024;

/**
 * Where a single field stops.
 *
 * Only the normalised columns are capped, and never the verbatim payload — the
 * whole arrangement is that a cap costs presentation rather than data, because
 * the untruncated original is on the same row. Transcripts and tool payloads
 * are what actually reach these, which is why they get the generous ones.
 */
const FIELD_LIMITS = {
  name: 1_024,
  kind: 128,
  status: 64,
  text: 65_536,
  audioUrl: 2_048,
  toolName: 256,
  toolArguments: 65_536,
  toolResult: 65_536,
  providerCallId: 512,
  connectionType: 64,
  audioEncoding: 64,
  environment: 128,
} as const satisfies Readonly<Record<string, number>>;

/**
 * Cut at a limit without splitting a character in half. A lone surrogate is not
 * text in any encoding, and ClickHouse stores what it is given.
 */
function truncated(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
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

/** One span as the columns of the `spans` table, tenancy included. */
function rowFor(auth: AuthContext, span: NewSpan): Record<string, unknown> {
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    organization_id: auth.organizationId,
    // A credential naming no project is for the whole customer, and its rows
    // file under the sentinel the schema already declares.
    project_id: auth.projectId ?? "default",
    source: span.source,
    emitter: span.emitter,
    environment: truncated(span.environment, FIELD_LIMITS.environment),
    started_at: asDateTime64(span.startedAtMicroseconds),
    // A 64-bit count does not survive a JSON number, so it travels as a string.
    duration_ns: span.durationNanoseconds.toString(),
    name: truncated(span.name, FIELD_LIMITS.name),
    kind: truncated(span.kind, FIELD_LIMITS.kind),
    status: truncated(span.status, FIELD_LIMITS.status),
    text: truncated(span.text, FIELD_LIMITS.text),
    audio_url: truncated(span.audioUrl, FIELD_LIMITS.audioUrl),
    tool_name: truncated(span.toolName, FIELD_LIMITS.toolName),
    tool_arguments: truncated(span.toolArguments, FIELD_LIMITS.toolArguments),
    tool_result: truncated(span.toolResult, FIELD_LIMITS.toolResult),
    provider_call_id: truncated(
      span.providerCallId,
      FIELD_LIMITS.providerCallId,
    ),
    connection_type: truncated(span.connectionType, FIELD_LIMITS.connectionType),
    audio_sample_rate_hz: span.audioSampleRateHz,
    audio_encoding: truncated(span.audioEncoding, FIELD_LIMITS.audioEncoding),
    run_id: span.runId,
    agent_id: span.agentId,
    agent_version_id: span.agentVersionId,
    test_version_id: span.testVersionId,
    digital_human_version_id: span.digitalHumanVersionId,
    payload: span.payload,
  };
}

/**
 * Rows in, insert-sized groups out, in the order they arrived.
 *
 * A single row larger than the byte cap still goes, alone: splitting is how a
 * big batch gets written, never a reason to refuse one. Deterministic, because
 * an exporter's retry only dedups if it produces the identical blocks.
 */
function inserts(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[][] {
  const batches: Record<string, unknown>[][] = [];
  let batch: Record<string, unknown>[] = [];
  let bytes = 0;

  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (
      batch.length > 0 &&
      (batch.length >= MAXIMUM_ROWS_PER_INSERT ||
        bytes + size > MAXIMUM_BYTES_PER_INSERT)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * File these spans under the caller's organization and project.
 *
 * Nothing is read first and nothing is overwritten. Sending the same batch
 * twice is not an error and is not a second copy: ClickHouse drops a repeat of
 * a byte-identical insert block, which is the one protection that works on the
 * path egma does not own — an OpenTelemetry exporter's retry is byte-identical
 * by design.
 */
export async function appendSpans(
  auth: AuthContext,
  spans: readonly NewSpan[],
): Promise<AppendedSpans> {
  if (spans.length === 0) return { appended: 0, batches: 0 };

  const batches = inserts(spans.map((span) => rowFor(auth, span)));
  for (const values of batches) {
    await traceStore().insert({ table: "spans", values, format: "JSONEachRow" });
  }

  return { appended: spans.length, batches: batches.length };
}
