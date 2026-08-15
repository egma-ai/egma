import type {
  Modality,
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
 * simulator said about how it ended. The three conversation fields are
 * `unknown` because a production trace and a simulation are assembled into
 * them by the same code and nothing downstream may branch on which; each
 * grader reads what it needs and says honestly when what it needs is not
 * there.
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
  /** What was measured. A metric measures; a grader judges. */
  readonly metrics: unknown;
  /**
   * Which layer this conversation exercised — and `null` when nothing says.
   *
   * A simulation always knows: the run chose a connection, and the connection's
   * modality is stamped on the row. It decides whether a grader applies at all:
   * "recovered from a mishearing" is meaningless on chat, so a grader that
   * scores voice alone is **skipped** on a chat conversation rather than failed.
   *
   * A production trace does not know. Nothing on the wire says whether a real
   * caller spoke or typed, and guessing would be worse than the absence — so
   * `null` means "unstated" and every grader applies, which is the safe
   * direction: a check that runs and says something is recoverable, and a check
   * silently skipped on a guess is a hole nobody sees.
   */
  readonly modality: Modality | null;
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
    metrics: {},
    modality: simulation.modality,
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
      metrics: measuresTimedIn(trace),
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
    // Unstated, honestly: nothing in a production export says whether the
    // person on the other end spoke or typed.
    modality: null,
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
 * What a production trace measured, which today is nothing — and the reason is
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
 * What a simulation measured, from the timing spans — and there **is** a number
 * here, which is the whole difference from a production trace.
 *
 * These are the simulator's own measurements: egma stood on one side of the
 * conversation with a clock, and every measure it took is a span named for that
 * measure. Nothing is derived from the shape of the transcript here — the same
 * arithmetic that comes out negative on overlapping turns would come out
 * negative on a simulation's, and the simulator already knows the answer.
 *
 * **The span's own duration is the measurement.** A timing span is opened one
 * measurement before the moment it was taken and closed at it, so its start and
 * end bracket the interval that was measured. There is deliberately no
 * attribute carrying the number: a second copy of it would be free to disagree
 * with the interval, and the vocabulary refuses to write one down twice.
 *
 * Nanoseconds on the wire, milliseconds in the catalog, so the conversion
 * happens once and here. It is floating-point on purpose — a measure is
 * `862.5ms` and a whole-number division would quietly floor every one of them —
 * and the counts involved are tens of seconds, nowhere near where a double
 * stops holding a nanosecond exactly.
 *
 * **A measure the conversation never took is simply absent**, which is what
 * makes the voice measures free on chat: `time_to_first_word`,
 * `agent_speech_duration` and `persona_speech_duration` come out of audio, a
 * chat simulation has none, and a threshold grader asked for one answers
 * `skipped` — out of the score's denominator, never an error and never a
 * failure.
 */
function measuresTimedIn(trace: TraceDetail): Readonly<Record<string, number[]>> {
  const NANOSECONDS_PER_MILLISECOND = 1_000_000;

  const timed: (Measurement & { readonly at: string })[] = [];
  for (const span of everySpanIn(trace)) {
    if (span.kind !== TIMING) continue;
    timed.push({
      // The span is named for the measure it takes, which is what makes the
      // catalog and the vocabulary the same list read twice.
      measure: span.name,
      at: span.startedAt,
      milliseconds:
        Number(span.durationNanoseconds) / NANOSECONDS_PER_MILLISECOND,
    });
  }

  // In the order they were taken, so that a per-turn series is the conversation
  // read forwards and two gradings of one conversation aggregate the same list.
  const measured: Record<string, number[]> = {};
  for (const measurement of timed.sort(byWhenItStarted)) {
    (measured[measurement.measure] ??= []).push(measurement.milliseconds);
  }
  return measured;
}

type Measurement = {
  readonly measure: string;
  readonly milliseconds: number;
};

/**
 * The kinds this file selects on, as the door normalised them — never the
 * provider's own span names, which is what keeps one reading working for
 * LiveKit, for the simulator and for whatever the registry learns next.
 */
const ROOT = "root";
const TIMING = "timing";

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
