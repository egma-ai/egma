import type { JudgeModel } from "@egma/db";
import {
  credentialFor,
  type ProviderCredentialBundle,
} from "@egma/provider-credentials";

import type { Judge, JudgeMaker, ResolvedJudge } from "./contract.ts";
import { openaiJudge } from "./openai.ts";

/**
 * The provider seam. Its keys match the closed grader-model catalog, so adding
 * a provider to that catalog also requires an executable adapter here.
 */
const MAKERS = {
  openai: openaiJudge,
} satisfies Readonly<Record<"openai", JudgeMaker>>;

/** The whole roster, as something a test can stand in for. */
export type JudgeMakers = typeof MAKERS;

export const JUDGE_MAKERS: JudgeMakers = MAKERS;

/**
 * One judge, ready to be asked. The key is closed over by the adapter and is
 * not available to executors, verdict builders, or logs.
 */
export type AskableJudge = {
  readonly ask: Judge;
};

/**
 * Resolve one grader version's exact model against the bundle loaded for this
 * claimed job. There is no fallback: a missing selected provider throws before
 * any verdict is written, so the service releases the job for a later attempt.
 */
export function judgeFor(
  model: JudgeModel,
  credentials: ProviderCredentialBundle,
  makers: JudgeMakers = JUDGE_MAKERS,
): AskableJudge {
  if (model.provider !== "openai") {
    throw new Error(
      `grader model provider ${model.provider} has no judge adapter in this release`,
    );
  }
  const resolved: ResolvedJudge = {
    provider: model.provider,
    model: model.model,
    key: credentialFor(credentials, model.provider),
  };
  return { ask: makers[model.provider](resolved) };
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
