import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import { UnreadableTraceQueryError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";

/**
 * Reading traces, and the only way anything ever does.
 *
 * The write side is `spans.ts`; this is the other half of the same boundary. The
 * ClickHouse client stays as private as the Postgres pool, tenancy is stamped
 * from the `AuthContext` and from nothing a caller passed, and no exported call
 * here takes a predicate — a project can be *narrowed* to by name, never widened
 * past the organization the credential resolved to.
 *
 * **Everything here is filed along the table's own sort key**, which is
 * `(organization_id, project_id, toStartOfMinute(started_at), xxHash32(trace_id),
 * span_id)`. So every query below names the organization, names the project when
 * there is one, and names a bounded window of time. There is no call in this file
 * that can be made without a window, which is what makes an unfiltered scan
 * unreachable rather than merely discouraged.
 *
 * **Nothing is deduplicated at read time.** No `FINAL`, no `LIMIT 1 BY`, nothing
 * of that family anywhere near `spans` — the obligation not to send a span twice
 * belongs to whoever wrote it, and ClickHouse's block-level insert dedup is the
 * backstop under that. The `group by trace_id` in the list is an aggregation over
 * distinct spans, which is a different thing entirely from collapsing repeats of
 * one.
 *
 * **Reading is permitted to every role, `viewer` included.** The permission
 * table's `read` row names all three, and this file asks for it the way every
 * other read in the module does. Looking at what an agent did is the product; a
 * role that could not do it would be a login with nothing behind it.
 */

/**
 * How wide a window one request may name.
 *
 * Thirty-one days, and a wider one is **refused rather than quietly narrowed**.
 * Clamping answers a different question than the one asked and says nothing
 * about having done so — a caller paginating ninety days would walk to the end of
 * a month and conclude that was all there was. What to do about a window too wide
 * to serve is the caller's decision, and a refusal naming the cap is what lets
 * them make it.
 *
 * The number is the partition key's: `spans` is partitioned by
 * `toYYYYMM(started_at)`, so a window of at most thirty-one days touches at most
 * two partitions however it is placed, and the widest legal request is therefore
 * still a bounded amount of work.
 */
export const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;

/** How many traces one page may carry, and what it carries when nobody said. */
export const MAXIMUM_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/**
 * How many spans one trace is read back as.
 *
 * A trace is one exchange end to end and those are small — the captured LiveKit
 * trace is 133 spans — but "small" is the producer's opinion, and this is a
 * read that has to be bounded by egma's. What is over the line is reported rather
 * than dropped in silence, so a caller is never handed a transcript with a hole
 * in it and no way to know.
 */
export const MAXIMUM_SPANS_PER_TRACE = 10_000;

const SPANS_TABLE = "spans";
const TURNS_TABLE = "turns";

/**
 * A window of time, closed at the start and open at the end.
 *
 * Required on both calls, with no default. A default window is a question
 * somebody did not ask, and the one thing this store must never do is answer one
 * nobody bounded.
 */
export type TimeWindow = {
  readonly from: Date;
  readonly to: Date;
};

export type ListTracesOptions = {
  readonly window: TimeWindow;
  /**
   * Narrow to one project, and **only narrow**: a credential that already names
   * a project reads that project whatever this says, because a key minted for
   * one product area cannot be talked into another. The organization-wide read is
   * the first-class one — two projects in one organization are always queryable
   * together — so absence here means *the whole customer*, never a default
   * project.
   */
  readonly projectId?: string | undefined;
  readonly limit?: number | undefined;
  /** Where the last page stopped. Opaque, and issued by this module alone. */
  readonly cursor?: string | undefined;
};

export type ReadTraceOptions = {
  readonly window: TimeWindow;
  readonly projectId?: string | undefined;
};

/**
 * Trace-level facts, as both endpoints report them.
 *
 * Times are RFC 3339 strings rather than `Date`s, and that is deliberate: this
 * store keeps microseconds and a JavaScript date holds milliseconds, so handing
 * back a `Date` would round away precision the ingest path went out of its way
 * to preserve. Durations are decimal strings for the same reason in the other
 * direction — a nanosecond count passes 2^53 inside four months of uptime, and a
 * JSON number would quietly lose its low digits.
 */
export type TraceFacts = {
  readonly traceId: string;
  /** The first span of this trace **inside the window**, to the microsecond. */
  readonly startedAt: string;
  readonly endedAt: string;
  /** Wall-clock extent in nanoseconds, as a decimal string. */
  readonly durationNanoseconds: string;
  readonly spanCount: number;
  readonly humanTurnCount: number;
  readonly agentTurnCount: number;
  readonly toolSpanCount: number;
  readonly erroredSpanCount: number;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connectionType: string;
  readonly providerCallId: string;
  readonly runId: string;
  readonly agentId: string;
};

export type TraceSummary = TraceFacts & {
  /**
   * The opening line of the transcript, truncated — read from the turn-grain
   * view, which is exactly what its truncated text column is for. Empty when
   * nothing was said, or when the provider emits no turn spans at all.
   */
  readonly preview: string;
};

export type TraceList = {
  readonly traces: readonly TraceSummary[];
  /** Absent when this page is the last one. */
  readonly nextCursor: string | undefined;
};

/** One span, shaped for a transcript rather than for a table. */
export type TraceSpan = {
  readonly spanId: string;
  /** As it arrived. `''` on a root, and on a span that named no usable parent. */
  readonly parentSpanId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  /** RFC 3339, to the microsecond. */
  readonly startedAt: string;
  /** Nanoseconds, as a decimal string. */
  readonly durationNanoseconds: string;
  readonly text: string;
  readonly audioUrl: string;
  readonly toolName: string;
  readonly toolArguments: string;
  readonly toolResult: string;
  /** This span's own children, in time order. A turn is never nested here. */
  readonly spans: readonly TraceSpan[];
};

export type TraceDetail = TraceFacts & {
  /**
   * The transcript in the order it happened: every `turn:` span, each carrying
   * the spans that happened inside it.
   */
  readonly turns: readonly TraceSpan[];
  /**
   * Everything top-level that is not a turn — the root span above all, and any
   * span whose parent never arrived. Available, and deliberately not interleaved
   * with the turns: a transcript is what somebody said, and the framework's own
   * bookkeeping is not part of it.
   */
  readonly spans: readonly TraceSpan[];
  /** True when the trace holds more spans than one read returns. */
  readonly truncated: boolean;
};

/* ------------------------------------------------------------------- *
 * The window and the cursor — the two things a caller can get wrong.
 * ------------------------------------------------------------------- */

function checkedWindow(window: TimeWindow): TimeWindow {
  const from = window.from.getTime();
  const to = window.to.getTime();

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new UnreadableTraceQueryError(
      "time_window",
      "a trace query is bounded by a window of time, and one of these two " +
        "instants is not a time at all.",
    );
  }
  if (to <= from) {
    throw new UnreadableTraceQueryError(
      "time_window",
      "this window ends at or before it starts, so there is no time in it to " +
        "look at.",
    );
  }
  if (to - from > MAXIMUM_WINDOW_MILLISECONDS) {
    throw new UnreadableTraceQueryError(
      "time_window",
      `this window is wider than the ${
        MAXIMUM_WINDOW_MILLISECONDS / (24 * 60 * 60 * 1000)
      } days one request may ask for. ` +
        "It is refused rather than narrowed on your behalf: a narrowed window " +
        "answers a different question than the one asked and says nothing " +
        "about having done so. Ask for a narrower one, or walk the range in " +
        "several requests.",
    );
  }
  return window;
}

/**
 * Where a page stopped, as a position in the sort order rather than a count of
 * rows skipped.
 *
 * An offset re-reads and re-sorts everything before it, so page fifty costs fifty
 * pages, and a trace ingested mid-walk shifts every later row by one — which is
 * precisely how a paginated list comes to skip and to repeat. A position cannot:
 * the next page asks for what sorts strictly after this point, so a row arriving
 * anywhere else changes nothing about where the walk resumes, and each page costs
 * what the first one did.
 *
 * The two parts are the two the list orders by, in that order: when the trace
 * started, and its id to break the tie. Ties are real and not rare — the sort key
 * buckets time to the minute, and traces of one busy minute routinely share a
 * start.
 *
 * It travels as base64url of a versioned string, which makes it opaque without
 * pretending to be a secret. Clients hand it back and nothing else is promised
 * about it; the version is what stops a token from an older shape being read as
 * though it meant the same thing.
 */
type CursorPosition = {
  readonly startedAtMicroseconds: bigint;
  readonly traceId: string;
};

const CURSOR_VERSION = "1";

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    `${CURSOR_VERSION}:${position.startedAtMicroseconds}:${position.traceId}`,
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): CursorPosition {
  const unreadable = (): never => {
    throw new UnreadableTraceQueryError(
      "cursor",
      "this page token is not one egma issued, or not one this version of the " +
        "list can still read. Ask for the first page again — a token is a " +
        "position in one ordering and means nothing outside it.",
    );
  };

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return unreadable();
  }

  const parts = decoded.split(":");
  const [version, microseconds, traceId] = parts;
  if (
    parts.length !== 3 ||
    version !== CURSOR_VERSION ||
    microseconds === undefined ||
    traceId === undefined ||
    traceId === "" ||
    !/^\d{1,19}$/u.test(microseconds)
  ) {
    return unreadable();
  }

  return { startedAtMicroseconds: BigInt(microseconds), traceId };
}

/* ------------------------------------------------------------------- *
 * Literals, parameters and the tenancy predicate.
 * ------------------------------------------------------------------- */

/**
 * The exact literal `DateTime64(6)` reads.
 *
 * Written into the statement rather than passed as a parameter on purpose: the
 * window is what the primary index prunes on, and a constant of the column's own
 * type is the form ClickHouse's key analysis reads without hesitating. It is
 * built from an integer count of microseconds and never from anything a caller
 * typed, so there is nothing in it for a quote to escape out of.
 */
function asDateTime64(microseconds: bigint): string {
  const MILLION = 1_000_000n;
  let seconds = microseconds / MILLION;
  let remainder = microseconds % MILLION;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLION;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `toDateTime64('${whole.replace("T", " ")}.${remainder
    .toString()
    .padStart(6, "0")}', 6, 'UTC')`;
}

function microsecondsOf(when: Date): bigint {
  return BigInt(when.getTime()) * 1000n;
}

/** RFC 3339 to the microsecond, which is what the column actually holds. */
function rfc3339(microseconds: bigint): string {
  const MILLION = 1_000_000n;
  let seconds = microseconds / MILLION;
  let remainder = microseconds % MILLION;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLION;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole}.${remainder.toString().padStart(6, "0")}Z`;
}

type Tenancy = {
  readonly clause: string;
  readonly parameters: Record<string, unknown>;
};

/**
 * The organization, and the project when there is one to name.
 *
 * `auth.projectId` wins over anything asked for: a key minted for one product
 * area reads that product area, and the argument can only narrow an
 * organization-wide credential. Both travel as parameters — they are ids, and an
 * id is the one thing in these statements that ever came from outside.
 */
function tenancyOf(auth: AuthContext, asked: string | undefined): Tenancy {
  const projectId = auth.projectId ?? asked;
  return {
    clause:
      "organization_id = {organization_id:String}" +
      (projectId === undefined ? "" : " and project_id = {project_id:String}"),
    parameters: {
      organization_id: auth.organizationId,
      ...(projectId === undefined ? {} : { project_id: projectId }),
    },
  };
}

async function rowsOf<Row>(
  query: string,
  parameters: Record<string, unknown>,
): Promise<Row[]> {
  const result = await traceStore().query({
    query,
    query_params: parameters,
    format: "JSONEachRow",
  });
  return result.json<Row>();
}

/** A 64-bit count arrives as a string or a number depending on the settings. */
function counted(value: string | number | undefined): number {
  return Number(value ?? 0);
}

/* ------------------------------------------------------------------- *
 * The list.
 * ------------------------------------------------------------------- */

type SummaryRow = {
  readonly trace_id: string;
  readonly started_at_micros: string;
  readonly ended_at_nanos: string;
  readonly span_count: string | number;
  readonly human_turn_count: string | number;
  readonly agent_turn_count: string | number;
  readonly tool_span_count: string | number;
  readonly errored_span_count: string | number;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connection_type: string;
  readonly provider_call_id: string;
  readonly run_id: string;
  readonly agent_id: string;
};

/**
 * The traces this customer has inside this window, newest first.
 *
 * **A trace is whatever spans arrived under one trace id**, and this reads
 * `spans` rather than the turn-grain view for a reason worth writing down. A
 * trace whose provider emits no `turn:` span has no row in that view at all —
 * which today is every framework except LiveKit, because an unrecognised
 * instrumentation scope normalises to `other` — and a list that silently omits a
 * customer's traces is a worse thing than a slower one. The view is still read,
 * for the single thing it is uniquely good at: the truncated opening line,
 * without touching the untruncated column beside it.
 *
 * Every count is a `countIf` in the same single pass, so a page's whole set of
 * numbers costs one scan of a window the sort key has already pruned to this
 * organization, this project, and these minutes.
 */
export async function listTraces(
  auth: AuthContext,
  options: ListTracesOptions,
): Promise<TraceList> {
  authorize(auth, "read", here(auth));

  const window = checkedWindow(options.window);
  const tenancy = tenancyOf(auth, options.projectId);
  const cursor =
    options.cursor === undefined || options.cursor === ""
      ? undefined
      : decodeCursor(options.cursor);

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT), 1),
    MAXIMUM_LIST_LIMIT,
  );

  // The trace's position in the ordering, written out rather than aliased: an
  // alias called `started_at` would shadow the column of that name, and which of
  // the two a later expression meant would depend on where it sat.
  const position = "min(toUnixTimestamp64Micro(started_at))";

  // Strictly after the last row of the previous page, in the list's own
  // ordering. Written against the aggregate rather than against the column,
  // because what is ordered is when the *trace* started and not when any one of
  // its spans did.
  const after =
    cursor === undefined
      ? ""
      : `having (${position}, trace_id) < ` +
        `({cursor_started_at:Int64}, {cursor_trace_id:String}) `;

  // One row more than the page, so that whether there is a next page is a fact
  // rather than a guess. A cursor handed out for an empty next page is a caller
  // making a request in order to be told there is nothing.
  const rows = await rowsOf<SummaryRow>(
    `select
       trace_id,
       toString(${position}) as started_at_micros,
       toString(max(toUnixTimestamp64Micro(started_at) * 1000 + toInt64(duration_ns)))
         as ended_at_nanos,
       count() as span_count,
       countIf(kind = 'turn:human') as human_turn_count,
       countIf(kind = 'turn:agent') as agent_turn_count,
       countIf(kind = 'tool') as tool_span_count,
       countIf(status = 'error') as errored_span_count,
       any(source) as source,
       any(emitter) as emitter,
       any(environment) as environment,
       any(connection_type) as connection_type,
       any(provider_call_id) as provider_call_id,
       any(run_id) as run_id,
       any(agent_id) as agent_id
     from ${SPANS_TABLE}
     where ${tenancy.clause}
       and started_at >= ${asDateTime64(microsecondsOf(window.from))}
       and started_at < ${asDateTime64(microsecondsOf(window.to))}
     group by trace_id
     ${after}order by ${position} desc, trace_id desc
     limit ${limit + 1}`,
    {
      ...tenancy.parameters,
      ...(cursor === undefined
        ? {}
        : {
            cursor_started_at: cursor.startedAtMicroseconds.toString(),
            cursor_trace_id: cursor.traceId,
          }),
    },
  );

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({
          startedAtMicroseconds: BigInt(last.started_at_micros),
          traceId: last.trace_id,
        })
      : undefined;

  const previews = await previewsFor(
    tenancy,
    page.map((row) => row.trace_id),
    // The page is newest first, so its last row is the earliest any span of any
    // trace on it can be.
    last === undefined
      ? microsecondsOf(window.from)
      : BigInt(last.started_at_micros),
    microsecondsOf(window.to),
  );

  return {
    traces: page.map((row) => {
      const startedAt = BigInt(row.started_at_micros);
      const endedAtNanoseconds = BigInt(row.ended_at_nanos);
      return {
        traceId: row.trace_id,
        startedAt: rfc3339(startedAt),
        endedAt: rfc3339(endedAtNanoseconds / 1000n),
        durationNanoseconds: (endedAtNanoseconds - startedAt * 1000n).toString(),
        spanCount: counted(row.span_count),
        humanTurnCount: counted(row.human_turn_count),
        agentTurnCount: counted(row.agent_turn_count),
        toolSpanCount: counted(row.tool_span_count),
        erroredSpanCount: counted(row.errored_span_count),
        source: row.source,
        emitter: row.emitter,
        environment: row.environment,
        connectionType: row.connection_type,
        providerCallId: row.provider_call_id,
        runId: row.run_id,
        agentId: row.agent_id,
        preview: previews.get(row.trace_id) ?? "",
      };
    }),
    nextCursor,
  };
}

/**
 * The opening line of each trace on the page, from the turn-grain view.
 *
 * Bounded to the traces the page actually holds and to the slice of the window
 * they start in — the earliest of them is the earliest any of their turns can be,
 * since a turn is a span and each position is a minimum over all of a trace's
 * spans. So this reads a strictly smaller range than the list itself did, over
 * one truncated column, and never touches the untruncated text on `spans`.
 */
async function previewsFor(
  tenancy: Tenancy,
  traceIds: readonly string[],
  fromMicroseconds: bigint,
  toMicroseconds: bigint,
): Promise<Map<string, string>> {
  if (traceIds.length === 0) return new Map();

  const rows = await rowsOf<{ trace_id: string; preview: string }>(
    `select trace_id, argMin(text_preview, started_at) as preview
     from ${TURNS_TABLE}
     where ${tenancy.clause}
       and started_at >= ${asDateTime64(fromMicroseconds)}
       and started_at < ${asDateTime64(toMicroseconds)}
       and kind = 'turn:human'
       and trace_id in {trace_ids:Array(String)}
     group by trace_id`,
    { ...tenancy.parameters, trace_ids: [...traceIds] },
  );

  return new Map(rows.map((row) => [row.trace_id, row.preview]));
}

/* ------------------------------------------------------------------- *
 * The transcript.
 * ------------------------------------------------------------------- */

type SpanRow = {
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly started_at_micros: string;
  readonly duration_ns: string;
  readonly text: string;
  readonly audio_url: string;
  readonly tool_name: string;
  readonly tool_arguments: string;
  readonly tool_result: string;
  readonly source: string;
  readonly emitter: string;
  readonly environment: string;
  readonly connection_type: string;
  readonly provider_call_id: string;
  readonly run_id: string;
  readonly agent_id: string;
};

/** A turn is a span whose kind says somebody was speaking. */
function isTurn(kind: string): boolean {
  return kind.startsWith("turn:");
}

/**
 * One trace, transcript-ordered and shaped for reading.
 *
 * **The window is required here too**, and it is not ceremony. `trace_id` is not
 * a prefix of the sort key — it is hashed into the fourth position, under the
 * minute — so a lookup naming only an id would have nothing to prune with and
 * would read every partition the store holds. Saying when the trace happened is
 * what makes fetching one of them cheap, and the list that found it already
 * said.
 *
 * **The verbatim payload is not returned.** It is by a wide margin the largest
 * column on the row — every span carries its resource and its scope exactly as
 * they arrived — and a transcript that shipped it would be megabytes of JSON
 * nobody asked to render. It is neither lost nor unreachable: it is on the row,
 * and the way a caller will reach it is a per-span read
 * (`GET /v1/traces/:traceId/spans/:spanId`) that this ticket deliberately does
 * not build, because nothing consumes it yet and an endpoint with no caller is a
 * contract nobody has checked.
 *
 * Absent when the window holds no span of that trace for this customer — which is
 * also the answer another customer gets for a trace id they guessed correctly,
 * because the organization leads the filing order and their query never reaches
 * the rows at all.
 */
export async function readTrace(
  auth: AuthContext,
  traceId: string,
  options: ReadTraceOptions,
): Promise<TraceDetail | undefined> {
  authorize(auth, "read", here(auth));

  const window = checkedWindow(options.window);
  const tenancy = tenancyOf(auth, options.projectId);

  const rows = await rowsOf<SpanRow>(
    `select
       span_id,
       parent_span_id,
       name,
       kind,
       status,
       toString(toUnixTimestamp64Micro(started_at)) as started_at_micros,
       toString(duration_ns) as duration_ns,
       text,
       audio_url,
       tool_name,
       tool_arguments,
       tool_result,
       source,
       emitter,
       environment,
       connection_type,
       provider_call_id,
       run_id,
       agent_id
     from ${SPANS_TABLE}
     where ${tenancy.clause}
       and started_at >= ${asDateTime64(microsecondsOf(window.from))}
       and started_at < ${asDateTime64(microsecondsOf(window.to))}
       and trace_id = {trace_id:String}
     order by started_at asc, span_id asc
     limit ${MAXIMUM_SPANS_PER_TRACE + 1}`,
    { ...tenancy.parameters, trace_id: traceId },
  );

  if (rows.length === 0) return undefined;

  const truncated = rows.length > MAXIMUM_SPANS_PER_TRACE;
  const kept = truncated ? rows.slice(0, MAXIMUM_SPANS_PER_TRACE) : rows;

  return { ...factsOf(traceId, kept), ...transcriptOf(kept), truncated };
}

function factsOf(traceId: string, rows: readonly SpanRow[]): TraceFacts {
  // The rows arrive in time order, so the first is the earliest; the latest
  // ending is not the last row, because a long span can start before a short one
  // and outlive it.
  let startedAt = BigInt(rows[0]?.started_at_micros ?? "0");
  let endedAtNanoseconds = startedAt * 1000n;
  let humanTurnCount = 0;
  let agentTurnCount = 0;
  let toolSpanCount = 0;
  let erroredSpanCount = 0;

  for (const row of rows) {
    const started = BigInt(row.started_at_micros);
    if (started < startedAt) startedAt = started;
    const ended = started * 1000n + BigInt(row.duration_ns);
    if (ended > endedAtNanoseconds) endedAtNanoseconds = ended;
    if (row.kind === "turn:human") humanTurnCount += 1;
    if (row.kind === "turn:agent") agentTurnCount += 1;
    if (row.kind === "tool") toolSpanCount += 1;
    if (row.status === "error") erroredSpanCount += 1;
  }

  // Trace-level facts are denormalised onto every span precisely so that reading
  // one of them is reading the trace, so the first row answers for all of them.
  const first = rows[0];

  return {
    traceId,
    startedAt: rfc3339(startedAt),
    endedAt: rfc3339(endedAtNanoseconds / 1000n),
    durationNanoseconds: (endedAtNanoseconds - startedAt * 1000n).toString(),
    spanCount: rows.length,
    humanTurnCount,
    agentTurnCount,
    toolSpanCount,
    erroredSpanCount,
    source: first?.source ?? "",
    emitter: first?.emitter ?? "",
    environment: first?.environment ?? "",
    connectionType: first?.connection_type ?? "",
    providerCallId: first?.provider_call_id ?? "",
    runId: first?.run_id ?? "",
    agentId: first?.agent_id ?? "",
  };
}

/**
 * The rows as a transcript: the turns in the order they happened, each holding
 * what happened inside it, and the root span kept to one side.
 *
 * Three rules, each of them somebody else's decision honoured here.
 *
 * **A span whose parent is not in this trace is top-level.** A malformed parent
 * id normalises to `''` at the door with the original kept in the payload, so a
 * span that named a parent nobody sent reads as its own root rather than
 * disappearing down a chain that goes nowhere. Ticket 03 wrote that down; this is
 * where it is obeyed.
 *
 * **Turns are lifted, never nested.** A turn is a child of the root span in
 * LiveKit's tree, and leaving it there would make the transcript something you
 * find by walking into the root span's bookkeeping. So a turn appears once, in
 * `turns`, and never inside another span's children — including inside another
 * turn's, on the day some framework nests them.
 *
 * **Everything else keeps its shape.** LiveKit's model calls nest four adapters
 * deep and only the innermost names the real model, so flattening would throw
 * away the one structure that says which of several `llm_request_run` spans was
 * the retry. The tree is returned as it arrived.
 */
function transcriptOf(rows: readonly SpanRow[]): {
  readonly turns: readonly TraceSpan[];
  readonly spans: readonly TraceSpan[];
} {
  const present = new Set(rows.map((row) => row.span_id));
  const childrenOf = new Map<string, SpanRow[]>();

  for (const row of rows) {
    // A parent nobody sent is no parent at all, and a span naming itself as its
    // parent is a cycle of one. Both file at the top.
    const parent =
      row.parent_span_id !== "" &&
      row.parent_span_id !== row.span_id &&
      present.has(row.parent_span_id)
        ? row.parent_span_id
        : "";
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [row]);
    else siblings.push(row);
  }

  // Span ids are unique inside a trace on the wire, but they arrive from outside
  // and a repeated one would otherwise be a tree that walks forever. Visiting
  // each span at most once bounds the walk to the rows that were read.
  const visited = new Set<string>();

  const build = (row: SpanRow): TraceSpan => {
    visited.add(row.span_id);
    const children = (childrenOf.get(row.span_id) ?? []).filter(
      (child) => !isTurn(child.kind) && !visited.has(child.span_id),
    );
    return { ...spanOf(row), spans: children.map(build) };
  };

  const turns = rows
    .filter((row) => isTurn(row.kind))
    .map((row) => (visited.has(row.span_id) ? undefined : build(row)))
    .filter((turn): turn is TraceSpan => turn !== undefined);

  const spans = (childrenOf.get("") ?? [])
    .filter((row) => !isTurn(row.kind) && !visited.has(row.span_id))
    .map(build);

  return { turns, spans };
}

function spanOf(row: SpanRow): Omit<TraceSpan, "spans"> {
  return {
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    startedAt: rfc3339(BigInt(row.started_at_micros)),
    durationNanoseconds: row.duration_ns,
    text: row.text,
    audioUrl: row.audio_url,
    toolName: row.tool_name,
    toolArguments: row.tool_arguments,
    toolResult: row.tool_result,
  };
}
