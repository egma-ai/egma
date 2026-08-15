import {
  measuresFromSpans,
  type MeasuredFromSpans,
  type Simulation,
  type TraceDetail,
  type TraceSpan,
  type VerdictSource,
} from "@egma/db";

/**
 * The conversation, as a grader reads it.
 *
 * **One shape for both sources**, which is the whole reason it exists as a type
 * rather than as "the simulation row". A grader judges a simulation and a
 * production trace with the same logic, and the difference between them is who
 * conducted the conversation rather than what a grader is looking at. Anything a
 * grader has to know about *where* it came from would be a second grading path
 * growing quietly inside the first.
 *
 * **One read path now, and it is the spans.** A conversation's record is the
 * spans it arrived as, whoever conducted it: a customer's agent posts them at
 * the OTLP door, and egma's own simulator posts them at the same door while it
 * is still talking. So a simulation and a production trace are assembled by the
 * same code out of the same rows, and "passes in simulation, fails in
 * production" is a join rather than two readers that could one day disagree
 * about what a turn is.
 *
 * A simulation's row is still read for what only it knows — that this
 * conversation was one egma conducted, which run it belongs to, what the
 * simulator said about how it ended. The transcript and the tool calls are
 * `unknown` because a production trace and a simulation are assembled into
 * them by the same code and nothing downstream may branch on which; each
 * grader reads what it needs and says honestly when what it needs is not
 * there. The measures are the exception and are typed, because they are not a
 * shape to be read — they are arithmetic, done in one place by the shared
 * measure module, and a second reading of them here is precisely the thing that
 * module exists to make impossible.
 */
export type Conversation = {
  /** Which kind of conversation this is, in the verdict row's own vocabulary. */
  readonly source: VerdictSource;
  /**
   * The conversation this judgment is filed under.
   *
   * A verdict's `trace_id` is the conversation, and for a simulation that is the
   * simulation's own id: it is what every other row about this conversation is
   * reachable from, and it is the same string in Postgres, in a URL and in a
   * log. For a production trace it is the trace's own id off the wire, which is
   * the same fact from the other direction — each source filed under the word
   * its own world already uses for the conversation. A simulation's spans sit
   * under a trace id derived from that id, and the derivation stays with the
   * query rather than moving up here.
   */
  readonly traceId: string;
  /**
   * **Why there is nothing here to judge**, and null when there is something.
   *
   * Two ways to arrive at it, and one consequence. A simulation the simulator
   * reported `failed` never produced a conversation: the agent never joined,
   * the line was never answered, egma's own runtime broke. A simulation that
   * certainly happened can still be one egma cannot read: its spans never
   * arrived, or only some of them did, and no column holds it either. Both are
   * `errored` for every grader, never `failed` — a broken test is never a
   * broken agent, and that line is the one normalisation a test product cannot
   * get wrong.
   *
   * It carries the sentence rather than a flag because the sentence is what
   * lands in the verdict's rationale, and the two cases are different things
   * for a reader to go and do. Written where the fact is known — one field, one
   * meaning, so nothing downstream has to assemble the reason a second time and
   * risk assembling a different one.
   */
  readonly nothingToJudgeBecause: string | null;
  /**
   * Why it ended, in the simulator's own vocabulary, for the rationale. Null for
   * a production conversation: nothing on the wire says why a real caller hung
   * up, and a guess dressed up as a reason would be worse than the absence.
   */
  readonly endingReason: string | null;
  readonly transcript: unknown;
  readonly events: unknown;
  /**
   * What was measured, from the conversation's own spans. A metric measures; a
   * grader judges.
   *
   * **Typed rather than `unknown`, and computed by the one shared measure
   * module rather than here.** The other two fields are shapes this file builds
   * out of spans and hands on for somebody to read defensively; a measure is not
   * — it is a number, computed in exactly one place, and the same number the
   * metrics display shows for this conversation. Reading it defensively here
   * would be a second reading of one arithmetic, and two readings of one
   * arithmetic is how a page and a verdict row come to disagree about how fast
   * an agent answered.
   *
   * **Assembled the same way whatever conducted the conversation.** The module
   * is handed spans and knows nothing about `source`, so a simulation and a
   * production trace holding the same spans produce the same measures — which is
   * what makes "passes in simulation, fails in production" a join rather than
   * two readers that could disagree about what a millisecond is.
   */
  readonly measures: readonly MeasuredFromSpans[];
  /** Where the verdict rows file the conversation, beside the conversation. */
  readonly runId: string;
  readonly agentId: string;
};

/**
 * A finished simulation, read as a conversation — and the whole of the reading
 * order, in one place.
 *
 * Two answers, asked in this order, and each of them is a different fact about
 * what egma actually holds:
 *
 * 1. **The trace is complete — assemble it from the spans.** The root span is
 *    what says so: it is authored first and sent last, in the flush that leaves
 *    once the conversation is over, so a trace holding it is a trace holding
 *    everything. That is the record, and it is read by exactly the code a
 *    production trace is read by. There is no second one: the row's three jsonb
 *    columns were the interim carrier and the migration that dropped them left
 *    this branch as the only reader of a conversation.
 * 2. **Anything else — say so, and judge nothing.** A simulation with spans
 *    and no root is one egma holds part of; one whose trace overran the
 *    reader's limit is one egma holds more of than a reading returns; one with
 *    no spans at all is one no telemetry ever arrived for. None of the three is
 *    something to judge an agent against, so every grader answers `errored`
 *    with the reason, because a check egma could not make is never a check the
 *    agent failed.
 *
 * **The verdict still files under the simulation id.** The spans live under a
 * trace id derived from it, and that derivation stays where the query is: the
 * product's word for this conversation is the simulation id, in Postgres, in a
 * URL and in a log, and nothing downstream of the grader changes because the
 * evidence moved.
 *
 * `agent_version_id` is deliberately absent from what this produces and lands
 * empty on the verdict row: egma does not version agents yet, and an empty
 * string is the honest way to say "there was no version to record" — filling it
 * with the agent's own id would make a comparison of two versions answer with
 * nonsense the day versions arrive.
 */
export function conversationOfSimulation(
  simulation: Simulation,
  trace: TraceDetail | undefined,
): Conversation {
  // Whether there was a conversation at all is the row's answer and only the
  // row's: a simulation the simulator reported failed produced none, and no
  // amount of telemetry arriving afterwards makes one. So it is decided before
  // anything is read, and every branch below carries it.
  const neverHappened =
    simulation.status === "completed" ? null : neverRan(simulation);

  const filedUnderTheSimulation: Conversation = {
    source: "simulation",
    traceId: simulation.id,
    nothingToJudgeBecause: neverHappened,
    endingReason: simulation.endingReason,
    transcript: [],
    events: [],
    measures: [],
    runId: simulation.runId,
    agentId: simulation.agentId,
  };

  if (trace !== undefined && rootArrivedIn(trace) && !trace.truncated) {
    return {
      ...filedUnderTheSimulation,
      transcript: transcriptOf(trace),
      // The same walk a production trace's tool calls come off, which is what
      // makes the two lists the same list. A simulation's results are always
      // empty and that is the emitter's fact rather than a rule applied here:
      // the simulator observes the call from egma's side of the connection and
      // not the return, so its vocabulary declares no result attribute and the
      // door has nothing to write into the column.
      events: toolCallsIn(trace),
      // The one shared measure module, called exactly as the production branch
      // below calls it and exactly as the metrics display calls it. There is no
      // reading of a timing span left in this file: the same spans produce the
      // same numbers whoever conducted the conversation, because there is only
      // one place the numbers are worked out.
      measures: measuresFromSpans(trace),
    };
  }

  return {
    ...filedUnderTheSimulation,
    nothingToJudgeBecause: neverHappened ?? unreadable(simulation, trace),
  };
}

/** A simulation that produced no conversation, in the simulator's own words. */
function neverRan(simulation: Simulation): string {
  return `this simulation ended ${simulation.endingReason ?? "without running"}, so there was no conversation to judge.`;
}

/**
 * A conversation that happened and that egma cannot read — and which of the
 * three ways it can happen, because they are different things to go and fix.
 *
 * Never `failed`, and this is where that is decided rather than in each grader:
 * an agent that answered every question perfectly would be marked down for a
 * flush that never landed, which is the exact false signal this product exists
 * to kill.
 */
function unreadable(
  simulation: Simulation,
  trace: TraceDetail | undefined,
): string {
  const ended = `it ended ${simulation.endingReason ?? "without a recorded reason"}`;
  if (trace === undefined) {
    return `egma holds no record of this conversation — ${ended}, and no telemetry for it ever arrived — so there was nothing to judge.`;
  }
  return trace.truncated
    ? `egma holds more of this conversation than one reading returns — ${ended}, and its trace overran the reader's span limit — so judging the readable part would judge a different conversation.`
    : `egma holds only part of this conversation — ${ended}, and the span that closes its trace never arrived — so there was nothing complete to judge.`;
}

/**
 * Whether the trace is the whole conversation, which the root span is the one
 * signal of.
 *
 * The simulator authors it first and sends it last, alone in the flush that
 * leaves once the conversation is over — so its arrival means every other span
 * is already stored, and its absence means the record is still open or the
 * simulator never got to the end of it. A count of turns could not answer this:
 * a conversation cut off after four turns and one recorded completely in four
 * turns hold the same rows.
 */
function rootArrivedIn(trace: TraceDetail): boolean {
  for (const span of everySpanIn(trace)) {
    if (span.kind === ROOT) return true;
  }
  return false;
}

/**
 * A production trace, read as a conversation — the settled production read path.
 *
 * There is no header row here and there never will be. A production trace is
 * whatever its agent's telemetry said, so the spans *are* the conversation, and
 * this assembles the three things a grader reads out of them.
 *
 * **It happened.** Spans exist, so somebody talked to something. The `errored`
 * normalisation on the other side answers a question only a simulation can be
 * asked — did egma's own runtime manage to conduct this — and a production call
 * was conducted by the world rather than by egma. A span marked `error` is a
 * step that went wrong *inside* a conversation that certainly happened, and
 * scoring that as "there was nothing to judge" would hide exactly the calls a
 * team most wants judged.
 *
 * **The run and the agent are empty, honestly.** A trace arriving at the OTLP
 * door was not started by egma: there is no run and no agent row behind it, and
 * the ingest path writes both columns empty rather than guessing. So a
 * production verdict carries no run id — which is what the verdicts table
 * already documents — and the fold reads it exactly as it reads a simulation's.
 */
export function conversationOfTrace(trace: TraceDetail): Conversation {
  return {
    source: "production",
    traceId: trace.traceId,
    nothingToJudgeBecause: null,
    endingReason: null,
    transcript: transcriptOf(trace),
    events: toolCallsIn(trace),
    // The same call the simulation branch makes, on the same rows, with nothing
    // between the two that could tell them apart — which is the whole of "one
    // source, both worlds". A trace whose agent emits no timing spans carries no
    // measures and a grader asked for one answers `skipped`; that is a fact
    // about the telemetry rather than a branch taken here.
    measures: measuresFromSpans(trace),
    runId: trace.runId,
    agentId: trace.agentId,
  };
}

/**
 * The transcript, from the turn-grain spans the store already lifts out for it.
 *
 * A turn is a span whose kind says somebody was speaking, and the trace read
 * hands them back in the order they happened with everything that happened
 * inside each one hanging beneath. So a transcript here is a projection rather
 * than a reconstruction: `turn:human` and `turn:agent` become the two labels the
 * transcript has always had, and the text is the span's own — LiveKit's
 * `lk.user_transcript` and `lk.response.text`, normalised into the `text` column
 * at the door.
 *
 * The keys are the simulation contract's turn event, minus the two fields only a
 * report needs, because a grader reading a transcript must not have to know
 * which source it came from. An agent turn with nothing said is kept rather than
 * dropped: the captured trace has several, and a turn that produced no words is
 * a fact about the conversation.
 */
function transcriptOf(trace: TraceDetail): readonly TranscriptTurn[] {
  return trace.turns.map((turn) => ({
    speaker: speakerOf(turn.kind),
    text: turn.text,
    started_at: turn.startedAt,
    ended_at: endOf(turn),
  }));
}

type TranscriptTurn = {
  readonly speaker: string;
  readonly text: string;
  /** RFC 3339 to the microsecond, exactly as the store holds it. */
  readonly started_at: string;
  readonly ended_at: string;
};

/**
 * Whose turn it was, from the kind the door normalised. The suffix as written
 * for anything else, because a framework that one day names a third speaker
 * should reach a grader as itself rather than as one of the two egma expected.
 */
function speakerOf(kind: string): string {
  const TURN = "turn:";
  return kind.startsWith(TURN) ? kind.slice(TURN.length) : kind;
}

/**
 * The tool calls, in the order they were made.
 *
 * Spans carry these properly — the door normalises LiveKit's
 * `lk.function_tool.*` attributes into three columns — so this is a walk of the
 * tree rather than a parse. A tool span sits inside the turn that caused it,
 * which is why the walk goes through the turns and the top-level spans alike:
 * every span the trace holds is under one of the two, exactly once.
 *
 * The shape is the simulation contract's tool call event, minus the event id
 * only a report needs and with the result added — a span records what came back
 * and a report event does not. Ordered by when the call started, so a grader
 * asking "was the refund tool called before the confirmation" reads the order
 * off the list.
 */
function toolCallsIn(trace: TraceDetail): readonly ToolCall[] {
  const called: (ToolCall & { readonly at: string })[] = [];

  for (const span of everySpanIn(trace)) {
    if (span.toolName === "") continue;
    called.push({
      kind: "tool_call",
      at: span.startedAt,
      name: span.toolName,
      arguments: span.toolArguments,
      result: span.toolResult,
    });
  }

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

/**
 * The one kind this file still selects on, as the door normalised it — never the
 * provider's own span names, which is what keeps one reading working for
 * LiveKit, for the simulator and for whatever the registry learns next.
 *
 * The timing kind used to be here beside it, read into a second copy of the
 * measure arithmetic. It moved into the shared measure module with everything
 * else about a measure, so this file no longer has an opinion about what a
 * millisecond is.
 */
const ROOT = "root";

/**
 * Every span the trace holds, exactly once: the turns, whatever hangs inside
 * them, and everything filed beside them.
 *
 * A trace read hands back two lists — the turns lifted out for the transcript,
 * and the top-level spans with their children beneath — and every span is under
 * one of the two, once. Which of them a thing lands in depends on what its
 * parent was: the simulator hangs its tool calls and its measurements off the
 * root, so they arrive inside it, and a trace whose root never came holds those
 * same spans at the top. Walking both lists is what makes the reading the same
 * either way.
 */
function* everySpanIn(trace: TraceDetail): Generator<TraceSpan> {
  const walk = function* (spans: readonly TraceSpan[]): Generator<TraceSpan> {
    for (const span of spans) {
      yield span;
      yield* walk(span.spans);
    }
  };
  yield* walk(trace.turns);
  yield* walk(trace.spans);
}

/**
 * By when it began, as the store wrote the instant — fixed-width RFC 3339 to
 * the microsecond, so the strings sort exactly as the moments do and no `Date`
 * is built to round the last three digits off.
 */
function byWhenItStarted(
  left: { readonly at: string },
  right: { readonly at: string },
): number {
  return left.at < right.at ? -1 : left.at > right.at ? 1 : 0;
}

/**
 * When a turn ended: where it started, plus how long it ran.
 *
 * Both numbers are the store's own — an RFC 3339 instant to the microsecond and
 * a duration in whole nanoseconds — so the arithmetic is done in microseconds
 * and never in a `Date`, which holds milliseconds and would quietly round three
 * digits off every turn in the transcript.
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
  // `YYYY-MM-DDTHH:MM:SS.ffffffZ`, which is the one format the store's reads
  // produce — seconds parsed by the platform, and the six digits under them read
  // as digits, because that is the precision a `Date` cannot carry.
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
