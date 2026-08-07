import {
  appendVerdicts,
  getSimulation,
  readTrace,
  type Grader,
  type GradingClaim,
  type GradingSource,
  type NewVerdict,
} from "@egma/db";

import {
  conversationOf,
  conversationOfTrace,
  type Conversation,
} from "./conversation.ts";
import { execute, theOneCheck, type Judgment } from "./graders/index.ts";
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

/** A conversation and the graders that judge it: what a source resolves to. */
type Judging = {
  readonly conversation: Conversation;
  readonly graders: readonly Grader[];
};

export async function gradeClaim(claim: GradingClaim): Promise<Graded> {
  const { conversation, graders } =
    claim.source === "production"
      ? await theProductionTrace(claim)
      : await theSimulation(claim);

  // In parallel, and not because today's graders are slow — they are instant.
  // Because the judged types are one model call each, and wall-clock for a
  // conversation with five checks should be one call rather than five. Building
  // the fan-out now means the first judge is a new executor rather than a new
  // shape here.
  const judged = await Promise.all(
    graders.map(async (grader) =>
      (await judgmentsOf(grader, conversation)).map((judgment) =>
        verdictRow(grader, conversation, judgment),
      ),
    ),
  );
  const rows = judged.flat();

  await appendVerdicts(claim.auth, rows);

  return {
    source: conversation.source,
    traceId: conversation.traceId,
    graders: graders.length,
    verdicts: rows.length,
  };
}

/** A finished simulation, read from the row that already holds everything. */
async function theSimulation(claim: GradingClaim): Promise<Judging> {
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
    graders: await applicableGraders(claim.auth, simulation),
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
async function theProductionTrace(claim: GradingClaim): Promise<Judging> {
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
    graders: await applicableProductionGraders(claim.auth),
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
 * which is the honest shape while every type executed makes one. A type that
 * names several dimensions of its own will want one `errored` row per dimension
 * instead, so that a page shows the same list whether the conversation happened
 * or not; that is a question for the type that first has several, and this is
 * where it is asked.
 */
export async function judgmentsOf(
  grader: Grader,
  conversation: Conversation,
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
    // — so the executor is handed the grader itself and sees only the pair.
    return await execute({ judgment: grader, conversation });
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

/** One judgment, as the row that records it. */
function verdictRow(
  grader: Grader,
  conversation: Conversation,
  judgment: Judgment,
): NewVerdict {
  return {
    traceId: conversation.traceId,
    graderId: grader.id,
    // The version that judged, which is what keeps this row interpretable after
    // the grader is tightened: the config it was decided by is frozen behind
    // this id, and a re-grade at the next version writes beside rather than over.
    graderVersionId: grader.versionId,
    dimension: judgment.dimension,
    source: conversation.source,
    // `engine`, because no model was asked anything. A judge model's own name
    // goes here when one is used, and `human` when a person disagrees.
    judgedBy: "engine",
    verdict: judgment.verdict,
    score: judgment.score,
    rationale: judgment.rationale,
    citedSpanIds: judgment.citedSpanIds,
    // **Snapshotted, never referenced.** The priority is a live setting: read
    // here at the moment of judging and written onto the row, so promoting this
    // check to P0 tomorrow cannot reinterpret what today's warning meant.
    priority: grader.priority,
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
