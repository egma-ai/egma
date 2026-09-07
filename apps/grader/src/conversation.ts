import {
  fromOnePov,
  laneProducesAnAgentPov,
  type Simulation,
  type TraceDetail,
  type TraceSpan,
} from "@egma/db";
import {
  everySpanIn,
  measuresFromSpans,
  type MeasuredFromSpans,
} from "@egma/metrics";
import { traceIdOfSimulation } from "@egma/simulation-contract";

/**
 * Shared grading input for simulations and production traces. Transcript and
 * tool calls come from spans; metrics come from @egma/metrics. Simulation rows
 * supply run context and the execution ending. Each grader validates the
 * untyped evidence it requires.
 */
export type Conversation = {
  /** Which kind of conversation this is, in the grade row's vocabulary. */
  readonly source: "simulation" | "production";
  /** OpenTelemetry trace ID joining the grade to its spans, never a simulation ID. */
  readonly traceId: string;
  /**
   * Reason grading cannot proceed, or null. Graders record missing or unreadable
   * evidence as a grading error, not a failed judgment.
   */
  readonly nothingToJudgeBecause: string | null;
  /** Simulation ending reason, or null for production traces. */
  readonly endingReason: string | null;
  readonly transcript: unknown;
  readonly events: unknown;
  /** Metrics computed by @egma/metrics from the same spans used by the product UI. */
  readonly measures: readonly MeasuredFromSpans[];
  /** Correlation facts carried by the trace. */
  readonly runId: string;
  readonly agentId: string;
};

/**
 * Shape simulation evidence after lifecycle completion and ingestion. Missing
 * or truncated evidence produces a grading error. Grades use the
 * OpenTelemetry trace ID, as production grades do.
 */
export function conversationOfSimulation(
  simulation: Simulation,
  trace: TraceDetail | undefined,
  connectionType: string,
): Conversation {
  // Use the persistent simulation status to decide grading eligibility.
  const neverHappened =
    simulation.status === "completed" ? null : neverRan(simulation);

  const traceId = trace?.traceId ?? traceIdOfSimulation(simulation.id);
  if (traceId === undefined) {
    throw new Error(`simulation ${simulation.id} has no valid trace identity`);
  }

  const filedUnderTheSimulation: Conversation = {
    source: "simulation",
    traceId,
    nothingToJudgeBecause: neverHappened,
    endingReason: simulation.endingReason,
    transcript: [],
    events: [],
    measures: [],
    runId: simulation.runId,
    agentId: simulation.agentId,
  };

  if (trace !== undefined && !trace.truncated) {
    const requiresAgentPov = laneProducesAnAgentPov(connectionType);
    const agentEvidenceMissing = requiresAgentPov &&
      trace.agentEvidenceComplete !== true;
    return {
      ...filedUnderTheSimulation,
      nothingToJudgeBecause: neverHappened ?? (
        agentEvidenceMissing || (requiresAgentPov && trace.agentEvidenceIncomplete === true)
          ? "The platform transcript is unavailable or incomplete. Egma's recording cannot replace it for grading."
          : null
      ),
      transcript: transcriptOf(trace, requiresAgentPov),
      events: toolCallsIn(trace, requiresAgentPov),
      measures: measuresFromSpans(trace),
    };
  }

  return {
    ...filedUnderTheSimulation,
    nothingToJudgeBecause: neverHappened ?? unreadable(simulation, trace),
  };
}

/**
 * Whether the final root span is query-visible. Used only for retries after
 * lifecycle completion, not to decide completion.
 */
function rootArrivedIn(trace: TraceDetail): boolean {
  for (const span of everySpanIn(trace)) {
    if (span.kind === "root") return true;
  }
  return false;
}

/**
 * Retry a completed simulation while its trace or final root span is absent.
 * Do not retry incomplete simulations or reads truncated by the span limit.
 * This is a visibility retry signal, not a lifecycle-completion decision.
 */
export function evidenceIsStillArriving(
  simulation: Simulation,
  trace: TraceDetail | undefined,
  connectionType: string,
): boolean {
  if (simulation.status !== "completed") return false;
  if (trace === undefined) return true;
  if (laneProducesAnAgentPov(connectionType)) {
    return !trace.truncated && trace.agentEvidenceIncomplete !== true &&
      trace.agentEvidenceComplete !== true;
  }
  return !trace.truncated && !rootArrivedIn(trace);
}

/** A simulation that produced no conversation, in the simulator's own words. */
function neverRan(simulation: Simulation): string {
  return `this simulation ended ${simulation.endingReason ?? "without completing"}, so its execution cannot be graded.`;
}

/** Explain missing or truncated evidence as a grading error. */
function unreadable(
  simulation: Simulation,
  trace: TraceDetail | undefined,
): string {
  const ended = `it ended ${simulation.endingReason ?? "without a recorded reason"}`;
  if (trace === undefined) {
    return `Egma holds no record of this conversation — ${ended}, and no telemetry for it ever arrived — so there was nothing to grade.`;
  }
  return trace.truncated
    ? `${MORE_THAN_ONE_READING} — ${ended}, and ${OVERRAN}`
    : `Egma holds only part of this conversation — ${ended}, and the span that closes its trace never arrived — so there was no complete conversation to grade.`;
}

/**
 * Shared refusal for reads truncated by the span limit. Grading a prefix
 * would omit evidence and could change the grade.
 */
const MORE_THAN_ONE_READING =
  "Egma holds more of this conversation than one reading returns";

const OVERRAN =
  "its trace overran the reader's span limit — so grading the readable part " +
  "would grade a different conversation.";

/**
 * Shape production evidence from spans, retaining the trace's correlation IDs.
 * An error span remains gradable evidence; a read truncated by the span limit
 * produces a grading error.
 */
export function conversationOfTrace(trace: TraceDetail): Conversation {
  const filedUnderTheTrace: Conversation = {
    source: "production",
    traceId: trace.traceId,
    nothingToJudgeBecause: null,
    endingReason: null,
    transcript: [],
    events: [],
    measures: [],
    runId: trace.runId,
    agentId: trace.agentId,
  };

  if (trace.truncated) {
    return {
      ...filedUnderTheTrace,
      nothingToJudgeBecause: `${MORE_THAN_ONE_READING} — ${OVERRAN}`,
    };
  }

  return {
    ...filedUnderTheTrace,
    transcript: transcriptOf(trace),
    events: toolCallsIn(trace),
    // Use timed, derived, or reported metrics from the shared measure module.
    measures: measuresFromSpans(trace),
  };
}

/**
 * Project ordered turn spans into transcript entries with evidence span IDs.
 * Use the normalized text column and retain empty agent turns.
 */
function transcriptOf(trace: TraceDetail, requiresAgentPov = false): readonly TranscriptTurn[] {
  const turns = requiresAgentPov
    ? trace.turns.filter((turn) => turn.pov === "agent")
    : fromOnePov(trace.turns, "agent");
  return turns.map((turn) => ({
    span_id: turn.spanId,
    speaker: speakerOf(turn.kind),
    text: turn.text,
    started_at: turn.startedAt,
    ended_at: endOf(turn),
  }));
}

type TranscriptTurn = {
  /** The real evidence span this turn came from. */
  readonly span_id: string;
  readonly speaker: string;
  readonly text: string;
  /** RFC 3339 to the microsecond, exactly as the store holds it. */
  readonly started_at: string;
  readonly ended_at: string;
};

/** Map normalized turn kinds to transcript speakers; retain unknown suffixes. */
function speakerOf(kind: string): string {
  const TURN = "turn:";
  return kind.startsWith(TURN) ? kind.slice(TURN.length) : kind;
}

/**
 * Project nested and top-level tool spans into tool calls with arguments and
 * results. Sort by start time so graders can judge their order.
 */
function toolCallsIn(trace: TraceDetail, requiresAgentPov = false): readonly ToolCall[] {
  // Platform simulations must not turn a mock server observation into a
  // platform tool call, including when the platform reported no tools.
  const tools = [...everySpanIn(trace)].filter((span) => span.toolName !== "");
  const selected = requiresAgentPov
    ? tools.filter((span) => span.pov === "agent")
    : fromOnePov(tools, "agent");
  const called = selected.map(
    (span): ToolCall & { readonly at: string } => ({
      kind: "tool_call",
      at: span.startedAt,
      name: span.toolName,
      arguments: span.toolArguments,
      result: span.toolResult,
    }),
  );

  return called.sort(byWhenItStarted);
}

type ToolCall = {
  readonly kind: "tool_call";
  readonly at: string;
  readonly name: string;
  /** JSON as the provider wrote it, kept verbatim rather than parsed. */
  readonly arguments: string;
  readonly result: string;
};

/** Fixed-width RFC 3339 strings preserve microsecond ordering without Date rounding. */
function byWhenItStarted(
  left: { readonly at: string },
  right: { readonly at: string },
): number {
  return left.at < right.at ? -1 : left.at > right.at ? 1 : 0;
}

/**
 * Add nanosecond duration to the start time in microseconds. Date arithmetic
 * would discard the stored sub-millisecond precision.
 */
function endOf(turn: TraceSpan): string {
  const NANOSECONDS_PER_MICROSECOND = 1_000n;
  return rfc3339(
    microsecondsOf(turn.startedAt) +
      BigInt(turn.durationNanoseconds) / NANOSECONDS_PER_MICROSECOND,
  );
}

const MICROSECONDS_PER_SECOND = 1_000_000n;

/** An instant the trace store wrote, back as the microseconds it holds. */
function microsecondsOf(instant: string): bigint {
  // Parse whole seconds separately from the six fractional digits to retain
  // microsecond precision.
  const [seconds = "", fraction = ""] = instant.replace("Z", "").split(".");
  return (
    BigInt(Date.parse(`${seconds}Z`)) * 1_000n +
    BigInt(fraction.padEnd(6, "0").slice(0, 6))
  );
}

/** And back again, in the same format, so both ends of a turn read alike. */
function rfc3339(microseconds: bigint): string {
  const seconds = microseconds / MICROSECONDS_PER_SECOND;
  const fraction = microseconds % MICROSECONDS_PER_SECOND;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole}.${fraction.toString().padStart(6, "0")}Z`;
}
