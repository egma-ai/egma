import type {
  Simulation,
  TraceDetail,
  TraceSpan,
  VerdictSource,
} from "@egma/db";

/**
 * The conversation, as a grader reads it.
 *
 * **One shape for both sources**, which is the whole reason it exists as a type
 * rather than as "the simulation row". A grader judges a simulation and a
 * production trace with the same logic, and the difference between them is where
 * this was read from — the simulation's header row, or the trace's spans —
 * rather than what a grader is looking at. Anything a grader has to know about
 * *where* it came from would be a second grading path growing quietly inside the
 * first.
 *
 * Two read paths, both settled. A finished simulation already carries its
 * transcript, its events and its measures on its own row, so grading it needs no
 * second store and no join. A production trace has no row of its own and never
 * will: its whole record is the spans it arrived as, so it is read from the
 * trace store and assembled below. The three fields are `unknown` because they
 * are stored jsonb and nothing has fixed their shape at the write door — each
 * grader reads what it needs and says honestly when what it needs is not there.
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
   * the same fact from the other direction — and when simulator reports converge
   * on the OTLP door the two stop differing at all.
   */
  readonly traceId: string;
  /**
   * **Whether there is a conversation here at all.**
   *
   * A simulation the simulator reported `failed` never produced one: the agent
   * never joined, the line was never answered, egma's own runtime broke. Every
   * grader's verdict on it is `errored`, never `failed`, and this is the flag
   * that says so — a broken test is never a broken agent, and that line is the
   * one normalisation a test product cannot get wrong.
   */
  readonly happened: boolean;
  /**
   * Why it ended, in the simulator's own vocabulary, for the rationale. Null for
   * a production conversation: nothing on the wire says why a real caller hung
   * up, and a guess dressed up as a reason would be worse than the absence.
   */
  readonly endingReason: string | null;
  readonly transcript: unknown;
  readonly events: unknown;
  /** What was measured. A metric measures; a grader judges. */
  readonly metrics: unknown;
  /** Where the verdict rows file the conversation, beside the conversation. */
  readonly runId: string;
  readonly agentId: string;
};

/**
 * A finished simulation, read as a conversation.
 *
 * `agent_version_id` is deliberately absent from what this produces and lands
 * empty on the verdict row: egma does not version agents yet, and an empty
 * string is the honest way to say "there was no version to record" — filling it
 * with the agent's own id would make a comparison of two versions answer with
 * nonsense the day versions arrive.
 */
export function conversationOf(simulation: Simulation): Conversation {
  return {
    source: "simulation",
    traceId: simulation.id,
    happened: simulation.status === "completed",
    endingReason: simulation.endingReason,
    transcript: simulation.transcript,
    events: simulation.events,
    metrics: simulation.metrics,
    runId: simulation.runId,
    agentId: simulation.agentId,
  };
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
    happened: true,
    endingReason: null,
    transcript: transcriptOf(trace),
    events: toolCallsIn(trace),
    metrics: measuresIn(),
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

  const walk = (spans: readonly TraceSpan[]): void => {
    for (const span of spans) {
      if (span.toolName !== "") {
        called.push({
          kind: "tool_call",
          at: span.startedAt,
          name: span.toolName,
          arguments: span.toolArguments,
          result: span.toolResult,
        });
      }
      walk(span.spans);
    }
  };

  walk(trace.turns);
  walk(trace.spans);

  return called.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
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
 * What this conversation measured, which today is nothing — and the reason is
 * worth writing down rather than discovering twice.
 *
 * The measures a threshold grader names are the simulator's: egma stands on one
 * side of the conversation with a clock and reports what it timed. A production
 * trace is the agent's own telemetry from the inside, and the two views are
 * different measurements — the trace store's own schema says so, and averaging
 * them together is the same error as mixing two audio bands.
 *
 * Deriving one anyway was tried and is wrong. The obvious candidate is the gap
 * between a human's turn ending and the agent's beginning; in the captured
 * LiveKit trace five of the twelve neighbouring pairs of turns *overlap* — a
 * user turn stays open past the point the agent starts answering — so the
 * "latency" comes out negative by as much as two and a half seconds. A number
 * that is wrong is worse than a measure that is missing, and a grader asked for
 * a measure this does not have answers `skipped`, which leaves the score's
 * denominator exactly as an inapplicable check should.
 *
 * What is actually needed is on the row already: LiveKit puts its own
 * end-to-end turn latency on `lk.e2e_latency`, inside the verbatim payload that
 * the trace read deliberately does not return. Reading it is a decision for the
 * ingest door — a column, or a kind, normalised once for every provider — and
 * not one this path may take alone, because a grader that parsed provider
 * attributes would be a second normaliser, disagreeing with the first for every
 * framework egma ever supports.
 */
function measuresIn(): Readonly<Record<string, never>> {
  return {};
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
