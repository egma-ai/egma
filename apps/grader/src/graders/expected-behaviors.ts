import { getSimulationTestVersion, type LibraryEntry } from "@egma/db";

import {
  judgeInputOf,
  NoJudge,
  type JudgeQuestion,
} from "../judge/index.ts";
import type { Execution, Judgment } from "./contract.ts";
import { judgmentOf } from "./judged.ts";

/**
 * The expected-behaviors grader: a test's expected behaviors, judged one at a
 * time.
 *
 * **It is an ordinary running copy now**, and that is the change this file
 * carries. It used to be implicit — never a row, never resolved, applied
 * because running a test *meant* judging it against what the test says, and
 * writing the word `expected_behaviors` where a verdict row wants a grader id.
 * Every project is now seeded with an active copy of the library entry instead,
 * so it is resolved like everything else, its verdict rows name a real grader
 * and a real version, and the sentinel string is gone.
 *
 * **Its assertions are the test's own sentences, which is why its config is
 * empty.** Nothing is filled in at Use time and nothing could be: what this
 * grader checks is whatever the test in front of it says should happen, read at
 * judging time off the version the conversation was executed against.
 *
 * **The judge prompt comes off the library entry, through the copy's pointer.**
 * It is never written down onto the copy, so the words the Library screen shows
 * a developer and the words a model is sent are one string. A release that
 * improves the prompt improves it everywhere at once, because there is only one
 * place it lives.
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
 * The assertion key is the behavior's **position**, one-based, in the order the
 * test's author wrote them — never the sentence itself, which is read back from
 * the pinned test version when somebody looks at the row.
 *
 * A position is stable exactly as far as it needs to be. A conversation is
 * judged against the frozen test version it was *executed* against, so a test
 * whose behaviors are reordered or rewritten does not reinterpret what was
 * already judged: within one version, position 3 is the same sentence forever,
 * which is the property the fold's key actually needs.
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
 * - **There is no test.** No rows at all, and that is an ordinary case rather
 *   than a gap: somebody proving a connection with a smoke call wrote down no
 *   expectations, so there is nothing here to have an opinion about.
 */

/**
 * The behaviors this conversation was supposed to show, judged.
 *
 * The one executor that reads something outside the conversation, and it is the
 * whole reason `reading` is on the execution: this grader's assertions live on
 * the test, not in its own config, so it has to go and get them.
 */
export async function executeExpectedBehaviors(
  execution: Execution,
): Promise<readonly Judgment[]> {
  const { auth, simulationId } = execution.reading;
  // A production trace has no simulation and therefore no test. The copy is
  // scoped to simulations for exactly this reason, so reaching here means
  // somebody widened a scope by hand; answering nothing is the honest reply.
  if (simulationId === undefined) return [];

  const version = await getSimulationTestVersion(auth, simulationId);
  if (version === undefined) return [];

  const behaviors = version.expectedBehaviors;
  if (behaviors.length === 0) return [];

  // The same sentence the other graders answer with, read off the conversation
  // rather than written a second time here: two copies of it are two things a
  // reader could be told about one conversation.
  const nothingToJudge = execution.conversation.nothingToJudgeBecause;
  if (nothingToJudge !== null) {
    return behaviors.map((_, at) => couldNotJudge(at, nothingToJudge));
  }

  // The words a model is told it is working under, read through the copy's
  // pointer. An entry carrying none is a definition this executor cannot ask
  // anything with, and saying so is better than sending an empty instruction.
  const prompt = judgePromptOf(execution.definition);
  if (prompt === null) {
    return behaviors.map((_, at) =>
      couldNotJudge(
        at,
        `the ${execution.definition.name} grader in egma's library carries no judge prompt, so there was nothing to ask with.`,
      ),
    );
  }

  // Only now, with behaviors to judge, a conversation that happened and words
  // to ask with, is the project's key worth unsealing.
  const configured = await execution.judging.judge();
  if (configured instanceof NoJudge) {
    const why = configured.message;
    return behaviors.map((_, at) => couldNotJudge(at, why));
  }

  const judge = configured.judging(execution.judging.model, execution.judging.makers);

  // Assembled once and shared by every call, which is what makes N judgments of
  // one conversation one read rather than N.
  const evidence = judgeInputOf(execution.conversation);
  const turns = evidence.transcript.length;

  // In parallel, because they are independent by construction: wall-clock for a
  // test with five behaviors is one judge call rather than five.
  return Promise.all(
    behaviors.map(async (behavior, at): Promise<Judgment> => {
      // A behavior is a plain sentence: the per-behavior priority retired with
      // the ladder, so there is nothing beside the words to read.
      const question: JudgeQuestion = { prompt, criterion: behavior, evidence };
      try {
        return judgmentOf(behaviorKey(at), await judge.ask(question), turns);
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
}

/** The definition's own words, or nothing where the entry carries none. */
function judgePromptOf(definition: LibraryEntry): string | null {
  const prompt = definition.prompt;
  return prompt === null || prompt.trim() === "" ? null : prompt;
}

/**
 * What the behaviors' assertion key is: the position, one-based, in the order
 * they were authored.
 *
 * Written as a function rather than as a template at each site so the string
 * every verdict row files a behavior under is decided in one place.
 */
function behaviorKey(at: number): string {
  return `behavior_${at + 1}`;
}

/** egma could not judge this. Never `failed`: nothing is said about the agent. */
function couldNotJudge(at: number, rationale: string): Judgment {
  return {
    assertion: behaviorKey(at),
    verdict: "errored",
    score: 0,
    rationale,
    citedSpanIds: [],
  };
}
