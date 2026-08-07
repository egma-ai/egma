import {
  appendVerdicts,
  getSimulation,
  type Grader,
  type GradingClaim,
  type NewVerdict,
  type Priority,
} from "@egma/db";

import { conversationOf, type Conversation } from "./conversation.ts";
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
 *
 * **The built-in stands beside the resolved graders and not among them.** The
 * expected-behaviors grader is never a row and never attachable, so it is never
 * resolved; it applies because running a test means judging it against what the
 * test says. That is why it is a second branch of the fan-out below rather than
 * an entry in the executor roster.
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

export type GradeOptions = {
  /**
   * How each judge provider is spoken to. The default speaks to the real ones;
   * a test hands over a scripted judge, which is what lets the whole engine
   * suite run with no key and no network.
   */
  readonly makers?: JudgeMakers | undefined;
};

export async function gradeClaim(
  claim: GradingClaim,
  options: GradeOptions = {},
): Promise<Graded> {
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
  const makers = options.makers ?? JUDGE_MAKERS;

  // The project's judge, shared by everything on this conversation that judges
  // and resolved only if something does. Nothing here decides whether it is
  // needed — the things that judge ask, and a conversation where none of them
  // does never opens the envelope.
  const judge = judgeOnce(claim.auth);

  const graders = await applicableGraders(claim.auth, simulation);

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
    judgeExpectedBehaviors({
      auth: claim.auth,
      simulationId: simulation.id,
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
    simulationId: simulation.id,
    // The built-in counts, because it judged: a conversation judged only against
    // its test's behaviors was judged, and reporting nothing applied would be
    // reporting that nothing happened.
    graders: graders.length + (builtIn === undefined ? 0 : 1),
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
