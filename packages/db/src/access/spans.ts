import { Readable } from "node:stream";

import { ClickHouseError } from "@clickhouse/client";

import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import { TraceStoreRefusedError } from "./errors.ts";

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
 * table — the obligation not to send twice belongs to whoever wrote the span.
 * ClickHouse can suppress a byte-identical insert block while that block stays
 * in its recent deduplication window. Changing, regrouping, or reordering the
 * evidence creates a different block. There is no read-time or permanent
 * per-span deduplication.
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
  /** The product or framework that produced this production evidence. */
  readonly agentPlatform: string;
  /** The platform agent reference, when the platform supplies it. */
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
  readonly connectionKind: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly testVersionId: string;
  readonly personaVersionId: string;
  /**
   * Safe provider data for this span. Every platform adapter removes
   * credentials and bearer-like values before this boundary. This field is
   * never truncated, while child spans may hold a normalized
   * provider-specific subset.
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
 * Where a single field stops, in **bytes of UTF-8**, because that is what
 * ClickHouse stores and what a `String` column is measured in. The cut itself
 * still lands on a character boundary; see `truncated`.
 *
 * Only the normalised columns are capped, and never the safe provider payload.
 * A cap costs presentation rather than data because the untruncated safe copy
 * is on the same row. Transcripts and tool payloads are what actually reach
 * these, which is why they get the generous ones.
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
  agentPlatform: 64,
  platformAgentId: 512,
  platformAgentName: 512,
  platformAgentVersion: 128,
  connectionKind: 64,
  environment: 128,
} as const satisfies Readonly<Record<string, number>>;

/** How many bytes of UTF-8 one code point becomes. */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Cut at a limit of **bytes** without splitting a character in half.
 *
 * The two units in play are not the same one: ClickHouse measures a `String`
 * column in bytes of UTF-8, and JavaScript measures a string in UTF-16 code
 * units, so a transcript of emoji is four bytes and two code units a character.
 * The budget is the store's, and the boundary is JavaScript's — iterating by
 * code point is what keeps a surrogate pair whole, because a lone surrogate is
 * not text in any encoding and ClickHouse stores what it is given.
 */
function truncated(value: string, limit: number): string {
  // The common case by far, and the only one that touches every row: a native
  // byte count and nothing else.
  if (Buffer.byteLength(value) <= limit) return value;

  let bytes = 0;
  let kept = 0;
  for (const character of value) {
    const size = utf8Bytes(character.codePointAt(0) ?? 0);
    if (bytes + size > limit) break;
    bytes += size;
    // Two code units for anything above the basic plane, and the pair is kept
    // or dropped together.
    kept += character.length;
  }
  return value.slice(0, kept);
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
    agent_platform: truncated(span.agentPlatform, FIELD_LIMITS.agentPlatform),
    platform_agent_id: truncated(
      span.platformAgentId,
      FIELD_LIMITS.platformAgentId,
    ),
    platform_agent_name: truncated(
      span.platformAgentName,
      FIELD_LIMITS.platformAgentName,
    ),
    platform_agent_version: truncated(
      span.platformAgentVersion,
      FIELD_LIMITS.platformAgentVersion,
    ),
    connection_type: truncated(span.connectionKind, FIELD_LIMITS.connectionKind),
    run_id: span.runId,
    agent_id: span.agentId,
    agent_version_id: span.agentVersionId,
    test_version_id: span.testVersionId,
    persona_version_id: span.personaVersionId,
    payload: span.payload,
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
 * Rows in, insert-sized blocks out, in the order they arrived.
 *
 * **One month per block, first**, because the partition key is
 * `toYYYYMM(started_at)` and `max_partitions_per_insert_block` defaults to 100:
 * a client's clock decides how many months a batch spans, and a batch of spans
 * across more than a hundred of them would otherwise be refused whole by the
 * engine. Splitting by month is a pure function of the rows, so it costs
 * nothing on ordinary traffic — a trace lives inside one month — and it takes
 * the engine's limit out of a client's hands.
 *
 * A single row larger than the byte cap still goes, alone: splitting is how a
 * big batch gets written, never a reason to refuse one.
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
 * The refusals that are about the rows rather than about the moment.
 *
 * Named symbolically, because ClickHouse's names are stable and its numbers are
 * the thing nobody can read. Everything absent from this list — a connection
 * that failed, a memory limit, a table behind on its merges — is a *later*
 * problem, stays an ordinary error, and reaches an exporter as a status it will
 * retry. `TOO_MANY_PARTS` is deliberately not here: it is both "this block
 * touches too many partitions" and "this table is behind on its merges", and
 * the second is the retryable case. The first is prevented above instead, by
 * splitting a batch by month before it is sent.
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

/**
 * File these spans under the caller's organization and project.
 *
 * Nothing is read first and nothing is overwritten. ClickHouse may suppress a
 * recent byte-identical block, but changed evidence appends even when it reuses
 * span ids. There is no read-time or permanent per-span collapse.
 */
export async function appendSpans(
  auth: AuthContext,
  spans: readonly NewSpan[],
): Promise<AppendedSpans> {
  if (spans.length === 0) return { appended: 0, batches: 0 };

  const batches = preparedInserts(auth, spans);
  for (const block of batches) {
    // The rows go out as the lines they were already serialised into. The
    // client's own `insert` would take the objects and stringify each one
    // again, which on a batch of fat payloads is the whole batch materialised
    // twice for no gain — so the pre-serialised body is handed to the raw
    // path instead.
    try {
      const { stream } = await traceStore().exec({
        query: `INSERT INTO ${SPANS_TABLE} FORMAT JSONEachRow`,
        values: Readable.from(lines(block.lines), { objectMode: false }),
      });
      // An insert answers with an empty body, and the empty body still has to
      // be read: a response left undrained keeps its socket out of the pool
      // and eventually arrives as a connection reset on somebody else's query.
      for await (const chunk of stream) void chunk;
    } catch (cause) {
      throw refusal(cause);
    }
  }

  return { appended: spans.length, batches: batches.length };
}
