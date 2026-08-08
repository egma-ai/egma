import {
  getJudgeConfiguration,
  resolveJudgeKey,
  type AuthContext,
  type JudgeModel,
  type JudgeProvider,
} from "@egma/db";

import {
  named,
  type Judge,
  type JudgeMaker,
  type ResolvedJudge,
} from "./contract.ts";
import { openaiJudge } from "./openai.ts";

/**
 * The provider seam: one judge provider, one function, and nothing else in the
 * engine knows how any of them speak.
 *
 * The roster is `Record<JudgeProvider, …>`, so it cannot drift from the closed
 * list the two tables are checked against: a provider added to `JUDGE_PROVIDERS`
 * refuses to build until it is told how to ask. v1 ships OpenAI and nothing
 * else, and the shape is sized for what comes next — Anthropic's own API, and
 * the OpenAI-compatible endpoints that are one base URL away from the file
 * beside this one.
 */
const MAKERS: { readonly [Provider in JudgeProvider]: JudgeMaker } = {
  openai: openaiJudge,
};

/** The whole roster, as something a test can stand in for. */
export type JudgeMakers = typeof MAKERS;

export const JUDGE_MAKERS: JudgeMakers = MAKERS;

/**
 * Which judge answers, once the provider is settled — the one place the roster
 * is read, and the last place the key is seen before it becomes a request.
 */
function judgeFrom(resolved: ResolvedJudge, makers: JudgeMakers): Judge {
  return makers[resolved.provider](resolved);
}

/**
 * Why nothing could be judged by a model, when nothing could.
 *
 * Its own type because the two callers do two different things with it: the
 * built-in grader turns it into one `errored` row per behavior with this
 * sentence on each, and a page reading those rows shows a project what it has
 * to configure. A bare `Error` would make "you have not set a judge" and "the
 * provider refused the key" the same event.
 */
export class NoJudge extends Error {}

/**
 * One judge, ready to be asked — and the name that goes on whatever it decides.
 *
 * **This pair is the whole of what anything outside this directory ever holds,
 * and the key is deliberately not in it.** A grader module gets something it can
 * ask and something it can record; there is no field here through which a secret
 * could reach a rationale, a verdict row or a log line. That makes the key's
 * confinement a property of the shape rather than of everybody remembering, and
 * every grader type that judges with a model gets it for free.
 */
export type AskableJudge = {
  readonly ask: Judge;
  /** `provider/model`, for the verdict row's `judged_by`. Never the account. */
  readonly name: string;
};

/**
 * The project's judge, resolved: the default it configured, the key behind it,
 * and a way to layer one grader's override over the top.
 *
 * **Read once per conversation, applied per grader.** The configuration and the
 * key are one read each; every grader that judges this conversation then layers
 * its own `judge_model` over the provider and the model, which is exactly what
 * the override is for — a cheap judge for the routine checks and a stronger one
 * named on the subtle rubric, on one account.
 *
 * **The key comes from the project's configuration whatever the override says.**
 * An override names a provider and a model and never a key, so a grader cannot
 * quietly move a project's judging onto an account nobody configured.
 */
export type ProjectJudge = {
  /**
   * This grader's judge, ready to ask. `null` for a grader with no override of
   * its own, which is every grader but the ones that named a `judge_model` —
   * and the built-in, which is nobody's to configure.
   *
   * The override is judged content: it lives on the immutable grader version and
   * an edit to it mints the next one, so a verdict written under it stays
   * readable as "decided by this model" long after the project's default moved
   * on.
   */
  judging(override: JudgeModel | null, makers: JudgeMakers): AskableJudge;
};

/**
 * The project's judge, asked for rather than handed over.
 *
 * A function rather than a value, and the laziness is the point: **resolving a
 * key is beginning to act with it.** A conversation with nothing judged to do —
 * no expected behaviors, a simulation that never ran, only deterministic
 * graders — never opens the envelope at all. Everything that *does* judge one
 * conversation shares the one resolution behind it, because every judged check
 * on it must speak with the same account and because five checks should cost
 * one read of the configuration rather than five.
 */
export type JudgeResolution = () => Promise<ProjectJudge | NoJudge>;

/**
 * The project's judge, resolved at most once however many times it is asked
 * for. The promise is what is remembered rather than its answer, so callers
 * racing each other in a `Promise.all` share one resolution instead of starting
 * two.
 */
export function judgeOnce(auth: AuthContext): JudgeResolution {
  let resolving: Promise<ProjectJudge | NoJudge> | undefined;
  return () => (resolving ??= projectJudge(auth));
}

export async function projectJudge(
  auth: AuthContext,
): Promise<ProjectJudge | NoJudge> {
  const configuration = await getJudgeConfiguration(auth);
  if (configuration === undefined) {
    return new NoJudge(
      "this project has configured no judge, so there was nothing to ask.",
    );
  }

  let key: string | undefined;
  try {
    key = await resolveJudgeKey(auth, configuration.keyReference);
  } catch (error) {
    // The master key is missing, or the envelope will not open. Said plainly
    // and without the reference: this becomes a rationale a person reads.
    return new NoJudge(
      `this project's judge key could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (key === undefined) {
    return new NoJudge(
      "this project's judge configuration holds no key, so there was nothing to ask with.",
    );
  }

  const asConfigured: ResolvedJudge = {
    provider: configuration.provider,
    model: configuration.model,
    key,
  };

  return {
    judging(override: JudgeModel | null, makers: JudgeMakers): AskableJudge {
      // The key is the project's whatever the override says; only the provider
      // and the model are the grader's to name.
      const resolved: ResolvedJudge =
        override === null
          ? asConfigured
          : { provider: override.provider, model: override.model, key };

      return { ask: judgeFrom(resolved, makers), name: named(resolved) };
    },
  };
}

export {
  type Decision,
  type Judge,
  type JudgeAnswer,
  type JudgeMaker,
  type JudgeQuestion,
  type ResolvedJudge,
} from "./contract.ts";
export {
  asJudgeReads,
  judgeInputOf,
  textOf,
  turnReference,
  TURN_REFERENCE_PREFIX,
  type JudgeInput,
  type Turn,
} from "./input.ts";
