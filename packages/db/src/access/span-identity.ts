import { TupleParam } from "@clickhouse/client";

import { traceStore } from "../clickhouse/client.ts";
import type { AuthContext } from "./context.ts";
import { UnreadableTraceQueryError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import type { TimeWindow } from "./traces.ts";

/**
 * Batched ingestion probes for committed span hashes and trace IDs. Require read
 * permission and a time window derived from the segment or scan being processed,
 * not the current clock. These internal probes do not apply the product read
 * window limit; older evidence still needs bounded replay checks.
 */

const SPANS_TABLE = "spans";

/**
 * How many identities one statement asks about.
 *
 * Query parameters travel in the request URL, so an unbounded list is a request
 * an HTTP intermediary refuses before ClickHouse ever sees it. Five hundred
 * pairs is comfortably inside every limit in that chain and still turns a
 * five-thousand-span segment into ten round trips rather than five thousand.
 */
const IDENTITIES_PER_LOOKUP = 500;

/** One span, named the only way a span is ever permanently named. */
export type SpanIdentity = {
  readonly traceId: string;
  readonly spanId: string;
};

/** A span the store already holds, and what it says. */
export type CommittedSpan = SpanIdentity & {
  /**
   * Stored evidence hash: equal means replay; different means conflicting evidence.
   * An empty legacy hash cannot prove equality. Preserve the stored row in that case.
   */
  readonly contentHash: string;
  /** Earliest visible span for this trace inside the caller's bounded window. */
  readonly traceStartedAtMicroseconds: bigint;
};

export type CommittedSpansOptions = {
  /** Wide enough to hold every identity asked about, and no wider. */
  readonly window: TimeWindow;
  /**
   * Narrow to one project, and **only narrow** — a credential that already
   * names a project answers for that project whatever this says.
   */
  readonly projectId?: string | undefined;
};

export type CommittedTracesOptions = CommittedSpansOptions;

/**
 * Which of these spans the store already holds, and what each of them says.
 *
 * The pre-write integrity check, and the reason a replay is safe: a caller
 * about to write evidence for an identity that already exists compares the two
 * fingerprints and either does nothing or refuses, and in neither case does it
 * overwrite. Identities the store does not hold are simply absent from the
 * answer — this is a probe, so nothing is missing and nothing is an error.
 */
export async function committedSpans(
  auth: AuthContext,
  identities: readonly SpanIdentity[],
  options: CommittedSpansOptions,
): Promise<CommittedSpan[]> {
  authorize(auth, "read", here(auth));

  if (identities.length === 0) return [];

  const window = checkedWindow(options.window);
  const tenancy = tenancyOf(auth, options.projectId);
  const found: CommittedSpan[] = [];

  for (const batch of batched(identities, IDENTITIES_PER_LOOKUP)) {
    const rows = await rowsOf<{
      trace_id: string;
      span_id: string;
      content_hash: string;
      trace_started_at_micros: string;
    }>(
      `select
         held.trace_id as trace_id,
         held.span_id as span_id,
         held.content_hash as content_hash,
         toString(toUnixTimestamp64Micro(bounds.trace_started_at)) as trace_started_at_micros
       from
       (
         select trace_id, span_id, content_hash
           from ${SPANS_TABLE} final
          where ${tenancy.clause}
            and started_at >= ${asDateTime64(window.from)}
            and started_at < ${asDateTime64(window.to)}
            and (trace_id, span_id) in {identities:Array(Tuple(String, String))}
       ) as held
       inner join
       (
         select trace_id, min(started_at) as trace_started_at
           from ${SPANS_TABLE} final
          where ${tenancy.clause}
            and started_at >= ${asDateTime64(window.from)}
            and started_at < ${asDateTime64(window.to)}
            and trace_id in {trace_ids:Array(String)}
          group by trace_id
       ) as bounds using (trace_id)`,
      {
        ...tenancy.parameters,
        trace_ids: [...new Set(batch.map((identity) => identity.traceId))],
        identities: batch.map(
          (identity) => new TupleParam([identity.traceId, identity.spanId]),
        ),
      },
    );

    for (const row of rows) {
      found.push({
        traceId: row.trace_id,
        spanId: row.span_id,
        contentHash: row.content_hash,
        traceStartedAtMicroseconds: BigInt(row.trace_started_at_micros),
      });
    }
  }

  return found;
}

/**
 * Find trace IDs with any committed span before polling fetches full records.
 * Presence does not mean the trace is complete.
 */
export async function committedTraces(
  auth: AuthContext,
  traceIds: readonly string[],
  options: CommittedTracesOptions,
): Promise<ReadonlySet<string>> {
  authorize(auth, "read", here(auth));

  if (traceIds.length === 0) return new Set();

  const window = checkedWindow(options.window);
  const tenancy = tenancyOf(auth, options.projectId);
  const found = new Set<string>();

  for (const batch of batched(traceIds, IDENTITIES_PER_LOOKUP)) {
    // No `FINAL`, and it changes nothing: collapsing rows that share a
    // sorting key can never remove the key itself, so the set of distinct
    // trace ids is the same either way and the merge pass would buy nothing.
    const rows = await rowsOf<{ trace_id: string }>(
      `select distinct trace_id
         from ${SPANS_TABLE}
        where ${tenancy.clause}
          and started_at >= ${asDateTime64(window.from)}
          and started_at < ${asDateTime64(window.to)}
          and trace_id in {trace_ids:Array(String)}`,
      { ...tenancy.parameters, trace_ids: [...batch] },
    );

    for (const row of rows) found.add(row.trace_id);
  }

  return found;
}

/* ------------------------------------------------------------------- *
 * The store, reached the one way this module reaches it.
 * ------------------------------------------------------------------- */

function* batched<Item>(
  items: readonly Item[],
  size: number,
): Generator<readonly Item[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

type Tenancy = {
  readonly clause: string;
  readonly parameters: Record<string, unknown>;
};

/**
 * The organization, and the project when there is one to name.
 *
 * `auth.projectId` wins over anything asked for, exactly as on the read
 * surface: a probe is still a question about somebody's rows, and a key minted
 * for one product area cannot be talked into another. An empty project id is
 * nobody's project and is read as absence rather than as a name no row was ever
 * written under.
 */
function tenancyOf(auth: AuthContext, asked: string | undefined): Tenancy {
  const named = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value;
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

/**
 * The instants a probe may name, which are the ones `DateTime64` holds and the
 * ones a four-digit year can be sliced out of. The read surface refuses the same
 * two ends for the same reason and refuses a third — a window wider than the
 * product serves — which does not apply here.
 */
export const EARLIEST_READABLE_MICROSECONDS = BigInt(Date.UTC(1900, 0, 1)) * 1000n;
export const LATEST_READABLE_MICROSECONDS = BigInt(Date.UTC(2262, 3, 11)) * 1000n;

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
        "hold, which is 1900-01-01 to 2262-04-11.",
    );
  }

  return { from, to };
}

/**
 * The exact literal `DateTime64(6)` reads, built from an integer count of
 * microseconds so that no floating-point step can move a bound.
 */
function asDateTime64(microseconds: bigint): string {
  const MILLION = 1_000_000n;
  // Floor division, so an instant before 1970 keeps a non-negative remainder.
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
