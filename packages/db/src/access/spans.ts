import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ClickHouseError } from "@clickhouse/client";

import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import { OversizeRecordError, TraceStoreRefusedError } from "./errors.ts";

/**
 * Writing spans, and the only way anything ever does.
 *
 * The ClickHouse client is as private as the Postgres pool beside it, so a door
 * that has decoded some telemetry hands rows to this function and never touches
 * the store. Tenancy is stamped here from the `AuthContext` and from nothing a
 * caller passed: `NewSpan` has no organization and no project on it, so a
 * payload claiming one cannot be obeyed even by a handler that wanted to.
 *
 * **A span is immutable, and its identity is the whole of it**: organization,
 * project, trace and span. Nothing is read before the write and nothing is ever
 * overwritten — a second arrival of one identity is either the same evidence,
 * which is a replay and changes nothing visible, or different evidence, which is
 * an integrity defect somebody has to look at. The table collapses the first on
 * the identity above. It cannot recognise the second, and is never asked to: a
 * caller with two arrivals to reconcile checks them against `committedSpans`
 * before it appends, so a conflict is refused while both meanings still exist.
 *
 * Two shields sit in front of that, and neither is the guarantee. A byte-
 * identical insert block is dropped while it is still in the store's recent
 * window, and a caller that can name what it is replaying passes that name as
 * `segmentId` so the same output twice is dropped even when the bytes were
 * regrouped. Both windows are finite. The identity is not.
 *
 * **Nothing here shortens a value.** A record that violates a documented bound
 * is refused whole, by name, before anything is staged.
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
   * Whether the platform said in so many words that this span ends its trace.
   *
   * The fact is known at normalization time and belongs to the platform that
   * supplied it: LiveKit's session span, Retell's reported end. A platform with
   * no such fact says `false` rather than having one inferred for it, because a
   * parentless span is not an ending — an exporter flush whose parent never
   * arrived produces one too.
   *
   * Required like every other field, and required *because* the honest value is
   * so often `false`: an optional one would let a normalizer that has a real end
   * fact to state forget to state it, and the trace would then go quiet with
   * nothing anywhere saying why. Stating `false` is a sentence about the
   * platform; leaving it out is a sentence about the code.
   */
  readonly endsTrace: boolean;
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
 * ClickHouse stores and what a `String` column is measured in.
 *
 * These are **hard bounds and refusals**, not caps a value is quietly cut to
 * fit. A shortened transcript is stored as if it were the whole one: nothing on
 * the row says a cut happened, no reader can tell, and the evidence a team
 * later disputes is evidence egma edited. So a record over a bound is refused
 * by name and whoever sent it is told which field and by how much, which is a
 * thing they can act on.
 *
 * The numbers are the ones this table has always documented. `payload` has no
 * bound and never had one — it is the provider's document exactly as it
 * arrived, and the batch splitter below is what keeps a large one writable.
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
  connectionKind: 64,
  environment: 128,
} as const satisfies Readonly<Record<string, number>>;

/** Which fields carry a bound, in the order a refusal reports them. */
const BOUNDED_FIELDS = Object.keys(FIELD_BOUNDS) as readonly (keyof typeof FIELD_BOUNDS)[];

/**
 * Refuse a record that violates a documented bound, and say nothing about one
 * that does not.
 *
 * Pure, exported, and deliberately separate from the write: an acceptance path
 * has to make this decision *before* anything is staged, so that a record egma
 * will not store never enters the log, never rides a segment, and is reported
 * to whoever sent it while the request is still open. Calling it again at the
 * write is not a second opinion — it is the same function on the same record.
 *
 * The first field over its bound is the one named. A record with three
 * enormous fields has one problem, and reporting the first is enough to act on.
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
 * The one canonical form of a span's evidence, and the fingerprint taken from
 * it.
 *
 * **Every field of `NewSpan`, and nothing else.** Not the tenancy, which is
 * part of the identity this hash is filed under rather than part of the content
 * it describes; not the moment anything was received, which says how the
 * evidence travelled and not what it says; not a format version, because the
 * shape being hashed is this type and a change to it is a change to the type.
 * A rule with exceptions is a rule two implementations disagree about, and the
 * two are in different packages.
 *
 * Keys are sorted so that object literal order cannot move a hash, and the two
 * 64-bit counts are written as decimal rather than left to `JSON.stringify`,
 * which refuses a `bigint` outright.
 */
function canonicalEvidence(span: NewSpan): string {
  const evidence: Record<string, string | boolean> = {
    agent_id: span.agentId,
    agent_platform: span.agentPlatform,
    agent_version_id: span.agentVersionId,
    audio_url: span.audioUrl,
    connection_kind: span.connectionKind,
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
  return JSON.stringify(evidence, Object.keys(evidence).sort());
}

/**
 * What this span says, as one comparable value.
 *
 * Stored on the row and compared against on a replay. The comparison is the
 * only thing that can tell an exact replay — which changes nothing and is
 * always safe — from a second, different account of one immutable identity,
 * which is a defect and must never overwrite the first. The engine cannot make
 * that distinction and is not asked to.
 *
 * Exported because the acceptance path computes it over the record it is about
 * to stage, long before this module sees a row, and two implementations of one
 * fingerprint is one of them quietly deciding that a conflict is a replay.
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
    connection_type: span.connectionKind,
    run_id: span.runId,
    agent_id: span.agentId,
    agent_version_id: span.agentVersionId,
    test_version_id: span.testVersionId,
    persona_version_id: span.personaVersionId,
    payload: span.payload,
    content_hash: spanContentHash(span),
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

export type AppendSpansOptions = {
  /**
   * What is being written, when the caller knows: the identity of the segment
   * these spans were drained from.
   *
   * It becomes each block's `insert_deduplication_token`, which is the shield
   * in front of the identity for the case block dedup cannot see — the same
   * evidence re-serialised, regrouped or re-split by a retry, which is
   * different bytes and the same output. Deterministic in the segment and the
   * block, so a replay of one segment produces the same tokens in the same
   * order and every one of them is recognised.
   *
   * Absent from the doors that write straight through, which have no segment to
   * name; those rely on block dedup and, permanently, on the identity.
   */
  readonly segmentId?: string | undefined;
};

/**
 * File these spans under the caller's organization and project.
 *
 * Every record is checked against the documented bounds before anything is
 * staged, and a record over one is refused whole — the batch does not go, and
 * nothing partial is left behind, because the first block is not sent until the
 * last record has passed.
 *
 * Nothing is read first and nothing is overwritten. An exact replay collapses
 * on the span identity; evidence that disagrees with what is already stored is
 * a defect this function cannot see and must not be asked to settle, so a
 * caller replaying anything checks `committedSpans` before it calls.
 */
export async function appendSpans(
  auth: AuthContext,
  spans: readonly NewSpan[],
  options: AppendSpansOptions = {},
): Promise<AppendedSpans> {
  if (spans.length === 0) return { appended: 0, batches: 0 };

  for (const span of spans) refuseOversizeRecord(span);

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
