import { getSimulationTestVersion, type AuthContext } from "@egma/db";

import type { Conversation } from "../conversation.ts";
import {
  judgeInputOf,
  NoJudge,
  type JudgeMakers,
  type JudgeQuestion,
  type JudgeResolution,
} from "../judge/index.ts";
import type { Judgment } from "./contract.ts";
import { judgmentOf } from "./judged.ts";

/**
 * The built-in grader: a test's expected behaviors, judged one at a time.
 *
 * **It is never a row and never resolved.** Every other grader is something
 * somebody attached; this one applies because running a test *means* judging it
 * against what the test says it expects (ADR-0004). So it is not in the
 * executor roster, does not come through `resolve.ts`, and cannot be detached —
 * a test can never be made unfalsifiable, even deliberately.
 *
 * ## One call per behavior, and why it is not one call per conversation
 *
 * Each expected behavior gets its own independent judge call, all of them in
 * parallel, each producing its own verdict row. The alternative — one call that
 * reads the list and answers about the whole conversation — is what the
 * industry's older shape does, and it produces one blurred explanation in which
 * a developer cannot see *which* behavior failed. Worse, it lets a judge trade
 * one behavior off against another: an agent that did four things well and one
 * thing badly comes back "mostly good", which is a sentence nobody can act on.
 *
 * **The isolation is structural rather than careful.** A judge is handed one
 * criterion and the conversation's evidence, and the evidence type has nowhere
 * for a second criterion to be. So no behavior's text can reach another
 * behavior's judge — not because this function is written well, but because
 * there is no shape in which it could.
 *
 * ## What each row says
 *
 * The assertion is the behavior's **position**, one-based, in the order the
 * test's author wrote them — the key, never the sentence, which is read back
 * from the pinned test version when somebody looks at the row.
 *
 * A position is stable exactly as far as it needs to be. The grader version on
 * these rows is the **frozen test version** the conversation was executed
 * against, so a test whose behaviors are reordered or rewritten judges under a
 * new version and lands rows beside the old ones rather than over them. Within
 * one version, position 3 is the same sentence forever, which is the property
 * the fold's assertion key actually needs.
 *
 * ## What it says when it cannot say anything
 *
 * - **The simulation never ran.** One `errored` row per behavior, no judge
 *   asked. The list is still read, because a page must show the same behaviors
 *   whether the conversation happened or not — a test that could not run should
 *   look like a test that could not run, not like a test with nothing in it.
 * - **The project configured no judge**, or its key will not open. One
 *   `errored` row per behavior saying which, because a check egma could not
 *   make is never a check that passed.
 * - **One judge call failed after its retries.** `errored` for that behavior
 *   and that behavior only. Its siblings were separate calls and their answers
 *   land untouched, which is the whole reason they are separate calls.
 * - **The judge could not tell.** `skipped`, and it leaves the score's
 *   denominator — a behavior nobody could judge neither passed nor failed
 *   anything.
 */

/** What every grader in this file is: the built-in, named once. */
export const EXPECTED_BEHAVIORS = "expected_behaviors";

/** The built-in's whole answer about one conversation. */
export type ExpectedBehaviorsJudgment = {
  /**
   * The frozen test version whose behaviors these are — what goes in the verdict
   * row's `grader_version_id`, and what keeps these rows readable after the
   * test is edited.
   */
  readonly versionId: string;
  readonly judged: readonly Judgment[];
};

export type ExpectedBehaviorsExecution = {
  readonly auth: AuthContext;
  readonly simulationId: string;
  readonly conversation: Conversation;
  /**
   * The project's judge, asked for only once this decides it is going to judge
   * something — after the behaviors are known and after the conversation is
   * known to have happened. A test with nothing to judge never causes a key to
   * be unsealed.
   */
  readonly judge: JudgeResolution;
  readonly makers: JudgeMakers;
};

/**
 * The behaviors this conversation was supposed to show, judged.
 *
 * `undefined` for a simulation that pinned no test version, and that is an
 * ordinary case rather than a gap: somebody proving a connection with a smoke
 * call wrote down no expectations, so there is nothing to judge them against and
 * the project's own graders still judge the conversation.
 */
export async function judgeExpectedBehaviors(
  execution: ExpectedBehaviorsExecution,
): Promise<ExpectedBehaviorsJudgment | undefined> {
  const { auth, simulationId, conversation } = execution;

  const version = await getSimulationTestVersion(auth, simulationId);
  if (version === undefined) return undefined;

  const behaviors = version.expectedBehaviors;
  if (behaviors.length === 0) return undefined;

  // The same sentence the authored graders answer with, read off the
  // conversation rather than written a second time here: two copies of it are
  // two things a reader could be told about one conversation.
  const nothingToJudge = conversation.nothingToJudgeBecause;
  if (nothingToJudge !== null) {
    return {
      versionId: version.id,
      judged: behaviors.map((_behavior, at) => couldNotJudge(at, nothingToJudge)),
    };
  }

  // Only now, with behaviors to judge and a conversation that happened, is the
  // project's key worth unsealing.
  const configured = await execution.judge();
  if (configured instanceof NoJudge) {
    const why = configured.message;
    return {
      versionId: version.id,
      judged: behaviors.map((_behavior, at) => couldNotJudge(at, why)),
    };
  }

  // The project's own, with no override: the built-in is not a grader row, so
  // it has no `judge_model` to insist on — the override belongs to authored
  // graders, and this one is nobody's to configure. What comes back is a way to
  // ask and a name to record, and deliberately not a key.
  const judge = configured.judging(null, execution.makers);

  // Assembled once and shared by every call, which is what makes N judgments of
  // one conversation one read rather than N.
  const evidence = judgeInputOf(conversation);
  const turns = evidence.transcript.length;

  // In parallel, because they are independent by construction: wall-clock for a
  // test with five behaviors is one judge call rather than five.
  const judged = await Promise.all(
    behaviors.map(async (behavior, at): Promise<Judgment> => {
      const question: JudgeQuestion = { criterion: behavior, evidence };
      try {
        return judgmentOf(behaviorAssertion(at), await judge.ask(question), turns);
      } catch (error) {
        // One judge call falling over is one `errored` row. Every sibling's
        // answer still lands, and this one says out loud that egma could not
        // make the check — which is the whole reason `errored` is a word
        // separate from `failed`.
        return couldNotJudge(
          at,
          `this behavior could not be judged: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  return { versionId: version.id, judged };
}

/**
 * What the behaviors' assertion is called: the position, one-based, in the
 * order they were authored.
 *
 * Written as a function rather than as a template at each site so the string
 * every verdict row files a behavior under is decided in one place.
 */
function behaviorAssertion(at: number): string {
  return `behavior_${at + 1}`;
}

/** egma could not judge this. Never `failed`: nothing is said about the agent. */
function couldNotJudge(at: number, rationale: string): Judgment {
  return {
    assertion: behaviorAssertion(at),
    verdict: "errored",
    score: 0,
    rationale,
    citedSpanIds: [],
  };
}
