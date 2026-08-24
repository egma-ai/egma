import {
  listTraces,
  MAXIMUM_LIST_LIMIT,
  NotPermittedError,
  readAssertionWords,
  readTrace,
  readVerdicts,
  UnreadableTraceQueryError,
  type AssertionWords,
  type AuthContext,
  type SpanSource,
  type TimeWindow,
  type TraceDetail,
  type TraceFacts,
  type TraceSpan,
  type TraceSummary,
} from "@egma/db";
import { measuresFromSpans, worstSampleOf } from "@egma/metrics";
import { traceReadOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import { simulationIdOfTrace } from "@egma/simulation-contract";

import { browserProject } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";
import {
  describedOutcome,
  describedVerdict,
  onlyReporting,
} from "../http/verdicts.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";

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
 * always queryable together; `projectId` narrows to one when a caller wants
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

type Query = {
  readonly from?: string;
  readonly to?: string;
  readonly projectId?: string;
  readonly source?: string;
  readonly pageSize?: string | number;
  readonly pageToken?: string;
};

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: "invalid_request", message });
}

function queryIntegerText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return given(typeof value === "string" ? value : undefined);
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
 * microseconds after it — paste a trace's own `endedAt` of `…776865Z` in as
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
          "Egma can read. An example of the shape: 2026-08-02T18:04:40.281989Z. " +
        "Fractional seconds are honoured to six digits, which is what the " +
        "store holds; a finer one is refused rather than rounded, because " +
        "rounding an exclusive bound moves the edge of your window.",
    };
  }

  return { from: opened, to: closed };
}

/**
 * The two kinds of traffic one store holds, and the only two words this
 * parameter takes.
 *
 * Written here rather than derived from a type, because it is what the refusal
 * below reads out to whoever got it wrong.
 */
const TRAFFIC_SOURCES: readonly SpanSource[] = ["simulation", "production"];

/**
 * Which kind of traffic to read — **optional, and absent means both.**
 *
 * That is the whole of what makes this addition safe on a surface that is
 * otherwise a one-way door: an integration written before the parameter existed
 * sends nothing, and gets byte for byte the answer it always got. Nothing is
 * defaulted here and nothing is echoed back, so there is no shape to change.
 *
 * A word that is not one of the two is **refused rather than ignored**. A
 * misspelled filter that quietly read everything would answer a different
 * question than the one asked and say nothing about having done so — the same
 * rule the window is held to — and on this parameter the difference is a page
 * of simulations under a heading that promised production. The refusal names
 * both accepted words, because a caller who got it wrong is a caller who does
 * not know what the right ones are.
 *
 * An **empty** parameter is a parameter nobody set, on the same terms as
 * `?projectId=` and `?pageSize=`: it is what a form submits for a field left
 * blank, and refusing it would refuse a request nobody meant anything by.
 */
type ParsedSource =
  | { readonly source: SpanSource | undefined }
  | { readonly refusal: string };

function sourceOf(query: Query): ParsedSource {
  const asked = given(query.source);
  if (asked === undefined) return { source: undefined };

  const known = TRAFFIC_SOURCES.find((one) => one === asked);
  if (known === undefined) {
    return {
      refusal:
        `source says which kind of traffic to read, and "${asked}" is not one ` +
        `of them. It is ${TRAFFIC_SOURCES.join(" or ")} — a conversation Egma ` +
        `conducted, or one your own agent had. Leave it out for both, which ` +
        `is what this list answers when nobody narrows it.`,
    };
  }
  return { source: known };
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

/** A trace, as the list describes one. */
function describedFacts(facts: TraceFacts): Record<string, unknown> {
  return {
    traceId: facts.traceId,
    startedAt: facts.startedAt,
    endedAt: facts.endedAt,
    // A decimal string, because a nanosecond count passes what a JSON number
    // holds exactly and a silently rounded latency is worse than no latency.
    durationNs: facts.durationNanoseconds,
    spanCount: facts.spanCount,
    turnCounts: { human: facts.humanTurnCount, agent: facts.agentTurnCount },
    toolSpanCount: facts.toolSpanCount,
    erroredSpanCount: facts.erroredSpanCount,
    source: facts.source,
    emitter: facts.emitter,
    environment: facts.environment,
    connectionType: facts.connectionType,
    providerCallId: facts.providerCallId,
    agentPlatform: facts.agentPlatform,
    platformAgentId: facts.platformAgentId,
    platformAgentName: facts.platformAgentName,
    platformAgentVersion: facts.platformAgentVersion,
    runId: facts.runId,
    agentId: facts.agentId,
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
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: span.startedAt,
    durationNs: span.durationNanoseconds,
    text: span.text,
    audioUrl: span.audioUrl,
    toolName: span.toolName,
    toolArguments: span.toolArguments,
    toolResult: span.toolResult,
    spans: span.spans.map(describedSpan),
  };
}

/**
 * What this conversation measured — **the metrics display's read path, and it
 * goes through the one shared measure module.**
 *
 * The numbers are not on the rows and are not stored anywhere: they are
 * computed here from the spans this answer already carries, by the same
 * function the latency grader computes with. So the figure on a page and the
 * figure a verdict was decided by are one arithmetic, and the two cannot come to
 * disagree — which is the whole reason the module exists rather than each
 * surface reading timing spans for itself.
 *
 * **`worst` is on the wire because the reduction is part of that arithmetic.**
 * A bound is held against one number, and which number that is — the worst
 * measurement, today; whichever of the catalog's eight aggregations a grader
 * asks for, tomorrow — is a decision the module makes. Sending only the series
 * would leave every reader to reduce it, and a browser reducing it would be a
 * second implementation of exactly the number a verdict rests on: correct while
 * both happen to take the maximum, and silently wrong the first day they do
 * not. So it is reduced once, here, by `worstSampleOf`.
 *
 * The series still rides along, because a reader wanting to plot the turns or
 * count them needs it and because the reduced number should be checkable
 * against what it was reduced from.
 *
 * **The same call for a simulation and for a real caller's trace.** Nothing here
 * looks at `source`; a trace whose agent emits no timing spans simply carries no
 * measures, which is a fact about the telemetry rather than a branch taken here.
 *
 * **`partial` says the reading is a prefix.** A trace over the store's span
 * limit comes back as its first spans, so a worst measurement taken over it is
 * the worst of the part egma holds and not of the call — the worst turn of a
 * long conversation is as likely to be past the cut as before it. The grading
 * engine refuses such a trace outright; a display is allowed to show what there
 * is, and is not allowed to show it as though it were the whole call. A measure
 * the platform reported is the exception and is never partial: it is one row's
 * account of the whole conversation rather than a series reduced over spans, so
 * the cap cannot have cut anything off it.
 *
 * The unit rides each measure because the catalog owns it — a client that named
 * one of its own would be a second opinion about something already written
 * down, and wrong the moment a measure is not a duration.
 */
function describedMeasures(
  detail: TraceDetail,
): readonly Record<string, unknown>[] {
  return measuresFromSpans(detail).map((measured) => {
    const worst = worstSampleOf(measured);
    return {
      measure: measured.measure,
      unit: measured.unit,
      // Where the number came from, so a page can say it and a client that
      // never asked is unaffected. **Added rather than changed**: every field a
      // consumer integrated against still means exactly what it did, and a
      // measure timed by egma's own vocabulary carries `false` here as it
      // always implicitly did.
      //
      // **The module now names three sources, and this field stays the boolean
      // it has always been: false means egma timed it, true means egma did
      // not.** That is all it has ever been able to say. Which of the two
      // untimed sources it was — a derivation off the framework's own spans, or
      // a number the platform handed egma — is `reportedBy` below, present
      // only on the second. A reader wanting the distinction asks that field;
      // no existing reader's meaning shifts under them.
      derived: measured.origin !== "timed",
      // **Only on a measure a platform reported, and absent everywhere else.**
      // Simulation traffic is byte-for-byte what it was before this field
      // existed, which is the criterion this branch exists to hold: a field
      // present-but-empty on every simulation would be a wire change on traffic
      // nothing new happened to. Present, it names the platform that measured.
      ...(measured.origin === "reported"
        ? { reportedBy: measured.reportedBy }
        : {}),
      samples: measured.samples.map((sample) => sample.value),
      spanIds: measured.samples.map((sample) => sample.spanId),
      // The one number a bound is held against, and where it happened. Null is
      // unreachable — a measure with no measurements is absent from this list
      // rather than present and empty — and it is sent rather than assumed
      // away, because the alternative is a client inventing a figure.
      worst:
        worst === undefined
          ? null
          : { value: worst.value, spanId: worst.spanId },
      // **A reported measure is never partial, however much of the trace was
      // dropped.** The flag says "this number was reduced over a prefix of the
      // conversation" — true of a series taken off spans when the read stopped
      // at the cap, and false of a block, which is one platform's account of
      // the whole conversation written on one row that either arrived or did
      // not. Stamping the truncation on it would tell a page the worst
      // measurement might be past the cut when there is no cut it could be past.
      partial: measured.origin === "reported" ? false : detail.truncated,
    };
  });
}

function describedDetail(detail: TraceDetail): Record<string, unknown> {
  return {
    trace: describedFacts(detail),
    turns: detail.turns.map(describedSpan),
    spans: detail.spans.map(describedSpan),
    spansTruncated: detail.truncated,
    measures: describedMeasures(detail),
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
   * **A parameter that arrived empty is a parameter nobody set.** `?projectId=`
   * is what a form submits for a field left blank, and reading it as a name
   * would answer with the traces of a project that cannot exist; `?limit=` is
   * the same case, and `Number("")` is zero, which would be refused as a page
   * size nobody could want. `?source=` joins them. All three read as absence,
   * which is what they mean.
   *
   * **`source` is the one filter this list has, and it is additive.** Absent, it
   * is not consulted and the answer is what it has always been; present, it
   * narrows to one kind of traffic. It rides every page of a walk, because a
   * token is a position in an ordering and the ordering it was minted in is the
   * narrowed one.
   */
  registerPlatformOperation(app, traceReadOperations.listTraces, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const window = windowOf(query);
    if ("refusal" in window) return invalid(reply, window.refusal);

    const projectId = given(query.projectId);
    const project = await readingProject(auth, projectId);
    if ("refusal" in project) return invalid(reply, project.refusal);

    const source = sourceOf(query);
    if ("refusal" in source) return invalid(reply, source.refusal);

    const asked = queryIntegerText(query.pageSize);
    const pageSize = asked === undefined ? undefined : Number(asked);
    if (pageSize !== undefined && (!Number.isFinite(pageSize) || pageSize < 1)) {
      return invalid(
        reply,
        `pageSize is how many traces one page may carry, at most ` +
          `${MAXIMUM_LIST_LIMIT}, and "${asked}" is not a count.`,
      );
    }

    const list = await listTraces(project.auth, {
      window,
      projectId,
      source: source.source,
      limit: pageSize,
      cursor: given(query.pageToken),
    });

    return reply.send({
      traces: list.traces.map(describedSummary),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      nextPageToken: list.nextCursor ?? null,
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
  registerPlatformOperation(app, traceReadOperations.getTrace, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;
    const { traceId } = request.params as { traceId: string };

    const window = windowOf(query);
    if ("refusal" in window) return invalid(reply, window.refusal);

    const projectId = given(query.projectId);
    const project = await readingProject(auth, projectId);
    if ("refusal" in project) return invalid(reply, project.refusal);

    // The context the whole page is read through, project included: the
    // transcript, the verdicts filed beside it, and the words behind their
    // assertion keys. One resolution rather than three, so the turns somebody
    // reads and the judgments printed under them can never come from two
    // different projects.
    const acting = project.auth;

    const detail = await readTrace(acting, traceId, { window, projectId });

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
    // mapping.
    //
    // **A production trace's verdicts are filed under the trace id itself**, and
    // asking `detail.source` is what keeps that true. The derivation is a pure
    // bit conversion and succeeds for *every* trace id, so a production trace
    // would otherwise be looked up under a simulation id nothing ever minted —
    // and the read would answer "skipped, nothing judged" while real verdict
    // rows sat in the store under the id it was handed. A judgment egma wrote
    // and then could not find is the exact false trust this product exists to
    // kill, so the question is asked rather than the answer assumed.
    const filedUnder =
      detail.source === "simulation"
        ? (simulationIdOfTrace(traceId) ?? traceId)
        : traceId;
    const judged = await readVerdicts(acting, filedUnder, { projectId }).catch(
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
            acting,
            filedUnder,
            (judged?.verdicts ?? []).map((its) => its.graderId),
          ).catch(() => undefined)
        : undefined;

    // Which of the copies that judged this conversation only report, off the
    // same per-grader fold the outcome above was split by — so a row's marking
    // and the header it sits under cannot disagree. This is the other half of
    // that promise: the fold already left the diagnostics out of `outcome`, and
    // without this the page would show their failures as if they had counted.
    const diagnostic = onlyReporting(judged?.byGrader);

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
      simulationId:
        detail.source === "simulation"
          ? simulationIdOfTrace(traceId) ?? null
          : null,
      // The one shape both surfaces that draw a judgment send, decided in
      // `http/verdicts.ts` rather than here and again there — including
      // `required`, without which a diagnostic's failure would render on this
      // page as an unmarked red card under a header folded without it.
      verdicts: (judged?.verdicts ?? []).map((its) =>
        describedVerdict(its, words, diagnostic),
      ),
      // The required lane, as everywhere: a diagnostic copy reports and never
      // decides.
      outcome: describedOutcome(judged?.outcome),
      // And the lane that only reports, beside it rather than inside it. Null
      // where nothing diagnostic judged this conversation.
      diagnostics: describedOutcome(judged?.diagnostics),
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
 * Which project these reads narrow to, once `projectId` has been answered.
 *
 * **A session's project is a default; a key's is a scope**, and that one
 * sentence is the whole of this function. Every member of an organization holds
 * their organization role on every project in it, so a browser naming a sibling
 * project is what the project selector does on every click — while a key minted
 * for one product area is bounded by it, and reaching a sibling with one is
 * refused rather than quietly narrowed back.
 *
 * The two rules are not written here. `acting.ts` owns them, and its own note
 * says why the branch lives there: *"so that every route group a page reaches
 * gets the one rule, and a group added later cannot get the other one by
 * omission."* This surface was that group. It carried a project check of its
 * own, written when a session's project was a fact nobody could change, and
 * that check read a session's default as though it were a key's scope — so an
 * organization with two projects had Monitoring answer 400 on every project but
 * the first.
 *
 * **The key half is unchanged, deliberately and to the byte.** It is a published
 * refusal on a public contract, and a key that reached a sibling project because
 * this function grew a branch would be the one failure worth more than the bug
 * being fixed. A key for the whole organization is unchanged too: it names no
 * project, so there is nothing here to refuse, and the data-access module
 * narrows by whatever it asked for.
 *
 * **Tenancy cannot widen either way.** The organization comes off the credential
 * and appears in every predicate underneath; the only project a session can come
 * to name is one its own membership already reaches, which is `browserProject`'s
 * read and not this request's claim.
 */
type ReadingProject =
  | { readonly auth: AuthContext }
  | { readonly refusal: string };

/**
 * **Every refusal here leaves as a 400 `invalid_request`, and the flattening of
 * `browserProject`'s own code is deliberate.**
 *
 * A project this session cannot reach is, in tenancy terms, an absence — which
 * argues for 404. It must not leave as one. The browser folds an answer into
 * what a page shows through `answerFor`, and there a 404 *is* the missing
 * state: on the transcript page it draws "That transcript is not here", so a
 * mistyped project id would tell somebody their conversation had aged out of
 * the store. The request is what was malformed, not the thing it asked for, and
 * 400 is the code that says so.
 *
 * Nothing is lost by it: the refusal's own sentence is carried word for word
 * and is what the page displays. What is lost is the ability to branch on the
 * code, and no caller does.
 *
 * **A new code added upstream has to be re-decided here.** `browserProject`
 * answering a second kind of refusal one day would have it flattened into this
 * one without anybody choosing that, so whoever adds it reads this paragraph
 * and either keeps the flattening or gives the route a second branch.
 */
async function readingProject(
  auth: AuthContext,
  asked: string | undefined,
): Promise<ReadingProject> {
  if (asked === undefined) return { auth };

  if (auth.via === "session") {
    const acting = await browserProject(auth, asked);
    return "auth" in acting ? acting : { refusal: acting.refusal };
  }

  const refusal = projectRefusal(auth.projectId, asked);
  return refusal === undefined ? { auth } : { refusal };
}

/**
 * Whether a project-scoped **key** was asked for a different project.
 *
 * The data-access module ignores the argument in that case and reads the
 * credential's own project regardless, which is the property that matters. This
 * is the other half: saying so out loud, because a caller whose filter was
 * silently dropped would read the answer as though the filter had applied.
 *
 * Reached only for a key now — see `readingProject` above — and its wording says
 * "key" because that is the only credential it can be about.
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
    `one; drop projectId, or use a key for the whole organization.`
  );
}
