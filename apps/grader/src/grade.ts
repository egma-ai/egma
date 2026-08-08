import {
  appendVerdicts,
  getGrader,
  getSimulation,
  readTrace,
  type Grader,
  type GradingClaim,
  type GradingSource,
  type NewVerdict,
  type Priority,
} from "@egma/db";

import {
  conversationOf,
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
 * **The source decides the first two steps and nothing after them.** A
 * simulation is read from its header row and judged by the project's graders
 * plus its test's; a production trace is read from its spans and judged by the
 * project's production-scoped graders, sampled. From the moment a `Conversation`
 * and a grader list exist there is one path — one executor seam, one verdict row
 * builder, one write — because a second judging path would be a second set of
 * answers that could one day disagree about the same agent.
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

/** A finished simulation, read from the row that already holds everything. */
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
    conversation: conversationOf(simulation),
    graders: await judgingGraders(claim, () =>
      applicableGraders(claim.auth, simulation),
    ),
    simulationId: simulation.id,
  };
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
 * **A simulation that never ran is `errored` for every grader, and no grader is
 * executed at all.** The agent never joined, the line was never answered, egma's
 * own runtime broke — there is no conversation to judge, and the one thing a
 * test product must never do is score that as the agent behaving badly. The word
 * is `errored` rather than `failed`, the fold keeps the two apart all the way up
 * to the run's headline, and the check is here rather than inside each executor
 * so that no future grader type can get it wrong.
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
  if (!conversation.happened) {
    return [
      couldNotJudge(
        grader,
        `this simulation ended ${conversation.endingReason ?? "without running"}, so there was no conversation to judge.`,
      ),
    ];
  }

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
