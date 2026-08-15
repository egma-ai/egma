import {
  listTraces,
  MAXIMUM_LIST_LIMIT,
  NotPermittedError,
  readAssertionWords,
  readTrace,
  readVerdicts,
  UnreadableTraceQueryError,
  type AssertionWords,
  type TimeWindow,
  type TraceDetail,
  type TraceFacts,
  type TraceSpan,
  type TraceSummary,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import { simulationIdOfTrace } from "@egma/simulation-contract";

import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";

/**
 * The two v1 read endpoints: the list of a customer's traces, and one trace as a
 * transcript.
 *
 * They carry the real contract from the first commit, and the reason is that a
 * read API is a one-way door. Everything expensive about it is decided now,
 * while the only consumer is egma's own dashboard: **the window is required and
 * capped**, so no request can ask the store to read everything it holds;
 * **paging is by token**, so a page is a position in an ordering rather than a
 * count of rows to skip and re-sort; and **the organization comes from the
 * credential**, so there is no query parameter that could name somebody else's
 * data. Adding any of those later means breaking every integration written
 * against their absence.
 *
 * **The project is a filter and never a wall.** Reading across a whole
 * organization is the first-class case, because two projects of one customer are
 * always queryable together; `project_id` narrows to one when a caller wants
 * that. A credential that already names a project reads that project and cannot
 * be argued out of it.
 *
 * **`trace` and `span` are storage words**, and they are the right ones in a
 * machine API: this is the store's own surface, and the paths, the parameters
 * and the field names all say so. They never reach a page — what a person reads
 * is a transcript of a simulation.
 *
 * Separate from the ingest door in the same way it is separate from every other
 * route: that plugin replaces its own body parsers so telemetry arrives as the
 * bytes that were sent, and these are ordinary JSON responses that want nothing
 * to do with it. `POST /v1/traces` and `GET /v1/traces` share a path and no code.
 */

export type TraceReadRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const TRACES_LIST_PATH = "/v1/traces";
export const TRACE_DETAIL_PATH = "/v1/traces/:traceId";

type Query = {
  readonly from?: string;
  readonly to?: string;
  readonly project_id?: string;
  readonly limit?: string;
  readonly cursor?: string;
};

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: "invalid_request", message });
}

/**
 * How many digits of a second the store has room for, and therefore how many a
 * bound may name.
 */
const MICROSECOND_DIGITS = 6;

/** The fractional second, which is the one part `Date` cannot be trusted with. */
const FRACTIONAL_SECOND = /^(.*\d{2}:\d{2}:\d{2})\.(\d+)(.*)$/u;

/**
 * An RFC 3339 instant as microseconds since the epoch, or `undefined` for
 * anything that is not one.
 *
 * `Date` still does the calendar and the offset; only the fraction is read here,
 * because a `Date` holds milliseconds and this store holds microseconds. `to` is
 * exclusive, so a bound rounded down to the millisecond silently drops the 999
 * microseconds after it — paste a trace's own `ended_at` of `…776865Z` in as
 * `to` and the span that ended at it would be missing, with nothing in the
 * answer to say why.
 *
 * More than six digits is refused rather than rounded, for the same reason a
 * too-wide window is: there is no seventh digit in the column to put it in, so
 * honouring it would mean moving somebody's bound and not mentioning it.
 */
function instantOf(text: string): bigint | undefined {
  const fraction = FRACTIONAL_SECOND.exec(text);
  const [, whole = "", digits = "", zone = ""] = fraction ?? [];
  if (digits.length > MICROSECOND_DIGITS) return undefined;

  const milliseconds = new Date(
    fraction === null ? text : `${whole}${zone}`,
  ).getTime();
  if (Number.isNaN(milliseconds)) return undefined;

  return (
    BigInt(milliseconds) * 1000n +
    BigInt(digits.padEnd(MICROSECOND_DIGITS, "0"))
  );
}

/**
 * The window, as the two parameters that carry it.
 *
 * Absence is refused rather than defaulted, and the message says what to send.
 * A default window would be the most reasonable-looking way to reintroduce the
 * unbounded read this whole surface is built to prevent — the caller who did not
 * think about the window is exactly the caller whose query would scan
 * everything.
 */
type ParsedWindow = TimeWindow | { readonly refusal: string };

function windowOf(query: Query): ParsedWindow {
  const from = given(query.from);
  const to = given(query.to);

  const missing = [
    ...(from === undefined ? ["from"] : []),
    ...(to === undefined ? ["to"] : []),
  ];
  if (missing.length > 0) {
    return {
      refusal:
        `a trace query names the window it is asking about, and this one has ` +
        `no ${missing.join(" and no ")}. Send both as RFC 3339 timestamps — ` +
        `from=2026-08-02T00:00:00Z&to=2026-08-03T00:00:00Z. There is no ` +
        `default: the store is filed by time, and a read that named none would ` +
        `be a read of everything.`,
    };
  }

  const opened = instantOf(from ?? "");
  const closed = instantOf(to ?? "");
  if (opened === undefined || closed === undefined) {
    return {
      refusal:
        "from and to are RFC 3339 timestamps, and one of these is not a time " +
        "egma can read. An example of the shape: 2026-08-02T18:04:40.281989Z. " +
        "Fractional seconds are honoured to six digits, which is what the " +
        "store holds; a finer one is refused rather than rounded, because " +
        "rounding an exclusive bound moves the edge of your window.",
    };
  }

  return { from: opened, to: closed };
}

/**
 * The window as it was read, to the microsecond it was read at.
 *
 * The same precision every other instant in these responses comes back at, so a
 * caller can paste one straight back in. The division is written out here rather
 * than borrowed from the store: the data-access module formats its own return
 * values this way, and ten lines are not a reason to widen a boundary that
 * exists to be narrow.
 *
 * Only ever reached on a window the store has already accepted, which is what
 * makes the four-digit year `toISOString` writes a safe thing to assume.
 */
function describedWindow(window: TimeWindow): Record<string, string> {
  const MILLION = 1_000_000n;
  const format = (microseconds: bigint): string => {
    let seconds = microseconds / MILLION;
    let remainder = microseconds % MILLION;
    if (remainder < 0n) {
      seconds -= 1n;
      remainder += MILLION;
    }
    const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
    return `${whole}.${remainder.toString().padStart(MICROSECOND_DIGITS, "0")}Z`;
  };

  return { from: format(window.from), to: format(window.to) };
}

/** A trace, as the list describes one. Snake case, as the rest of the API is. */
function describedFacts(facts: TraceFacts): Record<string, unknown> {
  return {
    trace_id: facts.traceId,
    started_at: facts.startedAt,
    ended_at: facts.endedAt,
    // A decimal string, because a nanosecond count passes what a JSON number
    // holds exactly and a silently rounded latency is worse than no latency.
    duration_ns: facts.durationNanoseconds,
    span_count: facts.spanCount,
    turn_counts: { human: facts.humanTurnCount, agent: facts.agentTurnCount },
    tool_span_count: facts.toolSpanCount,
    errored_span_count: facts.erroredSpanCount,
    source: facts.source,
    emitter: facts.emitter,
    environment: facts.environment,
    connection_type: facts.connectionType,
    provider_call_id: facts.providerCallId,
    run_id: facts.runId,
    agent_id: facts.agentId,
  };
}

function describedSummary(summary: TraceSummary): Record<string, unknown> {
  return { ...describedFacts(summary), preview: summary.preview };
}

/**
 * One span and everything under it.
 *
 * The verbatim payload is deliberately not here — see `readTrace`, which
 * explains where it goes instead and why fetching it is a separate request
 * nothing has needed yet.
 */
function describedSpan(span: TraceSpan): Record<string, unknown> {
  return {
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    started_at: span.startedAt,
    duration_ns: span.durationNanoseconds,
    text: span.text,
    audio_url: span.audioUrl,
    tool_name: span.toolName,
    tool_arguments: span.toolArguments,
    tool_result: span.toolResult,
    spans: span.spans.map(describedSpan),
  };
}

function describedDetail(detail: TraceDetail): Record<string, unknown> {
  return {
    trace: describedFacts(detail),
    turns: detail.turns.map(describedSpan),
    spans: detail.spans.map(describedSpan),
    spans_truncated: detail.truncated,
  };
}

export async function traceReadRoutes(
  app: FastifyInstance,
  options: TraceReadRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The customer's traces inside a window, newest first.
   *
   * `limit` above the maximum is clamped rather than refused, which is the
   * ordinary reading of the word: a caller asking for a thousand gets the page
   * size back in the page they were given, and nothing they asked for is
   * missing. A `limit` that is not a count at all — zero, negative, or a word —
   * is refused, because there is no page that answers it. The window is a third
   * case and is always refused, because a narrowed window silently answers a
   * different question.
   *
   * **A parameter that arrived empty is a parameter nobody set.** `?project_id=`
   * is what a form submits for a field left blank, and reading it as a name
   * would answer with the traces of a project that cannot exist; `?limit=` is
   * the same case, and `Number("")` is zero, which would be refused as a page
   * size nobody could want. Both read as absence, which is what they mean.
   */
  app.get(TRACES_LIST_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const window = windowOf(query);
    if ("refusal" in window) return invalid(reply, window.refusal);

    const projectId = given(query.project_id);
    const project = projectRefusal(auth.projectId, projectId);
    if (project !== undefined) return invalid(reply, project);

    const asked = given(query.limit);
    const limit = asked === undefined ? undefined : Number(asked);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return invalid(
        reply,
        `limit is how many traces one page may carry, at most ` +
          `${MAXIMUM_LIST_LIMIT}, and "${asked}" is not a count.`,
      );
    }

    const list = await listTraces(auth, {
      window,
      projectId,
      limit,
      cursor: given(query.cursor),
    });

    return reply.send({
      traces: list.traces.map(describedSummary),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: list.nextCursor ?? null,
      window: describedWindow(window),
    });
  });

  /**
   * One trace, transcript-ordered.
   *
   * The window is required here too. A trace id is not a prefix of the store's
   * filing order, so a lookup naming only an id has nothing to prune with and
   * would read every partition there is; naming when it happened is what makes
   * fetching one trace cheap. The list that found the trace already knows
   * the answer, so this costs a caller nothing they did not have.
   */
  app.get(TRACE_DETAIL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;
    const { traceId } = request.params as { traceId: string };

    const window = windowOf(query);
    if ("refusal" in window) return invalid(reply, window.refusal);

    const projectId = given(query.project_id);
    const project = projectRefusal(auth.projectId, projectId);
    if (project !== undefined) return invalid(reply, project);

    const detail = await readTrace(auth, traceId, { window, projectId });

    // A trace this customer has no span of is a trace that is not there, and it
    // reads identically whether it belongs to somebody else or to nobody. That
    // is the whole answer: a guessed id tells the guesser nothing, because the
    // organization leads the filing order and the query never reached the rows.
    if (detail === undefined) {
      return reply.code(404).send({
        error: "no_such_trace",
        message:
          "no trace by that id is in this organization inside that window. " +
          "Check the window before the id: a trace outside it is not found, " +
          "and the two answers are the same one.",
      });
    }

    // What egma made of this exchange, beside the exchange itself. A judgment
    // cites a turn by its position, and the positions are right here — so this
    // is the one place a verdict and the words it is about can be read
    // together. The verdict store is a separate store: if it cannot be reached,
    // the transcript is still the answer somebody came for, so an unreadable
    // one degrades to no judgments rather than to no trace.
    // A simulation's verdicts are filed under its own id, and its spans under
    // the 128 bits that id carries written as hex. The two are the same number,
    // so the reader that has one can always derive the other — which is what
    // lets a transcript show what egma made of it with nothing having stored a
    // mapping. A production trace derives to a simulation id nothing minted,
    // and simply has no verdicts filed that way.
    const filedUnder = simulationIdOfTrace(traceId) ?? traceId;
    const judged = await readVerdicts(auth, filedUnder, { projectId }).catch(
      () => undefined,
    );

    // The words behind the assertion keys, from the version this conversation
    // was pinned to. Only a simulation has one — a production trace is in
    // nobody's scenario — and this is the same resolution a run's results make,
    // through the same call, so the one judgment card cannot read two ways
    // depending on which page it is drawn on.
    const words: AssertionWords | undefined =
      detail.source === "simulation" && (judged?.verdicts.length ?? 0) > 0
        ? await readAssertionWords(
            auth,
            filedUnder,
            (judged?.verdicts ?? []).map((its) => its.graderId),
          ).catch(() => undefined)
        : undefined;

    return reply.send({
      ...describedDetail(detail),
      // The same derivation again, and this time as an answer rather than as a
      // lookup key: which simulation this trace *is*, for a reader holding only
      // the hex.
      //
      // **Only where egma conducted the exchange.** Every trace id converts —
      // they are the same 128 bits written two ways, so a customer's own
      // production trace derives a perfectly well-formed simulation id that
      // nothing ever minted. Sending that would be this endpoint claiming a
      // simulation exists, and the transcript surface would go asking for the
      // recording of a conversation egma never had. `source` is the row's own
      // word for who conducted it, so it decides here rather than the reader
      // guessing from an id that is always present.
      //
      // It is one field on an answer already being sent, computed from what is
      // already in hand: no second read, no join, and no second endpoint for
      // the surface that needs it. A transcript then resolves its recording
      // through the one route a run's results use.
      simulation_id:
        detail.source === "simulation"
          ? simulationIdOfTrace(traceId) ?? null
          : null,
      // `assertion` is the key the store keeps; `assertion_text` is what a
      // person reads, fetched from the pinned version at display time and null
      // wherever nothing can place the key.
      verdicts: (judged?.verdicts ?? []).map((its) => ({
        grader_id: its.graderId,
        assertion: its.assertion,
        assertion_text: words?.of(its.graderId, its.assertion) ?? null,
        verdict: its.verdict,
        score: its.score,
        rationale: its.rationale,
        cited_turns: [...its.citedSpanIds],
        judged_at: its.judgedAt,
      })),
      // The required lane, as everywhere: a diagnostic copy reports and never
      // decides.
      outcome:
        judged === undefined
          ? null
          : {
              verdict: judged.outcome.verdict,
              score: judged.outcome.score ?? null,
              counts: judged.outcome.counts,
            },
    });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    // A window or a token the read surface will not take. Not a fault and not a
    // permission problem — the caller is being told what a bounded read needs.
    if (error instanceof UnreadableTraceQueryError) {
      return invalid(reply, error.message);
    }
    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }
    throw error;
  });
}

/**
 * Whether a project-scoped credential was asked for a different project.
 *
 * The data-access module ignores the argument in that case and reads the
 * credential's own project regardless, which is the property that matters. This
 * is the other half: saying so out loud, because a caller whose filter was
 * silently dropped would read the answer as though the filter had applied.
 */
function projectRefusal(
  credentialProjectId: string | undefined,
  asked: string | undefined,
): string | undefined {
  if (
    credentialProjectId === undefined ||
    asked === undefined ||
    asked === "" ||
    asked === credentialProjectId
  ) {
    return undefined;
  }
  return (
    `this credential is scoped to project ${credentialProjectId}, and the ` +
    `request asked for ${asked}. A key minted for one product area reads that ` +
    `one; drop the project_id, or use a key for the whole organization.`
  );
}
