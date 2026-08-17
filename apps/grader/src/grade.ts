import {
  appendVerdicts,
  getGrader,
  getGraderLibraryEntry,
  getSimulation,
  readTrace,
  MAXIMUM_WINDOW_MILLISECONDS,
  type AuthContext,
  type Grader,
  type GradingClaim,
  type GradingSource,
  type LibraryEntry,
  type NewVerdict,
  type Simulation,
  type TimeWindow,
  type TraceDetail,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";

import {
  conversationOfSimulation,
  conversationOfTrace,
  type Conversation,
} from "./conversation.ts";
import {
  couldNotJudge,
  execute,
  type Judging,
  type Judgment,
  type Reading,
} from "./graders/index.ts";
import { JUDGE_MAKERS, judgesOnce, type JudgeMakers } from "./judge/index.ts";
import { applicableGraders, applicableProductionGraders } from "./resolve.ts";

/**
 * One claimed job, judged end to end: read the conversation, resolve the graders
 * that apply to it, execute each, write the verdict rows.
 *
 * Four steps and no fifth. Nothing here decides an overall answer for the
 * conversation or for its run — there is no such row anywhere, by design, and
 * the fold works one out at read time from exactly the rows this wrote.
 *
 * **The source decides the first two steps and nothing after them.** Both are
 * read from their spans; what differs is what egma knows besides. A simulation
 * names its own row, which says whose conversation it was and how the simulator
 * said it ended, and it is judged by the project's copies scoped to simulations;
 * a production trace has no row and is judged by the project's production-scoped
 * copies, sampled. Neither resolution reads a test: which graders apply is the
 * copies' own scope and nothing else. From the moment a `Conversation` and a
 * grader list exist there is one path — one executor seam, one verdict row
 * builder, one write — because a second judging path would be a second set of
 * answers that could one day disagree about the same agent.
 *
 * **The verdicts are written in one call.** A conversation's judgments land
 * together or not at all as far as any reader is concerned, and a job that fails
 * before the write is released and judged again from the beginning — which is
 * safe precisely because writing the same judgment twice at the same grader
 * version replaces rather than doubles.
 *
 * **Every grader is a resolved copy, including the expected-behaviors one.** It
 * used to stand beside the list as a second branch of the fan-out, because it
 * was never a row and could not be resolved. Every project is seeded with an
 * active copy of it now, so there is one fan-out, one executor seam and one
 * verdict row builder — and the rows it writes name a real grader and a real
 * version instead of a sentinel string. It stays simulations-only by its scope
 * rather than by a branch here, which is the same fact said where a person can
 * change it.
 *
 * **The definition is read through the copy's pointer, once per entry.** A
 * grader's judge prompt lives on its library entry and is never written down
 * onto the copy, so judging reads it here and hands it to the executor. Two
 * copies of one entry cost one read, because the answer is remembered for the
 * length of this conversation and no longer.
 *
 * **A claim reopened for one grader judges that grader and nothing else.**
 * Somebody who fixed one grader asked for one grader's judgment, and every other
 * judge call on the conversation would be money they did not agree to spend —
 * which is the whole reason the narrowing exists rather than a nicety of it.
 */

/** What judging one conversation came to. */
export type Graded = {
  readonly source: GradingSource;
  /** The conversation, as the verdict rows file it. */
  readonly traceId: string;
  /** How many graders applied — including the ones that could not score. */
  readonly graders: number;
  readonly verdicts: number;
};

/** Why a job could not be judged, when it could not be. */
export class NotGradable extends Error {}

export type GradeOptions = {
  /**
   * How each judge provider is spoken to. The default speaks to the real ones;
   * a test hands over a scripted judge, which is what lets the whole engine
   * suite run with no key and no network.
   */
  readonly makers?: JudgeMakers | undefined;
};

/** A conversation and the graders that judge it: what a source resolves to. */
type Resolved = {
  readonly conversation: Conversation;
  readonly graders: readonly Grader[];
  /**
   * The simulation the conversation came from, when it came from one — what a
   * grader whose assertions live on the test goes and reads. A production trace
   * resolves to none, which is the same fact as "there is no test here".
   */
  readonly simulationId: string | undefined;
};

/**
 * The graders this claim judges with: the one it was reopened for, or everything
 * that applies to the conversation.
 *
 * **A narrowed claim never asks what applies**, which is why the ordinary
 * resolution is passed as something to call rather than as a list. Resolving a
 * production trace's graders advances each one's sampling accumulator, and a
 * deliberate re-grade must not spend other graders' turns to answer a question
 * about one of them.
 *
 * **The named grader judges whatever its scope says**: naming it *is* the
 * scoping decision, made once by the person who asked for this re-grade rather
 * than standing policy about where the grader usually applies. Sampling is not
 * asked either — a re-grade somebody typed is not traffic egma did not cause.
 *
 * A grader that has gone between the ask and the claim — deleted in the minutes
 * the job sat in the queue — judges nothing, and the job finishes having written
 * nothing. That is the honest answer in both directions: it must not widen back
 * to every grader, which would spend exactly what the narrowing was asked to
 * save.
 */
async function judgingGraders(
  claim: GradingClaim,
  whatApplies: () => Promise<readonly Grader[]>,
): Promise<readonly Grader[]> {
  const { regradeGraderId } = claim;
  if (regradeGraderId === null) return whatApplies();

  const named = await getGrader(claim.auth, regradeGraderId);
  return named === undefined ? [] : [named];
}

export async function gradeClaim(
  claim: GradingClaim,
  options: GradeOptions = {},
): Promise<Graded> {
  const { conversation, graders, simulationId } =
    claim.source === "production"
      ? await theProductionTrace(claim)
      : await theSimulation(claim);

  const makers = options.makers ?? JUDGE_MAKERS;

  // The judges this conversation may be judged by, each source resolved only
  // if something asks for it. Nothing here decides whether one is needed — the
  // things that judge ask, and a conversation where none of them does never
  // opens an envelope at all. Which source answers is the grader's own fact:
  // a version that selected its model spends the organization's credential for
  // that provider, and one that did not is judged by the project's setting
  // exactly as it always was.
  const judges = judgesOnce(claim.auth);

  // The definitions, read through the copies' pointers and remembered for the
  // length of this conversation. Two copies of one entry cost one read; nothing
  // is remembered past this call, because a definition is read *at judging
  // time* and a cache that outlived the job would be the copied definition this
  // whole shape exists to rule out.
  const definitionOf = definitionsOnce(claim.auth);

  // What every grader that judges is handed besides the conversation: the
  // simulation to read a test off, and whose it is.
  const reading: Reading = { auth: claim.auth, simulationId };

  // In parallel, and not because today's computed graders are slow — they are
  // instant. Because a judged grader is one model call per assertion, and
  // wall-clock for a conversation with five checks should be one call rather
  // than five.
  const rows = (
    await Promise.all(
      graders.map(async (grader) =>
        (
          await judgmentsOf(grader, await definitionOf(grader), {
            conversation,
            judging: {
              judges,
              makers,
              // The two model fields this version froze, handed on together
              // because which of them answers is the resolution's decision and
              // not this file's. Both are judged content, frozen beside the
              // config, so a verdict decided by either stays readable as
              // "decided by this model" long after anything else moved on.
              grader: {
                graderModel: grader.graderModel,
                judgeModel: grader.judgeModel,
              },
            },
            reading,
          })
        ).map((judgment) => verdictRow(grader, conversation, judgment)),
      ),
    )
  ).flat();

  await appendVerdicts(claim.auth, rows);

  return {
    source: conversation.source,
    traceId: conversation.traceId,
    graders: graders.length,
    verdicts: rows.length,
  };
}

/**
 * The library entry behind a running copy, read at most once per entry for this
 * conversation.
 *
 * **Read through `library_id` rather than off the copy**, every time a
 * conversation is judged. That is the whole of the two-level shape: the judge
 * prompt lives in one place, the Library screen reads that place, and a release
 * that improves the words improves what a judge is actually sent. A definition
 * written down onto the copy would be a second string that drifts, silently, in
 * the direction of the screen being wrong about how conversations are judged.
 *
 * The promise is remembered rather than its answer, so two copies of one entry
 * racing each other in a `Promise.all` share one read instead of starting two.
 * An entry that comes back absent cannot happen — the pointer is a foreign key
 * — and is answered rather than asserted, because a grading service is not the
 * place to throw over a row that came out of its own database.
 */
function definitionsOnce(
  auth: AuthContext,
): (grader: Grader) => Promise<LibraryEntry | undefined> {
  const reading = new Map<string, Promise<LibraryEntry | undefined>>();
  return (grader) => {
    const held = reading.get(grader.libraryId);
    if (held !== undefined) return held;

    const started = getGraderLibraryEntry(auth, grader.libraryId);
    reading.set(grader.libraryId, started);
    return started;
  };
}

/**
 * A finished simulation: its own row for what egma knows about conducting it,
 * and its spans for the conversation.
 *
 * The row is read first because it is what says this simulation exists, whose
 * it is and when it ran — and the window comes off those two moments, because
 * the trace store is filed by the minute a span started in and a read naming
 * only an id would have nothing to prune with.
 *
 * A trace that comes back absent is not an error here, and that is the
 * difference from the production path: a production job was written *by* the
 * spans arriving, so their absence means telemetry has gone, while a
 * simulation's job is written by the transaction that landed it and can
 * legitimately reach a conversation whose spans never came. What to do about it
 * is the reading order's decision, made in one place; this only goes and asks.
 */
async function theSimulation(claim: GradingClaim): Promise<Resolved> {
  if (claim.simulationId === null) {
    throw new NotGradable(
      `grading job ${claim.id} says it is a simulation's and names none`,
    );
  }

  const simulation = await getSimulation(claim.auth, claim.simulationId);
  if (simulation === undefined) {
    throw new NotGradable(
      `simulation ${claim.simulationId} is not reachable from the job that names it`,
    );
  }

  return {
    conversation: conversationOfSimulation(
      simulation,
      await theSimulationsTrace(claim.auth, simulation),
    ),
    graders: await judgingGraders(claim, () => applicableGraders(claim.auth)),
    simulationId: simulation.id,
  };
}

/**
 * The spans this simulation streamed, or nothing at all if none did.
 *
 * **The trace id is derived, never stored.** A simulation's spans are filed
 * under the 128 bits its own id carries, because an OpenTelemetry trace id is
 * fixed-width binary and cannot hold one of egma's identifiers. The derivation
 * is a term of the span contract and lives there, in one place, so that the
 * simulator authoring a span and this query going to find it can never fall out
 * of step. The verdict rows still file under the simulation id: the product's
 * word for this conversation is unchanged, and only the query knows the other
 * form.
 */
async function theSimulationsTrace(
  auth: AuthContext,
  simulation: Simulation,
): Promise<TraceDetail | undefined> {
  const traceId = traceIdOfSimulation(simulation.id);
  // Unreachable: every simulation id egma reads is one egma minted. Answered
  // rather than asserted, because a grading service is not the place to throw
  // over an id that came out of its own database.
  if (traceId === undefined) return undefined;

  return readTrace(auth, traceId, { window: whenItRan(simulation) });
}

/**
 * How wide a window a simulation's spans are looked for in.
 *
 * Five minutes at each end, which is not rounding slack. The row's two moments
 * are the *simulator's* own, reported over the wire and written onto the row
 * where they could be true — so the two clocks are different machines' — and
 * where a report carried neither, the landing stamped its own arrival instead,
 * which is later than the conversation by however long delivery took. A span
 * that fell outside the window would be a hole in a transcript nobody could
 * see, and the sort key prunes by the minute, so a generous cushion costs
 * almost nothing to read.
 */
const A_GENEROUS_CUSHION_MICROSECONDS = 5n * 60n * 1_000_000n;

function whenItRan(simulation: Simulation): TimeWindow {
  // A row that never started is bracketed by its own creation, which is
  // certainly before anything the simulator stamped; one that never landed by
  // now, which is certainly after.
  const began = BigInt((simulation.startedAt ?? simulation.createdAt).getTime());
  const ended = BigInt((simulation.endedAt ?? new Date()).getTime());

  const from =
    (began < ended ? began : ended) * 1_000n - A_GENEROUS_CUSHION_MICROSECONDS;
  const to =
    (began < ended ? ended : began) * 1_000n + A_GENEROUS_CUSHION_MICROSECONDS;

  // The store refuses a window wider than its cap rather than narrowing one, so
  // a row that sat queued for longer than that is narrowed here — from the end,
  // which is where the conversation was.
  const widest = BigInt(MAXIMUM_WINDOW_MILLISECONDS) * 1_000n;
  return { from: to - from > widest ? to - widest : from, to };
}

/**
 * A production trace, read from its spans — the settled production read path.
 *
 * The window comes off the job the ingest door wrote, because the trace store is
 * filed by the minute a span started in and a read naming only a trace id would
 * have nothing to prune with. It is widened by a second at each end: those two
 * instants travel as timestamps, which hold milliseconds, while the store holds
 * microseconds — so a bound copied across exactly could land a few hundred
 * microseconds inside the conversation and clip the first or last span off the
 * transcript. A second is far more than that rounding and far less than the gap
 * to anything else worth reading.
 */
async function theProductionTrace(claim: GradingClaim): Promise<Resolved> {
  const { traceId, firstSpanAt, lastSpanAt } = claim;
  if (traceId === null || firstSpanAt === null || lastSpanAt === null) {
    throw new NotGradable(
      `grading job ${claim.id} says it is a production trace's and does not say which`,
    );
  }

  const A_SECOND_IN_MICROSECONDS = 1_000_000n;
  const trace = await readTrace(claim.auth, traceId, {
    window: {
      from: BigInt(firstSpanAt.getTime()) * 1_000n - A_SECOND_IN_MICROSECONDS,
      to: BigInt(lastSpanAt.getTime()) * 1_000n + A_SECOND_IN_MICROSECONDS,
    },
  });

  if (trace === undefined) {
    // Not a race: the spans were stored before the job that names them was
    // written. This is telemetry that has gone from the store — a retention
    // window that passed, a store restored without it — and saying so is better
    // than writing `errored` rows about an agent that did nothing wrong.
    throw new NotGradable(
      `trace ${traceId} holds no spans in the window its job recorded`,
    );
  }

  return {
    conversation: conversationOfTrace(trace),
    graders: await judgingGraders(claim, () =>
      applicableProductionGraders(claim.auth),
    ),
    simulationId: undefined,
  };
}

/**
 * What one grader says about this conversation.
 *
 * **The definition is required, and a copy pointing at nothing is `errored`.**
 * The pointer is a foreign key, so this cannot happen; answering it rather than
 * asserting it is what keeps a grading service from throwing over a row that
 * came out of its own database, and the word is `errored` because egma failed to
 * make a check rather than the agent failing one.
 *
 * **A conversation with nothing to judge is `errored` too, and the executor
 * decides the shape of that answer.** Either it never happened — the agent never
 * joined, the line was never answered, egma's own runtime broke — or it happened
 * and egma cannot read it, because its spans never arrived and no column holds
 * it. Both are things that went wrong on egma's side of the glass, and the one
 * thing a test product must never do is score them as the agent behaving badly.
 *
 * That decision is inside the executors rather than in front of them because how
 * many rows it is depends on what the grader's assertions are: the
 * expected-behaviors grader names one per behavior and writes one `errored` row
 * per behavior, so a page shows the same list whether the conversation happened
 * or not, while a grader that makes one check writes one. Every executor is
 * handed `nothingToJudgeBecause` on the conversation and is held to it by a
 * test.
 *
 * **A grader that falls over answers under its own keys too**, which is the same
 * rule one step further out. A verdict is counted once per conversation, grader
 * and assertion key, and that identity does not span the grader version — so a
 * row filed under a key the executor never writes can never be superseded. It
 * would outrank every `passed` beside it forever and no re-grade could reach it,
 * and a test that failed once could never pass again. So the reason is handed to
 * the same grader to spread across the same keys.
 *
 * **If even that cannot be answered, nothing is written and the throw escapes.**
 * A grader egma cannot describe is one it must stay silent about rather than
 * file a row it can never correct; the job is released and judged again from the
 * beginning, which is what the attempt count is for.
 */
export async function judgmentsOf(
  grader: Grader,
  definition: LibraryEntry | undefined,
  execution: {
    readonly conversation: Conversation;
    readonly judging: Judging;
    readonly reading: Reading;
  },
): Promise<readonly Judgment[]> {
  if (definition === undefined) {
    return [
      {
        // The pointer rather than the copy's name: a name is text a person
        // wrote and may rewrite, and a key that moved with it would split every
        // row written before the rename from every row written after.
        assertion: grader.libraryId,
        verdict: "errored",
        score: 0,
        rationale:
          "this grader points at a library entry Egma cannot read, so there was nothing to judge by.",
        citedSpanIds: [],
      },
    ];
  }

  // The definition and the copy's filled-in values, and nothing about whose
  // grader this is or what it is called: an executor that could see any of that
  // could be written to answer with it.
  const asked = {
    definition,
    config: grader.config,
    conversation: execution.conversation,
    judging: execution.judging,
    reading: execution.reading,
  };

  try {
    return await execute(asked);
  } catch (error) {
    // One grader falling over is one `errored` row per check it makes, not a
    // conversation with no verdicts on it. Every other grader's judgment still
    // lands, and these say out loud that egma could not make the check — which
    // is the whole reason `errored` is a word separate from `failed`.
    return await couldNotJudge(
      asked,
      `this check could not be made: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * One judgment, as the row that records it.
 *
 * **The copy names itself now.** A verdict row used to carry the string
 * `expected_behaviors` where a grader id belongs, because the built-in was never
 * a row; every project runs a copy of the library entry instead, so every row
 * this writes names a real grader and the version that decided it — which is
 * what keeps the row interpretable after the grader is tightened, since the
 * values it was decided by are frozen behind that id and a re-grade at the next
 * version writes beside rather than over.
 */
function verdictRow(
  grader: Grader,
  conversation: Conversation,
  judgment: Judgment,
): NewVerdict {
  return {
    traceId: conversation.traceId,
    graderId: grader.id,
    graderVersionId: grader.versionId,
    assertion: judgment.assertion,
    source: conversation.source,
    verdict: judgment.verdict,
    score: judgment.score,
    rationale: judgment.rationale,
    citedSpanIds: judgment.citedSpanIds,
    runId: conversation.runId,
    agentId: conversation.agentId,
    // Empty, and honestly so: egma does not version agents yet, and a made-up
    // value would make "how did v7 do against v8" answer with nonsense the day
    // versions arrive.
    agentVersionId: "",
    judgedAtMicroseconds: judgedNow(),
  };
}

/**
 * When the judgment was made, in microseconds, and never twice the same.
 *
 * The clock is what the store keeps rows by: a re-run of the identical judgment
 * replaces the one before it only if it is stamped later. `Date.now` moves in
 * milliseconds and a re-grade of a small run is faster than that, so two
 * judgments could land on one instant and the store would be free to keep
 * either. The counter makes the stamp strictly increasing inside a process
 * without letting it run ahead of the clock by more than the judgments it
 * actually made.
 */
let lastStamp = 0n;
function judgedNow(): bigint {
  const now = BigInt(Date.now()) * 1000n;
  lastStamp = now > lastStamp ? now : lastStamp + 1n;
  return lastStamp;
}
