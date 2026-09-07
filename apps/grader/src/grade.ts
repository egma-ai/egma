import {
  appendGrades,
  catalogEntry,
  getSimulation,
  getSimulationTestVersion,
  MAXIMUM_WINDOW_MILLISECONDS,
  MOST_GRADING_ATTEMPTS,
  readTrace,
  recordProviderUsage,
  type FrozenGradingEntry,
  type GradingClaim,
  type GradingSource,
  type NewGrade,
  type NewUsageRecord,
  type TraceDetail,
  type UsageQuantities,
} from "@egma/db";
import type {
  ProviderCredentialBundle,
  ProviderCredentialSource,
} from "@egma/provider-credentials";

import {
  conversationOfSimulation,
  conversationOfTrace,
  evidenceIsStillArriving,
  type Conversation,
} from "./conversation.ts";
import { execute, type GraderResult, type Reading } from "./graders/index.ts";
import {
  JUDGE_MAKERS,
  judgeFor,
  type AskableJudge,
  type JudgeMakers,
  type JudgeUsage,
} from "./judge/index.ts";

/** What grading one claimed trace durably appended. */
export type Graded = {
  readonly source: GradingSource;
  readonly traceId: string;
  readonly graders: number;
  readonly grades: number;
};

/** A queue row that cannot be reconciled with its frozen evidence. */
export class NotGradable extends Error {}

export type GradeOptions = {
  readonly providerCredentials: ProviderCredentialSource;
  readonly makers?: JudgeMakers | undefined;
};

type Resolved = {
  readonly conversation: Conversation;
  readonly simulationId: string | undefined;
};

/**
 * Execute the whole frozen plan carried by one claim.
 *
 * Store reads, provider credentials, and the final ClickHouse append are
 * whole-job infrastructure. A failure there retries the job. One grader that
 * cannot return a valid score becomes one null-score error grade and does not
 * stop its siblings.
 */
export async function gradeClaim(
  claim: GradingClaim,
  options: GradeOptions,
): Promise<Graded> {
  const resolved = await resolveConversation(claim);
  const credentials = claim.entries.some(
    (entry) => entry.definition.type === "llm_as_judge",
  )
    ? await options.providerCredentials.load()
    : {};
  // What every judge call consumed, gathered as the calls are made. One list
  // for the whole claim: the records carry which grader and which assertion
  // spent what, so nothing is lost by pooling them.
  const spend: NewUsageRecord[] = [];
  const judges = judgesFor(
    claim.entries,
    credentials,
    options.makers ?? JUDGE_MAKERS,
    (entry, usage) => {
      spend.push(usageRow(claim, entry, resolved.simulationId, usage));
    },
  );
  const reading = readingFor(claim, resolved.simulationId);

  const rows = await Promise.all(claim.entries.map(async (entry) => {
    const result = await resultOf(entry, resolved.conversation, reading, judges);
    return gradeRow(claim, entry, result);
  }));

  // The spend before the grades, and in the same breath: the money was spent
  // the moment each provider answered, whatever becomes of the grade beside it.
  // A store failure here retries the whole claim, which makes fresh provider
  // requests with their own identities — correctly new spend — while the
  // records already written collapse on theirs.
  await recordProviderUsage(claim.auth, spend);

  // One append after every grader has answered. A store failure therefore
  // retries the whole frozen plan, while ClickHouse keeps every completed retry
  // as history and the read path chooses the latest result per project grader.
  await appendGrades(claim.auth, rows);
  return {
    source: claim.source,
    traceId: claim.traceId,
    graders: claim.entries.length,
    grades: rows.length,
  };
}

function readingFor(claim: GradingClaim, simulationId: string | undefined): Reading {
  let held: Promise<readonly string[]> | undefined;
  return {
    expectedBehaviors(): Promise<readonly string[]> {
      if (simulationId === undefined) return Promise.resolve([]);
      held ??= (async () => {
        const version = await getSimulationTestVersion(claim.auth, simulationId);
        if (version === undefined) {
          throw new Error(
            `simulation ${simulationId} has no readable frozen test version`,
          );
        }
        return version.expectedBehaviors;
      })();
      return held;
    },
  };
}

async function resultOf(
  entry: FrozenGradingEntry,
  conversation: Conversation,
  reading: Reading,
  judges: ReadonlyMap<string, AskableJudge>,
): Promise<GraderResult> {
  try {
    const result = await execute({
      definition: entry.definition,
      parameterValues: entry.parameterValues,
      conversation,
      judging: { judge: judges.get(entry.projectGraderId) ?? null },
      reading,
    });
    if (result.score === null) {
      if (typeof result.details.error !== "string" || result.details.error.trim() === "") {
        throw new Error("returned a null score without an error explanation");
      }
      return result;
    }
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
      throw new Error(`returned score ${result.score}, outside 0 through 1`);
    }
    return result;
  } catch (error) {
    return {
      score: null,
      details: {
        error: `this grader could not produce a score: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}

/** Resolve every selected model before any executor starts. */
function judgesFor(
  entries: readonly FrozenGradingEntry[],
  credentials: ProviderCredentialBundle,
  makers: JudgeMakers,
  spent: (entry: FrozenGradingEntry, usage: JudgeUsage) => void,
): ReadonlyMap<string, AskableJudge> {
  const judges = new Map<string, AskableJudge>();
  for (const entry of entries) {
    if (entry.definition.type === "code") continue;
    if (entry.definition.judgeModel === null) {
      throw new Error(
        `model-judged definition ${entry.graderDefinitionId} version ${entry.graderDefinitionVersion} has no judge model`,
      );
    }
    judges.set(
      entry.projectGraderId,
      judgeFor(entry.definition.judgeModel, credentials, makers, (usage) => {
        spent(entry, usage);
      }),
    );
  }
  return judges;
}

/**
 * One judge request, as the record Egma keeps of what it cost.
 *
 * **The identity is the work, not a fresh id.** The grading job, the attempt
 * of it that made the request, the grader, the assertion it decided and which
 * HTTP attempt answered — every one of those is a fact that does not change
 * when the same delivery is made again, and together they are the request. So
 * a retried store write collapses onto one row, while a grading job genuinely
 * tried again spends again and says so, because its attempt counter moved.
 */
function usageRow(
  claim: GradingClaim,
  entry: FrozenGradingEntry,
  simulationId: string | undefined,
  usage: JudgeUsage,
): NewUsageRecord {
  const model = entry.definition.judgeModel;
  if (model === null) {
    throw new Error("a judge reported usage for a grader with no judge model");
  }
  // The pinned catalog model. The provider's own served string never reaches
  // this shape — see `JudgeUsage` for why.
  const named = model.model;
  const adapter = catalogEntry("llm", model.provider, named)?.adapter;
  return {
    identity: {
      work: "grading",
      gradingJobId: claim.id,
      attempts: claim.attempts,
      projectGraderId: entry.projectGraderId,
      assertion: usage.assertion,
      httpAttempt: usage.httpAttempt,
    },
    occurredAt: usage.occurredAt,
    ...(claim.runId === null ? {} : { runId: claim.runId }),
    ...(simulationId === undefined ? {} : { simulationId }),
    traceId: claim.traceId,
    provider: model.provider,
    model: named,
    // A judge speaks chat completions. The catalog is asked anyway, so a
    // provider whose adapter is something else on the day it arrives is named
    // by the catalog rather than by an assumption written here.
    operation: adapter ?? "openai_chat_completions",
    quantities: usage.quantities as UsageQuantities,
    // The counts are the provider's own; Egma counts nothing here.
    measurement: "provider_reported",
    ...(usage.providerRef === undefined
      ? {}
      : { providerRef: usage.providerRef }),
    paymentSource: "platform",
    rawUsage: usage.rawUsage,
  };
}

function gradeRow(
  claim: GradingClaim,
  entry: FrozenGradingEntry,
  result: GraderResult,
): NewGrade {
  return {
    source: claim.source,
    traceId: claim.traceId,
    traceStartedAtMicroseconds: BigInt(claim.traceStartedAt.getTime()) * 1_000n,
    runId: claim.runId ?? "",
    projectGraderId: entry.projectGraderId,
    graderDefinitionId: entry.graderDefinitionId,
    graderDefinitionVersion: entry.graderDefinitionVersion,
    score: result.score,
    details: result.details,
    graderPassThreshold: entry.graderPassThreshold,
    gradingSequence: claim.sequenceBase + claim.attempts,
    gradedAtMicroseconds: gradedNow(),
  };
}

async function resolveConversation(claim: GradingClaim): Promise<Resolved> {
  if (claim.source === "production") {
    const trace = await traceFor(claim);
    if (trace === undefined) {
      throw new NotGradable(
        `production trace ${claim.traceId} is no longer readable in its frozen window`,
      );
    }
    return { conversation: conversationOfTrace(trace), simulationId: undefined };
  }
  if (claim.simulationId === null) {
    throw new NotGradable(`simulation grading job ${claim.id} names no simulation`);
  }
  const simulation = await getSimulation(claim.auth, claim.simulationId);
  if (simulation === undefined || simulation.status !== "completed") {
    throw new NotGradable(
      `simulation ${claim.simulationId} is not a completed trace the job can read`,
    );
  }
  if (claim.runId === null || claim.runId !== simulation.runId) {
    throw new NotGradable(
      `grading job ${claim.id} does not name simulation ${simulation.id}'s run`,
    );
  }

  const trace = await traceFor(claim);
  if (trace !== undefined && trace.runId !== claim.runId) {
    throw new NotGradable(
      `trace ${trace.traceId} does not carry its frozen simulation run`,
    );
  }

  // A simulation can reach its terminal row before accepted evidence becomes
  // readable. Ask again while the retry budget remains. On the final attempt,
  // write error grades from the missing or partial conversation instead of
  // abandoning work that can no longer improve.
  if (
    evidenceIsStillArriving(simulation, trace) &&
    claim.attempts < MOST_GRADING_ATTEMPTS
  ) {
    throw new NotGradable(
      `simulation ${simulation.id} is complete and egma does not hold all of ` +
        `its conversation yet, so there is nothing to grade on attempt ` +
        `${claim.attempts} of ${MOST_GRADING_ATTEMPTS}`,
    );
  }

  return {
    conversation: conversationOfSimulation(simulation, trace),
    simulationId: simulation.id,
  };
}

async function traceFor(
  claim: GradingClaim,
): Promise<TraceDetail | undefined> {
  const cushion = 1_000_000n;
  const from = BigInt(claim.traceStartedAt.getTime()) * 1_000n - cushion;
  const to = from + BigInt(MAXIMUM_WINDOW_MILLISECONDS) * 1_000n;
  const trace = await readTrace(claim.auth, claim.traceId, {
    window: { from, to },
  });
  if (trace === undefined) {
    return undefined;
  }
  if (trace.source !== claim.source) {
    throw new NotGradable(
      `trace ${claim.traceId} is ${trace.source}, not ${claim.source}`,
    );
  }
  return trace;
}

/** Preserve completion order inside one worker; the job sequence orders workers. */
let lastStamp = 0n;
function gradedNow(): bigint {
  const now = BigInt(Date.now()) * 1_000n;
  lastStamp = now > lastStamp ? now : lastStamp + 1n;
  return lastStamp;
}
