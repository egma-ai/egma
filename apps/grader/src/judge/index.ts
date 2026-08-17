import {
  getJudgeConfiguration,
  resolveJudgeKey,
  resolveModelProviderKeys,
  type AuthContext,
  type GraderModel,
  type JudgeModel,
  type JudgeProvider,
} from "@egma/db";

import type { Judge, JudgeMaker, ResolvedJudge } from "./contract.ts";
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
 * One judge, ready to be asked.
 *
 * **One field is the whole of what anything outside this directory ever holds,
 * and the key is deliberately not in it.** A grader module gets something it can
 * ask and nothing else; there is no field here through which a secret could
 * reach a rationale, a verdict row or a log line. That makes the key's
 * confinement a property of the shape rather than of everybody remembering, and
 * every grader type that judges with a model gets it for free.
 *
 * There is no name beside it either. Which judge answered was carried to the
 * verdict row's `judged_by`, and that column retired with the human corrections
 * it existed for — a human word returns as the reserved `human` grader type,
 * under its own grader id. Nothing else ever wanted the name, so nothing hands
 * it out.
 */
export type AskableJudge = {
  readonly ask: Judge;
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
 * Which model decides one grader's judgments, and which account pays.
 *
 * **Two paths, and which one a grader is on is a fact of its own version.** A
 * version that carries a `grader_model` selected its provider and model
 * outright, and the key behind it is the organization's model-provider
 * credential for that provider — the same store a persona's models spend from,
 * so one account serves both. A version that carries none is on the
 * compatibility path: the project's judge configuration decides, exactly as it
 * did before the model catalog existed, and its `judge_model` may still
 * override the provider and the model without touching the key.
 *
 * The two never mix. A grader with its own selection does not consult the
 * project's judge at all — so a project that has configured none still judges
 * with graders that chose for themselves, which is the whole point of the
 * selection being on the version.
 */
export type GraderJudging = {
  readonly graderModel: GraderModel | null;
  readonly judgeModel: JudgeModel | null;
};

/**
 * One conversation's judges, resolved at most once per source however many
 * graders ask.
 *
 * **Asked per grader, because which source answers is the grader's own fact.**
 * A conversation judged by one grader that selected its model and one that did
 * not opens two envelopes, each once — and a conversation with nothing judged
 * to do opens neither, because resolving a key is beginning to act with it.
 */
export type ConversationJudges = {
  judgeFor(
    grader: GraderJudging,
    makers: JudgeMakers,
  ): Promise<AskableJudge | NoJudge>;
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
 * The judges one conversation may be judged by, each source resolved at most
 * once however many graders ask for it.
 *
 * The promise is what is remembered rather than its answer, so graders racing
 * each other in a `Promise.all` share one resolution instead of starting two.
 */
export function judgesOnce(auth: AuthContext): ConversationJudges {
  let theProjects: Promise<ProjectJudge | NoJudge> | undefined;
  const byProvider = new Map<string, Promise<string | NoJudge>>();

  const keyForProvider = (provider: string): Promise<string | NoJudge> => {
    const held = byProvider.get(provider);
    if (held !== undefined) return held;
    const resolving = organizationKeyFor(auth, provider);
    byProvider.set(provider, resolving);
    return resolving;
  };

  return {
    async judgeFor(
      grader: GraderJudging,
      makers: JudgeMakers,
    ): Promise<AskableJudge | NoJudge> {
      const selected = grader.graderModel;
      if (selected === null) {
        const configured = await (theProjects ??= projectJudge(auth));
        if (configured instanceof NoJudge) return configured;
        return configured.judging(grader.judgeModel, makers);
      }

      const maker = makerFor(selected.provider, makers);
      if (maker instanceof NoJudge) return maker;

      const key = await keyForProvider(selected.provider);
      if (key instanceof NoJudge) return key;

      return {
        ask: maker({
          provider: selected.provider as JudgeProvider,
          model: selected.model,
          key,
        }),
      };
    },
  };
}

/**
 * The organization's own key for one provider, or the sentence a person can
 * act on.
 *
 * **A missing credential is an infrastructure error and never a failed
 * verdict.** A check that could not be made did not fail: nothing about the
 * agent was learned, and recording it as a failure would put a red row on a
 * report for a key somebody has not pasted yet. The sentence names the provider
 * and where to add it, because that is what the person reading the rationale
 * has to do next.
 */
async function organizationKeyFor(
  auth: AuthContext,
  provider: string,
): Promise<string | NoJudge> {
  let resolved: Awaited<ReturnType<typeof resolveModelProviderKeys>>;
  try {
    resolved = await resolveModelProviderKeys(auth, [provider]);
  } catch (error) {
    // The master key is missing, the envelope will not open, or the stored
    // provider is one Egma no longer ships. Said plainly: this becomes a
    // rationale a person reads.
    return new NoJudge(
      `this grader's ${provider} credential could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const key = resolved.keys.get(provider as never);
  if (key === undefined) {
    return new NoJudge(
      `this grader judges with ${provider}, and this organization holds no ${provider} model-provider credential; add one under Model providers in Organization settings.`,
    );
  }
  return key;
}

/**
 * The maker for a selected provider, or the sentence saying Egma cannot ask it.
 *
 * **Refused rather than quietly answered by another provider.** A grader whose
 * selection this release cannot execute must say so; falling through to the one
 * maker that exists would judge a customer's conversation on a model nobody
 * chose, and the verdict would read as if they had.
 */
function makerFor(provider: string, makers: JudgeMakers): JudgeMaker | NoJudge {
  const known = Object.hasOwn(makers, provider)
    ? makers[provider as JudgeProvider]
    : undefined;
  if (known === undefined) {
    return new NoJudge(
      `this grader judges with ${provider}, and this release ships no judge for it; it judges with ${Object.keys(makers).join(", ")}.`,
    );
  }
  return known;
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

      return { ask: judgeFrom(resolved, makers) };
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
