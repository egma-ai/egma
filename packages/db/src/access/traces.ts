import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import { UnreadableTraceQueryError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import type { SpanSource } from "./spans.ts";

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
 *
 * The cap bounds the **tree** and nothing else. Every count beside it is the
 * whole trace inside the window, taken from an aggregate rather than from the
 * rows that fitted, so `spanCount` is the number a caller compares against to
 * learn how much of the trace they are holding.
 */
export const MAXIMUM_SPANS_PER_TRACE = 10_000;

const SPANS_TABLE = "spans";
const TURNS_TABLE = "turns";

/**
 * A window of time, closed at the start and open at the end, counted in
 * **microseconds since the epoch**.
 *
 * Required on both calls, with no default. A default window is a question
 * somebody did not ask, and the one thing this store must never do is answer one
 * nobody bounded.
 *
 * Microseconds rather than `Date`s, because a `Date` holds milliseconds and this
 * store holds microseconds. The end is exclusive, so a bound that had been
 * rounded down to the millisecond would quietly exclude the 999 microseconds
 * after it: a caller pasting a trace's own `ended_at` back in as `to` would not
 * be given the span that ended at it, and nothing in the answer would say why.
 * The unit here is the column's own, so a window means exactly what it says.
 */
export type TimeWindow = {
  readonly from: bigint;
  readonly to: bigint;
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
  /**
   * Which kind of traffic to read: a conversation egma conducted, or one a real
   * caller had. **Absent is both**, which is what this list has always answered
   * and what a caller written before this option existed still gets.
   *
   * Narrowing only, like the project beside it — there is nothing wider than
   * both. The column is on every row because comparing a simulation against a
   * production exchange is the premise of the product, so a surface that shows
   * one kind asks the store for one kind rather than reading a page of both and
   * throwing half of it away: a page filtered after the fact holds however many
   * rows survived, and how many rows a page holds is what a token walks.
   */
  readonly source?: SpanSource | undefined;
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
  /**
   * How many spans of this trace the window holds — **rows, not nodes of a
   * tree**. The two are the same number except in two cases, and both of them
   * are ones a caller has to be told about rather than have hidden: a trace over
   * `MAXIMUM_SPANS_PER_TRACE`, where the transcript is a prefix and this is
   * still the whole trace; and telemetry that sent one span id twice, which is
   * one node in the transcript and two rows here.
   */
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
   * **The first thing the human said**, truncated — read from the turn-grain
   * view, which is exactly what its truncated text column is for.
   *
   * Not the transcript's opening line, and the difference is not an accident:
   * an agent that greets first opens most traces it is in, so a preview of the
   * opening line would be the same sentence on every row of the list. What
   * somebody scanning a list is looking for is what the caller wanted, so that
   * is what this is. Empty when the human said nothing, or when the provider
   * emits no turn spans at all.
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
   * Everything top-level that is not a turn — the root span above all, any span
   * whose parent never arrived, and any span the parent chain never reached at
   * all. Available, and deliberately not interleaved with the turns: a
   * transcript is what somebody said, and the framework's own bookkeeping is not
   * part of it.
   */
  readonly spans: readonly TraceSpan[];
  /**
   * True when the trace holds more spans than one read returns — and then the
   * two halves of this answer mean different things, deliberately. **The tree is
   * a prefix; the counts are the trace.** `turns` and `spans` hold the first
   * `MAXIMUM_SPANS_PER_TRACE` spans in time order, while `spanCount` and every
   * count beside it are the whole trace inside the window. So the flag is not
   * only a warning: with it, the two numbers say exactly how much of the trace
   * the transcript is.
   */
  readonly truncated: boolean;
};

/* ------------------------------------------------------------------- *
 * The window and the cursor — the two things a caller can get wrong.
 * ------------------------------------------------------------------- */

/**
 * The instants a window may name, which are the ones the store can hold and do
 * arithmetic over.
 *
 * `DateTime64` begins in 1900, and the far end is where a trace's *end* stops
 * fitting: the list adds a duration in nanoseconds to a start in nanoseconds,
 * and nanoseconds since the epoch pass what signed 64 bits hold on 2262-04-11.
 * Outside these two a window is refused rather than clamped, on the same terms
 * as one that is too wide.
 *
 * It has to be refused *here*, before a literal is built from it. A `Date` will
 * hold the year 275760 quite happily, and `toISOString` writes that year with a
 * sign and six digits — so a window nobody bounded would reach ClickHouse as a
 * timestamp literal that is not a timestamp, and the customer would be told
 * their query was a server fault rather than a window they cannot have.
 */
const EARLIEST_READABLE_MICROSECONDS = BigInt(Date.UTC(1900, 0, 1)) * 1000n;
const LATEST_READABLE_MICROSECONDS = BigInt(Date.UTC(2262, 3, 11)) * 1000n;

const MAXIMUM_WINDOW_MICROSECONDS = BigInt(MAXIMUM_WINDOW_MILLISECONDS) * 1000n;

function checkedWindow(window: TimeWindow): TimeWindow {
  const { from, to } = window;

  if (to <= from) {
    throw new UnreadableTraceQueryError(
      "time_window",
      "this window ends at or before it starts, so there is no time in it to " +
        "look at.",
    );
  }
  if (
    from < EARLIEST_READABLE_MICROSECONDS ||
    to > LATEST_READABLE_MICROSECONDS
  ) {
    throw new UnreadableTraceQueryError(
      "time_window",
      "this window names an instant outside the range the trace store can " +
        "hold, which is 1900-01-01 to 2262-04-11 — the second is where a " +
        "nanosecond count since the epoch stops fitting in the sixty-four bits " +
        "a trace's end is measured in. Ask about a time a trace could have " +
        "happened at.",
    );
  }
  if (to - from > MAXIMUM_WINDOW_MICROSECONDS) {
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
 * **The justification is correctness, and it is not cost.** The usual argument
 * for a token — an offset re-reads everything before it, so page fifty costs
 * fifty pages — does not apply to this query and should not be claimed for it:
 * the list groups a whole window by `trace_id` and then orders the groups, so
 * the aggregation is the cost, an offset and a token pay it identically, and
 * page fifty is exactly as expensive either way.
 *
 * What a position buys is a walk that is stable while spans are still arriving.
 * `offset 100` means *skip whatever sorts first at the moment you ask*, so a
 * trace ingested mid-walk shifts every later row by one and the next page hands
 * back a trace the last page already showed — while the one that fell off the
 * boundary is never shown at all. A position cannot do either: the next page
 * asks for what sorts strictly after the row the caller last saw, so a row
 * arriving anywhere else changes nothing about where the walk resumes. Nothing
 * is skipped and nothing is repeated, whatever ingest does meanwhile.
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
      "this page token is not one Egma issued, or not one this version of the " +
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
 *
 * The four-digit year it slices out is guaranteed by `checkedWindow`, which
 * refuses anything outside the range `DateTime64` holds before a literal is ever
 * built. `toISOString` writes a year outside 0000–9999 with a sign and six
 * digits, and the slice would take the timestamp apart in the middle.
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
 *
 * An **empty** project id is nobody's project and is read as absence, on both
 * halves. `?project_id=` is what a form submits for a field left blank, and
 * `??` does not catch it: taken as a name it would put `project_id = ''` in the
 * predicate, which no row has ever been written under, and the customer would be
 * handed an empty list indistinguishable from having no traces.
 */
function tenancyOf(auth: AuthContext, asked: string | undefined): Tenancy {
  const projectId = named(auth.projectId) ?? named(asked);
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

/** A name somebody gave, as against a parameter that arrived carrying nothing. */
function named(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
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

/**
 * Where a trace sits in the list's ordering, written out rather than aliased: an
 * alias called `started_at` would shadow the column of that name, and which of
 * the two a later expression meant would depend on where it sat.
 */
const TRACE_POSITION = "min(toUnixTimestamp64Micro(started_at))";

/**
 * Every trace-level fact, as one pass of `countIf`s over the spans a window
 * holds for a trace.
 *
 * One string, read by both endpoints. The list groups it by `trace_id` across
 * the whole window; the transcript runs the identical aggregate scoped to the
 * one trace it is returning. So the numbers printed beside a transcript and the
 * numbers in the list that found it are the same numbers arrived at the same
 * way, rather than two implementations that agree until the day they do not —
 * and the transcript's counts are the trace's own even when its tree had to stop
 * at the cap.
 *
 * `duration_ns` is a `UInt64` and this arithmetic is signed, so a row carrying a
 * duration near 2^64 would come through `toInt64` negative and end the trace
 * before it began. Ingest clamps what it writes at Int64's ceiling; `greatest`
 * is the same floor under rows that were written before it did.
 */
const TRACE_FACTS = `toString(${TRACE_POSITION}) as started_at_micros,
       toString(max(
         toUnixTimestamp64Micro(started_at) * 1000
           + greatest(toInt64(duration_ns), 0)
       )) as ended_at_nanos,
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
       any(agent_id) as agent_id`;

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
 *
 * **`source` narrows that scan and nothing else about this call changes.** A
 * caller naming none reads both kinds of traffic, exactly as every caller did
 * before the option existed; a caller naming one reads that one, and a token it
 * was handed resumes inside the same narrowed ordering.
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

  // The kind of traffic, when a caller asked for one. It joins the scan rather
  // than the page, which is what makes a token minted under it walk the
  // filtered ordering: `having` prunes groups after this predicate has already
  // decided which rows there were to group, so the row a page stopped at is a
  // position in the same ordering the next request resumes.
  //
  // **Qualified by the table, and that is not decoration.** The select list
  // aliases `any(source) as source`, and ClickHouse resolves a bare `source` in
  // the `where` against that alias — then refuses the whole query, because an
  // aggregate cannot be a predicate on the rows it aggregates. Naming the table
  // is what points this at the column.
  //
  // A parameter, because it is the one part of this statement that came from
  // outside.
  const source = named(options.source);
  const narrowing =
    source === undefined
      ? ""
      : `\n       and ${SPANS_TABLE}.source = {source:String}`;

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT), 1),
    MAXIMUM_LIST_LIMIT,
  );

  // Strictly after the last row of the previous page, in the list's own
  // ordering. Written against the aggregate rather than against the column,
  // because what is ordered is when the *trace* started and not when any one of
  // its spans did.
  const after =
    cursor === undefined
      ? ""
      : `having (${TRACE_POSITION}, trace_id) < ` +
        `({cursor_started_at:Int64}, {cursor_trace_id:String}) `;

  // One row more than the page, so that whether there is a next page is a fact
  // rather than a guess. A cursor handed out for an empty next page is a caller
  // making a request in order to be told there is nothing.
  const rows = await rowsOf<SummaryRow>(
    `select
       trace_id,
       ${TRACE_FACTS}
     from ${SPANS_TABLE}
     where ${tenancy.clause}
       and started_at >= ${asDateTime64(window.from)}
       and started_at < ${asDateTime64(window.to)}${narrowing}
     group by trace_id
     ${after}order by ${TRACE_POSITION} desc, trace_id desc
     limit ${limit + 1}`,
    {
      ...tenancy.parameters,
      ...(source === undefined ? {} : { source }),
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
    last === undefined ? window.from : BigInt(last.started_at_micros),
    window.to,
  );

  return {
    traces: page.map((row) => ({
      ...factsOf(row.trace_id, row),
      preview: previews.get(row.trace_id) ?? "",
    })),
    nextCursor,
  };
}

/**
 * One aggregate row as the facts both endpoints report.
 *
 * The trace-level columns are denormalised onto every span precisely so that
 * reading one of them is reading the trace, which is what makes `any()` the
 * right aggregate for them rather than a guess.
 */
function factsOf(traceId: string, row: SummaryRow): TraceFacts {
  const startedAt = BigInt(row.started_at_micros);
  const endedAtNanoseconds = BigInt(row.ended_at_nanos);

  return {
    traceId,
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
  };
}

/**
 * The first thing the human said in each trace on the page, from the turn-grain
 * view.
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

  const where = `${tenancy.clause}
       and started_at >= ${asDateTime64(window.from)}
       and started_at < ${asDateTime64(window.to)}
       and trace_id = {trace_id:String}`;
  const parameters = { ...tenancy.parameters, trace_id: traceId };

  // Two reads of the same window, and the second is not the first's leftovers.
  // The rows build the tree and stop at the cap; the aggregate counts the whole
  // trace, so that a transcript which had to stop somewhere still reports what
  // it stopped short of. It is the list's own aggregate, scoped to one trace,
  // over a window the sort key has already pruned to this organization, this
  // project and these minutes — one cheap pass, and asked in parallel with the
  // rows because neither answer is the other's input.
  const [summaries, rows] = await Promise.all([
    rowsOf<SummaryRow>(
      `select
       trace_id,
       ${TRACE_FACTS}
     from ${SPANS_TABLE}
     where ${where}
     group by trace_id`,
      parameters,
    ),
    rowsOf<SpanRow>(
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
       tool_result
     from ${SPANS_TABLE}
     where ${where}
     order by started_at asc, span_id asc
     limit ${MAXIMUM_SPANS_PER_TRACE + 1}`,
      parameters,
    ),
  ]);

  const facts = summaries[0];
  if (facts === undefined || rows.length === 0) return undefined;

  const truncated = rows.length > MAXIMUM_SPANS_PER_TRACE;
  const kept = truncated ? rows.slice(0, MAXIMUM_SPANS_PER_TRACE) : rows;

  return { ...factsOf(traceId, facts), ...transcriptOf(kept), truncated };
}

/**
 * The rows as a transcript: the turns in the order they happened, each holding
 * what happened inside it, and the root span kept to one side.
 *
 * **Every row that was read comes back, exactly once**, and that is the property
 * the rest of this is arranged around. A transcript that quietly dropped a span
 * would disagree with the count printed beside it, and a caller comparing the
 * two would be told the store had lost something.
 *
 * Four rules, each of them somebody else's decision honoured here.
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
 * **A span the parent chain never reaches is top-level too.** Two spans naming
 * each other as parent are a cycle, and every span in one has a parent that is
 * present, so none of them files under the root; none is a turn, so none is
 * lifted. Walking down from the top would therefore never arrive at them and
 * they would vanish out of a response that still counted them. So the walk runs
 * a second time over whatever it did not visit: the first span of a cycle
 * reached that way becomes the top of it and the rest hang beneath, because the
 * visited set closes the loop. Nothing sends this on purpose; it is what a
 * truncated exporter buffer or a hand-written client produces, and the answer to
 * it is to show the spans rather than to be clever about the shape.
 *
 * **Everything else keeps its shape.** LiveKit's model calls nest four adapters
 * deep and only the innermost names the real model, so flattening would throw
 * away the one structure that says which of several `llm_request_run` spans was
 * the retry. The tree is returned as it arrived.
 *
 * In one case "exactly once" is per **id** rather than per row, and it is worth
 * saying out loud: two rows sharing a span id are one node here, because a tree
 * built from a repeat walks forever. They are two in `spanCount`, which counts
 * the rows the window holds. Telemetry that sent a span twice is the only way to
 * see the two numbers disagree, and reporting the disagreement is more use than
 * hiding it behind either one.
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

  const spans: TraceSpan[] = [];

  // Asked one row at a time rather than filtered first, because building one of
  // these visits everything under it: a candidate that was still unvisited when
  // the list was drawn up can have been reached by the time its turn comes.
  const appendUnvisited = (candidates: readonly SpanRow[]): void => {
    for (const row of candidates) {
      if (isTurn(row.kind) || visited.has(row.span_id)) continue;
      spans.push(build(row));
    }
  };

  // The root span and anything else that filed at the top, in the order the rows
  // arrived, and then whatever the walk never reached at all.
  appendUnvisited(childrenOf.get("") ?? []);
  appendUnvisited(rows);

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
