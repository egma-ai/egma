import {
  appendVerdicts,
  getGrader,
  getSimulation,
  readTrace,
  MAXIMUM_WINDOW_MILLISECONDS,
  type AuthContext,
  type Grader,
  type GradingClaim,
  type GradingSource,
  type NewVerdict,
  type Priority,
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
  EXPECTED_BEHAVIORS,
  judgeExpectedBehaviors,
} from "./graders/expected-behaviors.ts";
import {
  execute,
  theOneCheck,
  type Judging,
  type Judgment,
} from "./graders/index.ts";
import { JUDGE_MAKERS, judgeOnce, type JudgeMakers } from "./judge/index.ts";
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
 * said it ended, and it is judged by the project's graders plus its test's; a
 * production trace has no row and is judged by the project's production-scoped
 * graders, sampled. From the moment a `Conversation` and a grader list exist
 * there is one path — one executor seam, one verdict row builder, one write —
 * because a second judging path would be a second set of answers that could one
 * day disagree about the same agent.
 *
 * **The verdicts are written in one call.** A conversation's judgments land
 * together or not at all as far as any reader is concerned, and a job that fails
 * before the write is released and judged again from the beginning — which is
 * safe precisely because writing the same judgment twice at the same grader
 * version replaces rather than doubles.
 *
 * **The built-in stands beside the resolved graders and not among them.** The
 * expected-behaviors grader is never a row and never attachable, so it is never
 * resolved; it applies because running a test means judging it against what the
 * test says. That is why it is a second branch of the fan-out below rather than
 * an entry in the executor roster — and why it belongs to simulations alone: a
 * production trace has no test, so there is nothing for the built-in to judge
 * against.
 *
 * **A claim reopened for one grader judges that grader and nothing else.** Both
 * branches of the fan-out are narrowed by it: the resolved list becomes that one
 * grader, and the built-in does not run at all. Somebody who fixed one rubric
 * asked for one rubric's judgment, and every other judge call on the
 * conversation would be money they did not agree to spend — which is the whole
 * reason the narrowing exists rather than a nicety of it.
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
   * The simulation the conversation came from, when it came from one — what
   * the built-in judges by. A production trace resolves to none, and with it
   * to no built-in.
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
 * **The named grader judges whatever its scope says**, on the same terms a test's
 * grader array is applied whatever its scope says: naming it *is* the scoping
 * decision, made once by the person who asked for this re-grade rather than
 * standing policy about where the grader usually applies. Sampling is not asked
 * either — a re-grade somebody typed is not traffic egma did not cause.
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

  // The project's judge, shared by everything on this conversation that judges
  // and resolved only if something does. Nothing here decides whether it is
  // needed — the things that judge ask, and a conversation where none of them
  // does never opens the envelope.
  const judge = judgeOnce(claim.auth);

  // In parallel, and not because today's deterministic graders are slow — they
  // are instant. Because the judged types are one model call each, and
  // wall-clock for a conversation with five checks should be one call rather
  // than five.
  const [byGrader, builtIn] = await Promise.all([
    Promise.all(
      graders.map(async (grader) =>
        (
          await judgmentsOf(grader, conversation, {
            judge,
            makers,
            // This version's own judge, or null for the project's default. It
            // is judged content, frozen on the version beside the config, so a
            // verdict decided by it stays readable as "decided by this model"
            // long after the project's default moved on.
            model: grader.judgeModel,
          })
        ).map((judgment) =>
          verdictRow(
            {
              graderId: grader.id,
              // The version that judged, which is what keeps this row
              // interpretable after the grader is tightened: the config it was
              // decided by is frozen behind this id, and a re-grade at the next
              // version writes beside rather than over.
              graderVersionId: grader.versionId,
              priority: grader.priority,
            },
            conversation,
            judgment,
          ),
        ),
      ),
    ),
    // No test's behaviors on a narrowed claim, and the built-in is the reason
    // narrowing had to be spelled out here rather than left to the resolution:
    // it is never resolved, so nothing above could have dropped it. A re-grade
    // naming a grader named an authored one — the built-in is not a row and has
    // no identity to name — so it is not what was asked for, and it is one judge
    // call per behavior of spend nobody agreed to.
    simulationId === undefined || claim.regradeGraderId !== null
      ? undefined
      : judgeExpectedBehaviors({
          auth: claim.auth,
          simulationId,
          conversation,
          judge,
          makers,
        }),
  ]);

  const behaviorRows =
    builtIn === undefined
      ? []
      : builtIn.judged.map((judged) =>
          verdictRow(
            {
              // The built-in is never a row in any table, so it names itself
              // with the one word that can never collide with a minted `grd_`
              // identifier — the same word the grader type roster reserves and
              // never holds.
              graderId: EXPECTED_BEHAVIORS,
              // Its version is the frozen test version whose behaviors it
              // judged. Nothing else about the built-in can change, and that
              // list changing is exactly when a verdict written under it stops
              // meaning what it meant.
              graderVersionId: builtIn.versionId,
              judgedBy: builtIn.judgedBy,
              // Each behavior's own, not one grader's: a nice-to-have behavior
              // cannot block a release and a must-have one always can.
              priority: judged.priority,
            },
            conversation,
            judged.judgment,
          ),
        );

  const rows = [...byGrader.flat(), ...behaviorRows];

  await appendVerdicts(claim.auth, rows);

  return {
    source: conversation.source,
    traceId: conversation.traceId,
    // The built-in counts, because it judged: a conversation judged only against
    // its test's behaviors was judged, and reporting nothing applied would be
    // reporting that nothing happened.
    graders: graders.length + (builtIn === undefined ? 0 : 1),
    verdicts: rows.length,
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
    graders: await judgingGraders(claim, () =>
      applicableGraders(claim.auth, simulation),
    ),
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
 * **A conversation with nothing to judge is `errored` for every grader, and no
 * grader is executed at all.** Either it never happened — the agent never
 * joined, the line was never answered, egma's own runtime broke — or it happened
 * and egma cannot read it, because its spans never arrived and no column holds
 * it. Both are things that went wrong on egma's side of the glass, and the one
 * thing a test product must never do is score them as the agent behaving badly.
 * The word is `errored` rather than `failed`, the fold keeps the two apart all
 * the way up to the run's headline, and the check is here rather than inside
 * each executor so that no future grader type can get it wrong.
 *
 * It answers with one row per grader, named by the grader's own one check —
 * which is the honest shape while every *authored* type executed makes one. The
 * question this used to ask, of the first type to name several dimensions, is
 * answered: the built-in expected-behaviors grader names one per behavior and
 * writes one `errored` row per behavior when the conversation never happened, so
 * a page shows the same list whether it happened or not. An authored type that
 * grows several dimensions follows it, in its own module, on the same terms.
 */
export async function judgmentsOf(
  grader: Grader,
  conversation: Conversation,
  judging: Judging,
): Promise<readonly Judgment[]> {
  /**
   * **Nothing-to-judge wins over modality, and the order is a decision.**
   *
   * A voice simulation that never happened, judged by a grader that only scores
   * chat, could honestly be called either: `errored`, because egma could not
   * read a conversation it should have; or `skipped`, because this check was
   * never about that conversation anyway. It answers `errored`.
   *
   * The reason is which fact a reader has to act on. A conversation egma could
   * not read is an operational failure — a flush that never landed, a runtime
   * that broke — and somebody has to go and look at it. A modality mismatch is
   * a settled fact about a grader that needs nobody's attention at all. Letting
   * the mismatch answer first would hide the failure behind it: the run would
   * report a check that quietly did not apply, and the broken telemetry would
   * be visible only on whichever graders happened to score voice. So the fault
   * is reported wherever it is known, and a check that would not have applied
   * says `errored` on a conversation that did not happen rather than the run
   * losing the evidence that it did not happen.
   */
  const nothingToJudge = conversation.nothingToJudgeBecause;
  if (nothingToJudge !== null) {
    return [couldNotJudge(grader, nothingToJudge)];
  }

  /**
   * **A grader that cannot score this modality is `skipped`, and asked
   * nothing.** The check is here rather than inside each executor for the
   * reason the one above it is: no grader type, today's or tomorrow's, can get
   * it wrong, and a judged type is never asked — so a rubric written about
   * speech costs no model call on a chat conversation.
   *
   * `skipped` and never `failed`: "didn't interrupt the caller" is not a thing
   * a chat agent did badly, it is a thing that was never about that
   * conversation, and it leaves the score's denominator rather than reddening
   * a run. It is not `errored` either — nothing went wrong, and egma did not
   * fail to make a check it was able to make.
   */
  const unsupported = modalityUnsupported(grader, conversation);
  if (unsupported !== null) return [unsupported];

  try {
    // The grader *is* its judgment plus its identity and its live settings — the
    // type and the config it shapes are one inseparable pair on the row already
    // — so the executor is handed the grader itself and sees only the pair, plus
    // a way to reach a judge that the deterministic types never use.
    return await execute({ judgment: grader, conversation, judging });
  } catch (error) {
    // One grader falling over is one `errored` row, not a conversation with no
    // verdicts on it. Every other grader's judgment still lands, and this one
    // says out loud that egma could not make its check — which is the whole
    // reason `errored` is a word separate from `failed`.
    return [
      couldNotJudge(
        grader,
        `this check could not be made: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }
}

/**
 * The stable reason a modality skip carries, in the verdict row's own `reason`
 * column.
 *
 * Two things are `skipped` and neither is a failure: a grader that cannot score
 * this conversation's modality, and a threshold whose measure the conversation
 * never produced. A results page has to tell them apart — "this check was never
 * about this conversation" and "egma had nothing to measure" send a reader to
 * two different places — and it cannot do that from prose without making the
 * prose contract.
 */
export const MODALITY_UNSUPPORTED = "modality_unsupported";

/**
 * Whether this grader can score this conversation, and the `skipped` judgment
 * when it cannot.
 *
 * A conversation whose modality is unstated — every production trace — is
 * scored by everything. Guessing which layer a real caller used would mean
 * silently dropping checks on evidence egma does not have, and a check quietly
 * not made is exactly the hole this product exists to close.
 */
function modalityUnsupported(
  grader: Grader,
  conversation: Conversation,
): Judgment | null {
  const { modality } = conversation;
  if (modality === null || grader.modalities.includes(modality)) return null;

  return {
    dimension: theOneCheck(grader.type),
    verdict: "skipped",
    score: 0,
    // The word goes in the column beside the sentence, not inside it. A page
    // recognises the case by the word and shows a person the sentence, and
    // rewording the sentence breaks nothing.
    reason: MODALITY_UNSUPPORTED,
    rationale:
      `This grader scores ${grader.modalities.join(" and ")} conversations, ` +
      `and this one was ${modality}, so no judgment was made about the agent.`,
    citedSpanIds: [],
  };
}

/** egma could not judge this. Never `failed`: nothing is being said about the agent. */
function couldNotJudge(grader: Grader, rationale: string): Judgment {
  return {
    dimension: theOneCheck(grader.type),
    verdict: "errored",
    score: 0,
    rationale,
    citedSpanIds: [],
  };
}

/**
 * Whose judgment this is, and how loudly it speaks — everything a verdict row
 * needs that the judgment itself deliberately does not carry.
 *
 * The priority is **snapshotted, never referenced**: it is a live setting, read
 * at the moment of judging and written onto the row, so promoting a check to P0
 * tomorrow cannot reinterpret what today's warning meant.
 */
type JudgedBy = {
  readonly graderId: string;
  readonly graderVersionId: string;
  /**
   * Who judged, when the judgment did not say. The built-in names its own —
   * one judge for the whole list — and an authored grader's is per judgment,
   * because a judged type records the model that answered and a deterministic
   * one records nothing at all.
   */
  readonly judgedBy?: string | undefined;
  readonly priority: Priority;
};

/** One judgment, as the row that records it. */
function verdictRow(
  by: JudgedBy,
  conversation: Conversation,
  judgment: Judgment,
): NewVerdict {
  return {
    traceId: conversation.traceId,
    graderId: by.graderId,
    graderVersionId: by.graderVersionId,
    dimension: judgment.dimension,
    source: conversation.source,
    // The judge that answered, or `engine` when no model was asked anything —
    // and `human` on the day a person disagrees, which is a row of their own
    // rather than an edit to this one.
    judgedBy: judgment.judgedBy ?? by.judgedBy ?? "engine",
    verdict: judgment.verdict,
    score: judgment.score,
    rationale: judgment.rationale,
    ...(judgment.reason === undefined ? {} : { reason: judgment.reason }),
    citedSpanIds: judgment.citedSpanIds,
    priority: by.priority,
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
