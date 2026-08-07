import {
  appendVerdicts,
  getSimulation,
  type Grader,
  type GradingClaim,
  type NewVerdict,
} from "@egma/db";

import { conversationOf, type Conversation } from "./conversation.ts";
import { execute, theOneCheck, type Judgment } from "./graders/index.ts";
import { applicableGraders } from "./resolve.ts";

/**
 * One claimed job, judged end to end: read the conversation, resolve the graders
 * that apply to it, execute each, write the verdict rows.
 *
 * Four steps and no fifth. Nothing here decides an overall answer for the
 * conversation or for its run — there is no such row anywhere, by design, and
 * the fold works one out at read time from exactly the rows this wrote.
 *
 * **The verdicts are written in one call.** A conversation's judgments land
 * together or not at all as far as any reader is concerned, and a job that fails
 * before the write is released and judged again from the beginning — which is
 * safe precisely because writing the same judgment twice at the same grader
 * version replaces rather than doubles.
 */

/** What judging one conversation came to. */
export type Graded = {
  readonly simulationId: string;
  /** How many graders applied — including the ones that could not score. */
  readonly graders: number;
  readonly verdicts: number;
};

/** Why a job could not be judged, when it could not be. */
export class NotGradable extends Error {}

export async function gradeClaim(claim: GradingClaim): Promise<Graded> {
  if (claim.simulationId === null) {
    throw new NotGradable(
      `grading job ${claim.id} names no conversation, and only a simulation's can be judged today`,
    );
  }

  const simulation = await getSimulation(claim.auth, claim.simulationId);
  if (simulation === undefined) {
    throw new NotGradable(
      `simulation ${claim.simulationId} is not reachable from the job that names it`,
    );
  }

  const conversation = conversationOf(simulation);
  const graders = await applicableGraders(claim.auth, simulation);

  const rows: NewVerdict[] = [];
  for (const grader of graders) {
    for (const judgment of await judgmentsOf(grader, conversation)) {
      rows.push(verdictRow(grader, conversation, judgment));
    }
  }

  await appendVerdicts(claim.auth, rows);

  return {
    simulationId: simulation.id,
    graders: graders.length,
    verdicts: rows.length,
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
 */
async function judgmentsOf(
  grader: Grader,
  conversation: Conversation,
): Promise<readonly Judgment[]> {
  if (!conversation.happened) {
    return [
      {
        dimension: theOneCheck(grader.type),
        verdict: "errored",
        score: 0,
        rationale: `this simulation ended ${conversation.endingReason ?? "without running"}, so there was no conversation to judge.`,
        citedSpanIds: [],
      },
    ];
  }

  // The grader *is* its judgment plus its identity and its live settings — the
  // type and the config it shapes are one inseparable pair on the row already —
  // so the executor is handed the grader itself and sees only the pair.
  return execute({ judgment: grader, conversation });
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
