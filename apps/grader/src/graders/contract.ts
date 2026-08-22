import type { GraderDefinitionSnapshot } from "@egma/db";

import type { Conversation } from "../conversation.ts";
import type { AskableJudge } from "../judge/index.ts";

/** One assertion kept as evidence inside a grader's one top-level result. */
export type GraderAssertionResult = {
  readonly key: string;
  readonly score?: number | undefined;
  readonly rationale?: string | undefined;
  readonly citedSpanIds?: readonly string[] | undefined;
  readonly error?: string | undefined;
};

/** The stable Egma-owned envelope stored in the ClickHouse details JSON. */
export type GraderResultDetails = {
  readonly rationale?: string | undefined;
  readonly assertions?: readonly GraderAssertionResult[] | undefined;
  readonly error?: string | undefined;
} & Readonly<Record<string, unknown>>;

/**
 * One grader's complete answer.
 *
 * A non-null normalized score means the grader scored. A null score means the
 * grader errored and must carry a plain explanation. Assertion detail never
 * becomes another grade row.
 */
export type GraderResult = {
  readonly score: number | null;
  readonly details: GraderResultDetails;
};

/** A model capability with provider credentials closed inside it. */
export type Judging = {
  readonly judge: AskableJudge | null;
};

/**
 * Test variables a grader may need, behind one narrow read interface.
 *
 * Production has no authored test, so it returns an empty list. The expected
 * behaviors executor does not know which database row supplied the values.
 */
export type Reading = {
  expectedBehaviors(): Promise<readonly string[]>;
};

/** Everything an executor may use, and no project policy. */
export type Execution = {
  readonly definition: GraderDefinitionSnapshot;
  readonly conversation: Conversation;
  readonly judging: Judging;
  readonly reading: Reading;
};

export type Executor = (
  execution: Execution,
) => GraderResult | Promise<GraderResult>;

/** One shared immutable definition Egma knows how to execute. */
export type GraderExecutor = {
  readonly execute: Executor;
};
