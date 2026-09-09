import { AGENT_EVIDENCE_COMPLETE_SQL, AGENT_EVIDENCE_INCOMPLETE_SQL } from "./agent-evidence.ts";
import { traceStore } from "../clickhouse/client.ts";
import {
  aggregateOf,
  measuresFromSpans,
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  REPORTED_MEASUREMENTS_PAYLOAD_PATH,
  reportedMeasurementsOf,
  turnResponseLatencySpanKinds,
  type MeasuredFromSpans,
  type ReportedMeasurement,
} from "@egma/metrics";
import type { AuthContext } from "./context.ts";
import { UnreadableTraceQueryError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import type { SpanSource } from "./spans.ts";
import {
  withRetellToolTimeline,
  type RetellToolTimelineSlice,
} from "./retell-tool-timeline.ts";
import { fromOnePov, povOf, type SpanPov } from "../models/pov.ts";

/**
 * Read traces through the private ClickHouse access boundary. Require read permission
 * and a bounded time window; AuthContext sets organization and project scope.
 * Use FINAL where replay duplicates would change visible evidence. Ingestion must
 * reject conflicting span content before storage; reads do not resolve conflicts.
 */

/**
 * Reject windows wider than this limit instead of silently returning a shorter
 * range. The time bound limits scans across monthly partitions.
 */
export const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;

/** How many traces one page may carry, and what it carries when nobody said. */
export const MAXIMUM_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/**
 * Maximum span-tree rows returned across both POVs. Report truncation explicitly;
 * aggregate counts still cover the selected POV's full trace within the window.
 */
export const MAXIMUM_SPANS_PER_TRACE = 20_000;

const SPANS_TABLE = "spans";
const TURNS_TABLE = "turns";

/**
 * LiveKit's agent-activity bookkeeping that its JavaScript SDK starts as
 * independent OpenTelemetry roots around one `agent_session`.
 *
 * Exact and closed on purpose. A future LiveKit name remains visible until we
 * understand it; silently classifying an unknown trace as lifecycle evidence
 * would be the read path deleting a customer's only sign of a changed emitter.
 */
const LIVEKIT_LIFECYCLE_SPAN_NAMES = [
  "start_agent_activity",
  "resume_agent_activity",
  "pause_agent_activity",
  "drain_agent_activity",
  "on_enter",
  "on_exit",
] as const;

/**
 * Derive the outer normalized-payload key from the shared contract path.
 * Reported measurement parsing uses REPORTED_MEASUREMENTS_PAYLOAD_KEY inside it.
 */
const [NORMALISED_KEY = ""] = REPORTED_MEASUREMENTS_PAYLOAD_PATH.split(".");

/**
 * Choose parentless rows with normalized payload first, then egma-runtime rows,
 * then earliest start and span ID. A simulation may have two roots; this keeps
 * agent-platform reported measurements reachable regardless of arrival order.
 */
const PARENTLESS_ROW_ORDER =
  `JSONExtractRaw(payload, '${NORMALISED_KEY}') != '' desc, ` +
  `emitter = 'egma-runtime' desc, ` +
  `started_at asc, span_id asc`;

/**
 * Keep two speakers in conversational order when one native span carries both
 * sides at the same timestamp. The span ID remains an identity tie-breaker.
 */
const TRACE_ROW_ORDER =
  `started_at asc, ` +
  `multiIf(kind = 'turn:human', 0, kind = 'turn:agent', 1, 2) asc, ` +
  `span_id asc`;

/**
 * Required half-open interval [from, to) in microseconds since the epoch.
 * Use bigint to preserve the trace store's precision beyond JavaScript Date.
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
  /** Filter production or simulation traffic before pagination. Omit to include both. */
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
 * Trace facts within the requested window. RFC 3339 time strings retain
 * microseconds; decimal duration strings retain integer nanoseconds.
 */
export type TraceFacts = {
  /** The project stamped on every span of this trace. */
  readonly projectId: string;
  readonly traceId: string;
  /** The first span of this trace **inside the window**, to the microsecond. */
  readonly startedAt: string;
  readonly endedAt: string;
  /** Wall-clock extent in nanoseconds, as a decimal string. */
  readonly durationNanoseconds: string;
  /**
   * How many spans of this trace the window holds — **rows, not nodes of a
   * tree**. The two are the same number unless a trace is over
   * `MAXIMUM_SPANS_PER_TRACE`; then the transcript is a prefix and this is still
   * the whole trace. Reused span ids do not reduce the tree: each stored row is
   * returned as its own node.
   */
  readonly spanCount: number;
  readonly humanTurnCount: number;
  readonly agentTurnCount: number;
  readonly toolSpanCount: number;
  readonly erroredSpanCount: number;
  readonly source: string;
  /**
   * The storage column these facts were counted over, verbatim:
   * `egma-runtime` or `agent`. Kept beside `pov`, which is the same fact in
   * the product's own word.
   */
  readonly emitter: string;
  /**
   * POV used for these aggregate facts: agent or persona.
   * Count one POV at a time to avoid counting the same exchange twice.
   */
  readonly pov: SpanPov;
  readonly environment: string;
  readonly connectionType: string;
  readonly providerCallId: string;
  readonly agentPlatform: string;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
  readonly runId: string;
  readonly agentId: string;
};

export type TraceSummary = TraceFacts & {
  /**
   * Truncated first human utterance from the turns view, for list previews.
   * Empty if no human turn was recorded; an agent greeting is not the preview.
   */
  readonly preview: string;
  /**
   * The tail wait across the turn responses this trace measured, in
   * milliseconds. `null` means this trace carried no usable
   * `turn_response_latency` measurement; zero remains a real measurement.
   *
   * Computed for the whole page through the same span projection and the same
   * percentile arithmetic as trace detail. It is stored nowhere and is never
   * worked out in SQL.
   */
  readonly turnResponseLatencyP90Milliseconds: number | null;
  /**
   * True when the P90 was computed from the bounded prefix of a larger trace.
   * A platform-reported measure describes the whole call and stays complete.
   */
  readonly turnResponseLatencyP90Partial: boolean;
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
  /**
   * POV for this span: persona for simulator evidence, agent for evidence from
   * the agent platform. Reads return both; displays select the appropriate POV.
   */
  readonly pov: SpanPov;
  /** This span's own children, in time order. A turn is never nested here. */
  readonly spans: readonly TraceSpan[];
};

/**
 * What the agent platform measured about this trace, as the root span carried
 * it.
 *
 * The block itself is `packages/metrics/src/reported.ts` — one neutral
 * shape every platform's normalizer writes and nothing downstream has to know a
 * vendor to read. What this adds is the one fact a reader of the payload has
 * and a reader of the block does not: **which span it rode in on**.
 */
export type ReportedOnTrace = {
  /**
   * The parentless row this block rode in on — the root, as its own platform
   * wrote it.
   *
   * An aggregate describes the whole trace and happened at no single moment
   * inside it, so this is the only span a measurement taken from the block can
   * honestly cite. Carried here rather than looked up again later, because the
   * row that held the block is the row that knows.
   */
  readonly spanId: string;
  /** The platform that measured — `retell`. Provenance, and the word a
   * rationale prints. */
  readonly reportedBy: string;
  readonly measurements: readonly ReportedMeasurement[];
};

export type TraceDetail = TraceFacts & {
  /** The final recognized agent session/call root has arrived. */
  readonly agentEvidenceComplete?: boolean | undefined;
  /** The agent's root says its provider document could not be read whole. */
  readonly agentEvidenceIncomplete?: boolean | undefined;
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
  /**
   * Optional parsed measurements reported by the agent platform, including for
   * simulations. Missing or malformed blocks yield no reported measurements.
   * The shared measure module applies metric provenance and priority rules.
   */
  readonly reported?: ReportedOnTrace | undefined;
};

/* ------------------------------------------------------------------- *
 * The window and the cursor — the two things a caller can get wrong.
 * ------------------------------------------------------------------- */

/**
 * Readable window bounds: DateTime64 starts at 1900 and nanosecond arithmetic
 * is bounded at 2262-04-11. Reject out-of-range input before creating SQL literals.
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
 * Versioned base64url cursor for trace start microseconds and trace ID. It avoids
 * offset shifts when new rows arrive, but late evidence can still move a trace's
 * start time. It is not a snapshot or an authenticated token. Each page still
 * aggregates the requested window; the cursor does not remove that cost.
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
 * Build a typed DateTime64(6) literal from validated integer microseconds.
 * checkedWindow guarantees four-digit years before ISO formatting and slicing.
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
 * Use the context's project when present; a requested project can only narrow
 * an organization-wide context. Treat empty project IDs as absent and bind
 * organization/project IDs as query parameters.
 */
function tenancyOf(auth: AuthContext, asked: string | undefined): Tenancy {
  const projectId = named(auth.projectId) ?? named(asked);
  return {
    clause:
      "organization_id = {organization_id:String} and kind != 'provider_usage'" +
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

/** The storage value that says a row is the agent's own POV. */
const AGENT_POV = "agent";

/**
 * Count agent POV rows when any exist; otherwise count all rows. This prevents
 * double-counting a simulation's agent and persona evidence in the same aggregate.
 */
function counting(rows: string): string {
  // The column, qualified. This block aliases one expression `as emitter`, and
  // an unqualified `emitter` here would resolve to that alias rather than to
  // the column — which is one aggregate inside another, and a query ClickHouse
  // refuses outright. The same trap the `started_at` note above describes.
  const agent = `${SPANS_TABLE}.emitter = '${AGENT_POV}'`;
  return (
    `if(countIf(${agent}) > 0, ` +
    `countIf(${agent} and (${rows})), countIf(${rows}))`
  );
}

/**
 * Shared trace aggregates for list and detail reads. Counts use one POV and
 * cover the full window even when the detail tree is truncated. Clamp negative
 * signed duration conversions to zero when computing the trace end.
 */
const TRACE_FACTS = `toString(${TRACE_POSITION}) as started_at_micros,
       toString(max(
         toUnixTimestamp64Micro(started_at) * 1000
           + greatest(toInt64(duration_ns), 0)
       )) as ended_at_nanos,
       ${counting("1")} as span_count,
       ${counting("kind = 'turn:human'")} as human_turn_count,
       ${counting("kind = 'turn:agent'")} as agent_turn_count,
       ${counting("kind = 'tool'")} as tool_span_count,
       ${counting("status = 'error'")} as errored_span_count,
       any(project_id) as trace_project_id,
       any(source) as source,
       if(countIf(${SPANS_TABLE}.emitter = '${AGENT_POV}') > 0, '${AGENT_POV}', any(${SPANS_TABLE}.emitter)) as emitter,
       any(environment) as environment,
       any(connection_type) as connection_type,
       argMinIf(provider_call_id, tuple(parent_span_id != '', started_at), provider_call_id != '') as provider_call_id,
       argMinIf(agent_platform, tuple(parent_span_id != '', started_at), agent_platform != '') as agent_platform,
       argMinIf(platform_agent_id, tuple(parent_span_id != '', started_at), platform_agent_id != '') as platform_agent_id,
       argMinIf(platform_agent_name, tuple(parent_span_id != '', started_at), platform_agent_name != '') as platform_agent_name,
       argMinIf(platform_agent_version, tuple(parent_span_id != '', started_at), platform_agent_version != '') as platform_agent_version,
       any(run_id) as run_id,
       any(agent_id) as agent_id`;

type SummaryRow = {
  readonly trace_id: string;
  readonly trace_project_id: string;
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
  readonly agent_platform: string;
  readonly platform_agent_id: string;
  readonly platform_agent_name: string;
  readonly platform_agent_version: string;
  readonly run_id: string;
  readonly agent_id: string;
};

/**
 * List traces newest first from spans so traces without turn rows remain visible.
 * Use the turns view only for previews. Apply source filtering before grouping
 * and pagination; omit source to include production and simulation traffic.
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

  // Filter source in WHERE before grouping. Qualify the column to avoid resolving
  // to the select alias any(source), which cannot be used in a row predicate.
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
      ? undefined
      : `(${TRACE_POSITION}, trace_id) < ` +
        `({cursor_started_at:Int64}, {cursor_trace_id:String})`;

  // Hide only known successful LiveKit lifecycle-only traces from the production
  // list. Apply HAVING before pagination; mixed, new, rooted, or failed traces stay
  // visible. Direct detail reads retain access to the omitted evidence.
  const visibleProductionTracePredicate =
    source === "production"
      ? `not (
         countIf(${SPANS_TABLE}.agent_platform = 'livekit') = count()
         and countIf(${SPANS_TABLE}.name in {livekit_lifecycle_names:Array(String)}) = count()
         and countIf(${SPANS_TABLE}.kind = 'root') = 0
         and countIf(${SPANS_TABLE}.status = 'error') = 0
       )`
      : undefined;
  const groupedPredicates = [visibleProductionTracePredicate, after].filter(
    (predicate): predicate is string => predicate !== undefined,
  );
  const having =
    groupedPredicates.length === 0
      ? ""
      : `having ${groupedPredicates.join("\n       and ")} `;

  // One row more than the page, so that whether there is a next page is a fact
  // rather than a guess. A cursor handed out for an empty next page is a caller
  // making a request in order to be told there is nothing.
  const rows = await rowsOf<SummaryRow>(
    `select
       trace_id,
       ${TRACE_FACTS}
     from ${SPANS_TABLE} final
     where ${tenancy.clause}
       and started_at >= ${asDateTime64(window.from)}
       and started_at < ${asDateTime64(window.to)}${narrowing}
     group by trace_id
     ${having}order by ${TRACE_POSITION} desc, trace_id desc
     limit ${limit + 1}`,
    {
      ...tenancy.parameters,
      ...(source === undefined ? {} : { source }),
      ...(source === "production"
        ? { livekit_lifecycle_names: LIVEKIT_LIFECYCLE_SPAN_NAMES }
        : {}),
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

  const traceIds = page.map((row) => row.trace_id);
  const [previews, turnResponseLatencyP90s] = await Promise.all([
    previewsFor(
      tenancy,
      traceIds,
      // The page is newest first, so its last row is the earliest any span of
      // any trace on it can be.
      last === undefined ? window.from : BigInt(last.started_at_micros),
      window.to,
    ),
    turnResponseLatencyP90sFor(
      tenancy,
      traceIds,
      // Use the request's exact window. A detail read made from this list uses
      // the same bounds, and the two projections must keep the same prefix when
      // a trace is larger than the read cap.
      window.from,
      window.to,
    ),
  ]);

  return {
    traces: page.map((row) => {
      const facts = factsOf(row.trace_id, row);
      const latency = turnResponseLatencyP90s.get(row.trace_id) ?? null;
      return {
        ...facts,
        preview: previews.get(row.trace_id) ?? "",
        turnResponseLatencyP90Milliseconds: latency?.milliseconds ?? null,
        turnResponseLatencyP90Partial:
          latency !== null &&
          latency.origin !== "reported" &&
          facts.spanCount > MAXIMUM_SPANS_PER_TRACE,
      };
    }),
    nextCursor,
  };
}

/**
 * The span fields the shared metric arithmetic needs, plus the trace they
 * belong to while one page is projected in a batch.
 *
 * The query ranks every stored span before it keeps only metric-relevant rows.
 * That order matters: detail keeps the first `MAXIMUM_SPANS_PER_TRACE` rows and
 * computes a partial metric from that prefix, so filtering first would let a
 * later timing span into the list value even though detail had truncated it.
 */
type PageMeasureSpanRow = {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly name: string;
  readonly kind: string;
  readonly started_at_micros: string;
  readonly duration_ns: string;
  /** Whose account each row is, so the projection derives from one of them. */
  readonly emitter: string;
};

type PageRootSliceRow = RootSliceRow & {
  readonly trace_id: string;
};

type PageTurnResponseLatencyP90 = {
  readonly milliseconds: number;
  readonly origin: MeasuredFromSpans["origin"];
};

/**
 * One batched projection of a page onto its P90 turn-response latency.
 *
 * It performs no detail reads. One bounded span query fetches only the rows
 * the canonical measure can use from each trace's detail-sized prefix, and one
 * root query fetches the reported-measurement corner for every trace. The
 * shared `measuresFromSpans` and `aggregateOf` functions then decide source
 * priority, derivation, units, invalid samples, and percentile arithmetic.
 */
async function turnResponseLatencyP90sFor(
  tenancy: Tenancy,
  traceIds: readonly string[],
  fromMicroseconds: bigint,
  toMicroseconds: bigint,
): Promise<Map<string, PageTurnResponseLatencyP90 | null>> {
  if (traceIds.length === 0) return new Map();

  const where = `${tenancy.clause}
       and started_at >= ${asDateTime64(fromMicroseconds)}
       and started_at < ${asDateTime64(toMicroseconds)}
       and trace_id in {trace_ids:Array(String)}`;
  const parameters = {
    ...tenancy.parameters,
    trace_ids: [...traceIds],
    turn_latency_kinds: [...turnResponseLatencySpanKinds()],
  };

  const [rows, roots] = await Promise.all([
    rowsOf<PageMeasureSpanRow>(
      `select
       trace_id,
       span_id,
       parent_span_id,
       name,
       kind,
       started_at_micros,
       duration_ns,
       emitter
     from (
       select
         trace_id,
         span_id,
         parent_span_id,
         name,
         kind,
         emitter,
         toString(toUnixTimestamp64Micro(started_at)) as started_at_micros,
         toString(duration_ns) as duration_ns,
         row_number() over (
           partition by trace_id order by ${TRACE_ROW_ORDER}
         ) as trace_position
       from ${SPANS_TABLE} final
       where ${where}
     )
     where trace_position <= ${MAXIMUM_SPANS_PER_TRACE}
       and kind in {turn_latency_kinds:Array(String)}
     order by trace_id asc, trace_position asc`,
      parameters,
    ),
    rowsOf<PageRootSliceRow>(
      `select
       trace_id,
       span_id,
       normalised
     from (
       select
         trace_id,
         span_id,
         JSONExtractRaw(payload, '${NORMALISED_KEY}') as normalised,
         row_number() over (
           partition by trace_id order by ${PARENTLESS_ROW_ORDER}
         ) as root_position
       from ${SPANS_TABLE} final
       where ${where}
         and parent_span_id = ''
     )
     where root_position = 1`,
      parameters,
    ),
  ]);

  const rowsByTrace = new Map<string, PageMeasureSpanRow[]>();
  for (const row of rows) {
    const held = rowsByTrace.get(row.trace_id);
    if (held === undefined) rowsByTrace.set(row.trace_id, [row]);
    else held.push(row);
  }
  const rootsByTrace = new Map(roots.map((root) => [root.trace_id, root]));

  return new Map<string, PageTurnResponseLatencyP90 | null>(
    traceIds.map((traceId) => {
      const projected = transcriptOf(
        (rowsByTrace.get(traceId) ?? []).map(measureSpanRowAsSpanRow),
      );
      const measured = measuresFromSpans({
        ...projected,
        reported: reportedOn(rootsByTrace.get(traceId)),
      }).find((one) => one.measure === "turn_response_latency");
      const p90 =
        measured === undefined ? undefined : aggregateOf(measured, "p90");
      return [
        traceId,
        measured === undefined || p90 === undefined
          ? null
          : { milliseconds: p90, origin: measured.origin },
      ] as const;
    }),
  );
}

/** Supply only display fields the metric projection never reads. */
function measureSpanRowAsSpanRow(row: PageMeasureSpanRow): SpanRow {
  return {
    ...row,
    status: "",
    text: "",
    audio_url: "",
    tool_name: "",
    tool_arguments: "",
    tool_result: "",
    provider_tool_id: "",
    // The emitter rides through from the row above, and is the one display
    // field here that is not blank: the metric arithmetic derives from the
    // agent's own turns alone, so a simulation's two accounts of one
    // conversation have to arrive still telling each other apart. Blanking it
    // would hand the derivation two accounts as one and measure every wait
    // twice over.
  };
}

/**
 * One aggregate row as the facts both endpoints report.
 *
 * Most trace-level columns are denormalised onto every span, which makes
 * `any()` the right aggregate for them. The platform agent reference is
 * different: an emitter may put it only on the root. Those fields are selected
 * from a parentless non-empty row first, then from any non-empty row, so an
 * empty child can never erase the reference the root carried.
 */
function factsOf(traceId: string, row: SummaryRow): TraceFacts {
  const startedAt = BigInt(row.started_at_micros);
  const endedAtNanoseconds = BigInt(row.ended_at_nanos);

  return {
    projectId: row.trace_project_id,
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
    pov: povOf(row.emitter),
    environment: row.environment,
    connectionType: row.connection_type,
    providerCallId: row.provider_call_id,
    agentPlatform: row.agent_platform,
    platformAgentId: row.platform_agent_id,
    platformAgentName: row.platform_agent_name,
    platformAgentVersion: row.platform_agent_version,
    runId: row.run_id,
    agentId: row.agent_id,
  };
}

/**
 * Read first human-turn previews only for traces on this page, from their earliest
 * start to the window end. Select text_preview without loading full span text.
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
     from ${TURNS_TABLE} final
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
  /** Retell's structural correlation id, extracted without the tool payload. */
  readonly provider_tool_id: string;
  /** `egma-runtime` or `agent` — whose POV of the conversation this row is. */
  readonly emitter: string;
};

/** A turn is a span whose kind says somebody was speaking. */
function isTurn(kind: string): boolean {
  return kind.startsWith("turn:");
}

/**
 * Read one trace within a required time window and authorization scope. Return
 * bounded transcript rows and full-window aggregates. Omit the provider payload;
 * project only normalized measurements and the Retell IDs/times needed for
 * tool-timing compatibility. Return undefined when no visible span exists.
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

  // Read capped tree rows, full-window aggregates, and the parentless payload
  // projection in parallel with the same scope and time bounds. Order tree rows
  // by start time and span ID; ingestion handles evidence conflicts before storage.
  const [summaries, rows, roots] = await Promise.all([
    rowsOf<SummaryRow & { agent_evidence_complete: number; agent_evidence_incomplete: number }>(
      `select
       trace_id,
       ${TRACE_FACTS},
       countIf(${AGENT_EVIDENCE_COMPLETE_SQL}) > 0 as agent_evidence_complete,
       countIf(${AGENT_EVIDENCE_INCOMPLETE_SQL}) > 0 as agent_evidence_incomplete
     from ${SPANS_TABLE} final
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
       tool_result,
       if(
         agent_platform = 'retell' and kind = 'tool',
         JSONExtractString(payload, 'id'),
         ''
       ) as provider_tool_id,
       -- Whose POV of the conversation each row is. A simulation holds
       -- both POVs under one trace, so the surface above has to be able to
       -- tell them apart; nothing here chooses between them.
       --
       -- Deliberately **not** a payload stamp saying who answered a tool
       -- call. Whether a mock tool answered is read by name from the
       -- simulation's pinned test version, where the authored world actually
       -- lives — a second copy on the span could only come to disagree with
       -- it, and this read has no simulation to ask.
       emitter
     from ${SPANS_TABLE} final
     where ${where}
     order by ${TRACE_ROW_ORDER}
     limit ${MAXIMUM_SPANS_PER_TRACE + 1}`,
      parameters,
    ),
    rowsOf<RootSliceRow>(
      // Project normalized measurements and Retell timing fields from one parentless
      // row chosen by PARENTLESS_ROW_ORDER. A missing parent can also produce such a
      // row, so this selection does not prove trace completion.
      `select
       span_id,
       span_id as root_span_id,
       JSONExtractRaw(payload, '${NORMALISED_KEY}') as normalised,
       toJSONString(arrayMap(
         event -> tuple(
           JSONExtractString(event, 'role'),
           JSONExtractString(event, 'tool_call_id'),
           JSONExtractRaw(event, 'time_sec')
         ),
         JSONExtractArrayRaw(payload, 'transcript_with_tool_calls')
       )) as retell_woven,
       toJSONString(arrayMap(
         summary -> tuple(
           JSONExtractString(summary, 'tool_call_id'),
           JSONExtractRaw(summary, 'start_time_sec'),
           JSONExtractRaw(summary, 'latency_ms')
         ),
         JSONExtractArrayRaw(payload, 'tool_calls')
       )) as retell_tool_summaries
     from ${SPANS_TABLE} final
     where ${where}
       and parent_span_id = ''
     order by ${PARENTLESS_ROW_ORDER}
     limit 1`,
      parameters,
    ),
  ]);

  const facts = summaries[0];
  if (facts === undefined || rows.length === 0) return undefined;

  const projected = withRetellToolTimeline(traceId, rows, roots[0]);
  const truncated = projected.length > MAXIMUM_SPANS_PER_TRACE;
  const kept = truncated
    ? projected.slice(0, MAXIMUM_SPANS_PER_TRACE)
    : projected;

  return {
    ...factsOf(traceId, facts),
    ...transcriptOf(kept),
    truncated,
    reported: reportedOn(roots[0]),
    agentEvidenceComplete: facts.agent_evidence_complete === 1 && facts.agent_evidence_incomplete === 0,
    ...(facts.agent_evidence_incomplete === 1
      ? { agentEvidenceIncomplete: true }
      : {}),
  };
}

/** The root id, egma-owned block, and bounded Retell structural projections. */
type RootSliceRow = RetellToolTimelineSlice & {
  readonly span_id: string;
  readonly normalised: string;
};

/**
 * Read the measurement block through reportedMeasurementsOf. Missing, malformed,
 * or unsupported blocks return undefined without preventing transcript access.
 */
function reportedOn(row: RootSliceRow | undefined): ReportedOnTrace | undefined {
  if (row === undefined || row.normalised === "") return undefined;

  let slice: unknown;
  try {
    slice = JSON.parse(row.normalised);
  } catch {
    return undefined;
  }
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    return undefined;
  }

  const block = reportedMeasurementsOf(
    (slice as Record<string, unknown>)[REPORTED_MEASUREMENTS_PAYLOAD_KEY],
  );
  if (block === undefined) return undefined;
  return {
    spanId: row.span_id,
    reportedBy: block.reportedBy,
    measurements: block.measurements,
  };
}

/**
 * Return every input row once. Lift turns into their own list; retain other
 * parent/child structure. Missing or self parents become top-level spans.
 * Visit remaining rows after roots to retain cycles. Track row objects, not span
 * IDs, so duplicate IDs do not hide rows; the first visited parent takes shared children.
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

  // Parentage is named by span id, but row identity is the only honest walk
  // identity: changed evidence may reuse ids and every stored row must return.
  // Object identity also closes cycles without collapsing those rows.
  const visited = new Set<SpanRow>();

  const build = (row: SpanRow): TraceSpan => {
    visited.add(row);
    const children: TraceSpan[] = [];
    // Recheck immediately before each descent. An earlier sibling can reach a
    // later one through a cycle whose rows reuse an id; filtering the whole
    // sibling list first would then build that later row twice.
    for (const child of childrenOf.get(row.span_id) ?? []) {
      if (isTurn(child.kind) || visited.has(child)) continue;
      children.push(build(child));
    }
    return { ...spanOf(row), spans: children };
  };

  const turns = rows
    .filter((row) => isTurn(row.kind))
    .map((row) => (visited.has(row) ? undefined : build(row)))
    .filter((turn): turn is TraceSpan => turn !== undefined);

  const spans: TraceSpan[] = [];

  // Asked one row at a time rather than filtered first, because building one of
  // these visits everything under it: a candidate that was still unvisited when
  // the list was drawn up can have been reached by the time its turn comes.
  const appendUnvisited = (candidates: readonly SpanRow[]): void => {
    for (const row of candidates) {
      if (isTurn(row.kind) || visited.has(row)) continue;
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
    // The storage word, passed through. `agent` is anything a customer's own
    // process reported; every other value is egma's own simulator, and a row
    // written before the column had a second value reads as the persona's POV
    // because that is the only POV those rows could hold.
    pov: povOf(row.emitter),
  };
}
