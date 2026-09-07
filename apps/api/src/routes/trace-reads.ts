import {
  listTraces,
  MAXIMUM_LIST_LIMIT,
  NotPermittedError,
  readTrace,
  readTraceGrading,
  UnreadableTraceQueryError,
  type AuthContext,
  type SpanSource,
  type TimeWindow,
  type TraceDetail,
  type TraceFacts,
  type TraceSpan,
  type TraceSummary,
} from "@egma/db";
import { traceReadOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import { simulationIdOfTrace } from "@egma/simulation-contract";

import { browserProject } from "../http/acting.ts";
import { describedMetrics } from "../http/metrics.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { describedTraceGrading } from "../http/grades.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given } from "../http/reading.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";

/**
 * Trace list and transcript reads require a bounded time window and use page
 * tokens. The credential sets the organization; project selection follows
 * session access or API key scope.
 *
 * Keep these JSON routes outside the OTLP plugin, which replaces body parsers.
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
 * Parse timestamps to microseconds, preserving fractions that Date would
 * truncate. Reject more than six fractional digits instead of moving a bound.
 * Date handles the remaining timestamp syntax and calendar conversion.
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
 * An absent or empty source selects both production and simulation traces.
 * Reject unknown values so a misspelled filter cannot silently select both.
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

/** Format accepted window bounds at microsecond precision for reuse in queries. */
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
    pov: facts.pov,
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
  return {
    ...describedFacts(summary),
    preview: summary.preview,
    turnResponseLatencyP90Milliseconds:
      summary.turnResponseLatencyP90Milliseconds,
    turnResponseLatencyP90Partial: summary.turnResponseLatencyP90Partial,
  };
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
    // Whose POV this row is. Every production span is the agent's own;
    // the persona's POV exists only inside a simulation.
    pov: span.pov,
    // No mocked mark here. Whether a mock tool answered a call is read by
    // name from a simulation's pinned test version, and this read has no
    // simulation to ask: every call on a production conversation ran for
    // real. The simulation read is where the mark belongs.
    spans: span.spans.map(describedSpan),
  };
}

function describedDetail(detail: TraceDetail): Record<string, unknown> {
  return {
    trace: describedFacts(detail),
    turns: detail.turns.map(describedSpan),
    spans: detail.spans.map(describedSpan),
    spansTruncated: detail.truncated,
    metrics: describedMetrics(detail),
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
   * List newest traces within the requested window. Empty optional parameters
   * mean absence. The store caps page size and validates the window and page
   * token; each page request must retain the same filters.
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

    // One project-scoped context reads both the trace and its grades.
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
    if (detail.source !== "simulation" && detail.source !== "production") {
      throw new Error(
        `trace ${traceId} has unsupported source ${JSON.stringify(detail.source)}`,
      );
    }

    // The span row names the exact project. This matters for an organization-
    // scoped key: it can read several projects, while one trace's grades always
    // belong to one of them.
    const gradingAuth =
      acting.projectId === detail.projectId
        ? acting
        : { ...acting, projectId: detail.projectId };

    // Grades use the exact trace id for both sources. The run id is only part of
    // a simulation grade's immutable identity.
    const grading = await readTraceGrading(gradingAuth, {
      source: detail.source,
      traceId,
      ...(detail.source === "simulation" ? { runId: detail.runId } : {}),
    });

    return reply.send({
      ...describedDetail(detail),
      // Only simulation traces map to simulation IDs. A production trace ID can
      // convert to a UUID, but that does not mean a simulation or recording exists.
      simulationId:
        detail.source === "simulation"
          ? simulationIdOfTrace(traceId) ?? null
          : null,
      ...describedTraceGrading(grading),
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
 * Sessions may select another accessible project. Project API keys remain
 * limited to their assigned project; organization keys may apply a project filter.
 */
type ReadingProject =
  | { readonly auth: AuthContext }
  | { readonly refusal: string };

/**
 * Map project-selection refusals to 400 invalid_request. A 404 would make the
 * transcript page show a missing trace when the project parameter is wrong.
 * Reassess this mapping if browserProject gains other refusal types.
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

/** Reject a project filter outside the API key scope instead of silently ignoring it. */
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
