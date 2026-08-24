import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendGrades,
  appendSpans,
  claimGradingJobs,
  connectClickHouse,
  disconnectClickHouse,
  finishGradingJob,
  getGradingJob,
  getGradingJobForTrace,
  readProductionGradingPlan,
  readTraceGrades,
  readTraceGrading,
  reconcileGraderCatalog,
  recordProductionTraces,
  regradeTrace,
  releaseGradingJob,
  requestGrading,
  type AuthContext,
  type FrozenGradingEntry,
  type GradingClaim,
  type NewSpan,
} from "../src/index.ts";

import {
  createConnectedDatabase,
  openSingleConnection,
  type MigratedDatabase,
} from "./support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;

const organizationId = newId("org");
const projectId = newId("prj");
const userId = newId("usr");
const definitionId = newId("grl");
const projectGraderId = newId("grd");

const auth: AuthContext = {
  organizationId,
  projectId,
  userId,
  role: "member",
  via: "session",
};

const TRACE_START = new Date("2026-08-21T08:00:00.000Z");

function productionSpan(overrides: Partial<NewSpan> = {}): NewSpan {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "aaaaaaaaaaaaaaaa",
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: BigInt(TRACE_START.getTime()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_session",
    kind: "root",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "production-call",
    agentPlatform: "livekit_agents",
    platformAgentId: "agent-under-test",
    platformAgentName: "Support",
    platformAgentVersion: "",
    connectionType: "livekit_room",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: false,
    ...overrides,
  };
}

function request(traceId: string, endsTrace = true) {
  return requestGrading(auth, {
    source: "production",
    traceId,
    traceStartedAt: TRACE_START,
    endsTrace,
    evidenceReady: true,
    modality: "chat",
  });
}

async function claimTrace(traceId: string, claimant: string): Promise<GradingClaim> {
  const claimed = await claimGradingJobs({ claimant, capacity: 50 });
  const found = claimed.find((one) => one.traceId === traceId);
  if (found === undefined) throw new Error(`trace ${traceId} was not claimed`);
  return found;
}

function entryOf(claim: GradingClaim): FrozenGradingEntry {
  const [entry] = claim.entries;
  if (entry === undefined) throw new Error(`job ${claim.id} has no frozen entry`);
  return entry;
}

async function appendOne(
  claim: GradingClaim,
  score: number | null,
  gradedAtMicroseconds: bigint,
): Promise<void> {
  const entry = entryOf(claim);
  await appendGrades(claim.auth, [{
    source: claim.source,
    traceId: claim.traceId,
    traceStartedAtMicroseconds: BigInt(claim.traceStartedAt.getTime()) * 1_000n,
    runId: "",
    projectGraderId: entry.projectGraderId,
    graderDefinitionId: entry.graderDefinitionId,
    graderDefinitionVersion: entry.graderDefinitionVersion,
    score,
    details: score === null
      ? { error: "the grader could not score" }
      : { rationale: `score ${score}` },
    graderPassThreshold: entry.graderPassThreshold,
    gradingSequence: claim.sequenceBase + claim.attempts,
    gradedAtMicroseconds,
  }]);
}

beforeAll(async () => {
  database = await createConnectedDatabase("grading_jobs_target");
  store = await createMigratedTraceStore("grading_jobs_target");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, userId, "grader-runtime@example.com");
  await reconcileGraderCatalog();

  const setup = await openSingleConnection(database.url);
  await setup.sql("begin");
  await setup.sql(
    `insert into grader_definition
       (id, name, description, type, scope_editable, current_definition_version)
     values ($1, 'Policy quality', 'A fixture grader', 'code', true, 1)`,
    [definitionId],
  );
  await setup.sql(
    `insert into grader_definition_version
       (definition_id, version, prompt, parameter_contract, output_contract,
        source_code, source_code_language, modalities, judge_model)
     values ($1, 1, null, '[]'::jsonb, '{}'::jsonb,
             'return 1', 'javascript', '["chat", "voice"]'::jsonb, null)`,
    [definitionId],
  );
  await setup.sql("commit");
  await setup.close();
  await database.sql(
    `insert into project_grader
       (id, organization_id, project_id, grader_definition_id, scope, pass_threshold)
     values ($1, $2, $3, $4,
             '{"simulations":[],"production":{"sample_percent":100}}'::jsonb,
             0.7)`,
    [projectGraderId, organizationId, projectId, definitionId],
  );
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

describe("one frozen production job", () => {
  it("creates no receipt or job until the explicit end arrives", async () => {
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaddd";

    await expect(request(traceId, false)).resolves.toEqual({
      kind: "waiting",
      for: "completion",
    });
    await expect(readProductionGradingPlan(auth, traceId)).resolves
      .toBeUndefined();
    await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();

    await expect(request(traceId, true)).resolves.toMatchObject({
      kind: "queued",
      created: true,
    });
    await expect(readProductionGradingPlan(auth, traceId)).resolves
      .toMatchObject({ traceId, entries: [expect.any(Object)] });
    await expect(getGradingJobForTrace(auth, traceId)).resolves
      .toMatchObject({ source: "production", traceId });

    const claim = await claimTrace(traceId, "grader-after-explicit-end");
    await appendOne(claim, 1, 1_777_000_000_000_000n);
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });

  it("freezes the whole selected plan, leases it, and deletes success", async () => {
    const traceId = "1111111111111111111111111111aaaa";
    await expect(request(traceId)).resolves.toMatchObject({
      kind: "queued",
      created: true,
    });

    const claim = await claimTrace(traceId, "grader-one");
    expect(claim.entries).toHaveLength(1);
    expect(entryOf(claim)).toMatchObject({
      projectGraderId,
      graderDefinitionId: definitionId,
      graderDefinitionVersion: 1,
      graderPassThreshold: 0.7,
      definition: {
        definitionId,
        definitionVersion: 1,
        type: "code",
        modalities: ["chat", "voice"],
      },
    });

    await appendOne(claim, 1, 1_777_000_001_000_000n);
    await expect(
      finishGradingJob(claim.auth, claim.id, claim.claimedBy),
    ).resolves.toEqual({ id: claim.id });
    await expect(getGradingJob(auth, claim.id)).resolves.toBeUndefined();
    await expect(request(traceId)).resolves.toEqual({
      kind: "terminal",
      outcome: "complete",
    });
  });

  it("keeps the reclaimed worker's grade current when completion times tie", async () => {
    const traceId = "1212121212121212121212121212aaaa";
    const sameCompletionTime = 1_777_000_001_250_000n;
    await request(traceId);

    const stale = await claimTrace(traceId, "grader-before-reclaim");
    await appendOne(stale, 0, sameCompletionTime);
    await releaseGradingJob(
      stale.auth,
      stale.id,
      stale.claimedBy,
      "cleanup failed after the first append",
    );

    const reclaimed = await claimTrace(traceId, "grader-after-reclaim");
    await appendOne(reclaimed, 1, sameCompletionTime);
    await finishGradingJob(reclaimed.auth, reclaimed.id, reclaimed.claimedBy);

    const grades = await readTraceGrades(auth, { source: "production", traceId });
    expect(grades.history.map((grade) => grade.score).sort()).toEqual([0, 1]);
    expect(grades.current).toMatchObject([{ score: 1, result: "passed" }]);
  });

  it("keeps a terminal infrastructure failure instead of inventing grades", async () => {
    const traceId = "2222222222222222222222222222bbbb";
    await request(traceId);

    let claim: GradingClaim | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      claim = await claimTrace(traceId, `grader-attempt-${attempt}`);
      await releaseGradingJob(
        claim.auth,
        claim.id,
        claim.claimedBy,
        `store unavailable on attempt ${attempt}`,
      );
    }

    const retained = await getGradingJobForTrace(auth, traceId);
    expect(retained).toMatchObject({
      status: "abandoned",
      attempts: 3,
      lastError: "store unavailable on attempt 3",
    });
    await expect(request(traceId)).resolves.toEqual({
      kind: "terminal",
      outcome: "error",
    });
    await expect(readTraceGrades(auth, {
      source: "production",
      traceId,
    })).resolves.toEqual({ history: [], current: [] });
  });

  it("keeps durable grades complete when final cleanup loses its worker", async () => {
    const traceId = "2323232323232323232323232323bbbb";
    await request(traceId);

    for (let attempt = 1; attempt < 3; attempt += 1) {
      const claim = await claimTrace(traceId, `grader-before-final-${attempt}`);
      await releaseGradingJob(
        claim.auth,
        claim.id,
        claim.claimedBy,
        `store unavailable on attempt ${attempt}`,
      );
    }

    const final = await claimTrace(traceId, "grader-lost-after-append");
    await appendOne(final, 1, 1_777_000_001_500_000n);
    await database.sql(
      `update grading_job
          set heartbeat_at = now() - interval '10 seconds'
        where id = $1`,
      [final.id],
    );
    await claimGradingJobs({
      claimant: "grader-after-final-expiry",
      capacity: 50,
      leaseSeconds: 1,
    });

    await expect(getGradingJob(auth, final.id)).resolves.toMatchObject({
      status: "abandoned",
      attempts: 3,
    });
    await expect(readTraceGrading(auth, { source: "production", traceId }))
      .resolves.toMatchObject({
        state: "complete",
        combinedScore: 1,
        current: [{ score: 1, result: "passed" }],
      });
    await expect(request(traceId)).resolves.toEqual({
      kind: "terminal",
      outcome: "complete",
    });
  });
});

describe("the durable production handoff", () => {
  it("waits for a supported explicit end and freezes the visible trace start once", async () => {
    const traceId = "5555555555555555555555555555eeee";
    const first = productionSpan({
      traceId,
      spanId: "5555555555555551",
      name: "caller_turn",
      kind: "turn:human",
    });
    await appendSpans(auth, [first]);
    await recordProductionTraces(auth, [first]);
    await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();

    const ended = productionSpan({
      traceId,
      spanId: "5555555555555552",
      startedAtMicroseconds: first.startedAtMicroseconds + 10_000_000n,
      endsTrace: true,
    });
    await appendSpans(auth, [ended]);
    await recordProductionTraces(auth, [ended]);

    const queued = await getGradingJobForTrace(auth, traceId);
    expect(queued).toMatchObject({
      traceId,
      traceStartedAt: TRACE_START,
      status: "pending",
    });
    await recordProductionTraces(auth, [ended]);
    await expect(getGradingJobForTrace(auth, traceId)).resolves.toMatchObject({
      id: queued?.id,
      traceStartedAt: TRACE_START,
    });
    const [receiptCount] = await store.rows<{ readonly count: string }>(
      `select toString(count()) as count
         from production_grading_plans
        where trace_id = '${traceId}'`,
    );
    expect(receiptCount?.count).toBe("1");

    const claim = await claimTrace(traceId, "grader-durable-handoff");
    await appendOne(claim, 1, 1_777_000_004_000_000n);
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });

  it("does not grade an end asserted by an unsupported producer", async () => {
    const traceId = "5555555555555555555555555555ffff";
    const unsupported = productionSpan({
      traceId,
      spanId: "6666666666666666",
      agentPlatform: "another_platform",
      connectionType: "another_connection",
      endsTrace: true,
    });
    await appendSpans(auth, [unsupported]);
    await recordProductionTraces(auth, [unsupported]);

    await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();
    const [receiptCount] = await store.rows<{ readonly count: string }>(
      `select toString(count()) as count
         from production_grading_plans
        where trace_id = '${traceId}'`,
    );
    expect(receiptCount?.count).toBe("0");
  });
});

describe("production request replay at crash boundaries", () => {
  it("replays safely when the receipt store refuses the first write", async () => {
    const traceId = "6666666666666666666666666666ffff";
    const constraint = "reject_receipt_before_durability";
    await store.command(
      `alter table production_grading_plans
       add constraint ${constraint} check trace_id != '${traceId}'`,
    );
    try {
      await expect(request(traceId)).rejects.toThrow();
      await expect(readProductionGradingPlan(auth, traceId)).resolves
        .toBeUndefined();
      await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();
    } finally {
      await store.command(
        `alter table production_grading_plans drop constraint ${constraint}`,
      );
    }

    await expect(request(traceId)).resolves.toMatchObject({
      kind: "queued",
      created: true,
    });
    await expect(readProductionGradingPlan(auth, traceId)).resolves
      .toMatchObject({ entries: [{ graderPassThreshold: 0.7 }] });

    const claim = await claimTrace(traceId, "grader-after-receipt-refusal");
    await appendOne(claim, 1, 1_777_000_010_000_000n);
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });

  it("replays the frozen receipt after the job transaction aborts", async () => {
    const traceId = "7777777777777777777777777777aaaa";
    const trigger = "reject_job_after_receipt";
    const guard = "reject_job_after_receipt";
    await database.sql(
      `create function ${guard}() returns trigger
       language plpgsql as $$
       begin
         if new.trace_id = '${traceId}' then
           raise exception 'simulated crash after receipt';
         end if;
         return new;
       end
       $$`,
    );
    await database.sql(
      `create trigger ${trigger}
       before insert on grading_job
       for each row execute function ${guard}()`,
    );
    try {
      await expect(request(traceId)).rejects.toThrow();
    } finally {
      await database.sql(`drop trigger ${trigger} on grading_job`);
      await database.sql(`drop function ${guard}()`);
    }

    await expect(readProductionGradingPlan(auth, traceId)).resolves
      .toMatchObject({ entries: [{ graderPassThreshold: 0.7 }] });
    await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();

    await database.sql(
      "update project_grader set pass_threshold = 0.2 where id = $1",
      [projectGraderId],
    );
    try {
      await expect(request(traceId)).resolves.toMatchObject({
        kind: "queued",
        created: true,
      });
      const claim = await claimTrace(traceId, "grader-after-job-abort");
      expect(entryOf(claim).graderPassThreshold).toBe(0.7);
      await appendOne(claim, 1, 1_777_000_011_000_000n);
      await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
    } finally {
      await database.sql(
        "update project_grader set pass_threshold = 0.7 where id = $1",
        [projectGraderId],
      );
    }
  });

  it("returns the one committed job when its first response is lost", async () => {
    const traceId = "8888888888888888888888888888bbbb";

    // The first caller disappears after this commit and before it can act on
    // the response. Its retry therefore knows only the trace identity.
    await request(traceId);
    const committed = await getGradingJobForTrace(auth, traceId);
    if (committed === undefined) throw new Error("the first request committed no job");

    await expect(request(traceId)).resolves.toEqual({
      kind: "queued",
      jobId: committed.id,
      created: false,
    });
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from grading_job where trace_id = $1",
      [traceId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);

    const claim = await claimTrace(traceId, "grader-after-response-loss");
    await appendOne(claim, 1, 1_777_000_012_000_000n);
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });
});

describe("expired grading leases", () => {
  it("reclaims the same job and refuses cleanup by the old worker", async () => {
    const traceId = "9999999999999999999999999999cccc";
    await request(traceId);
    const first = await claimTrace(traceId, "grader-before-expiry");

    await database.sql(
      `update grading_job
          set heartbeat_at = now() - interval '10 seconds'
        where id = $1`,
      [first.id],
    );
    const reclaimed = (await claimGradingJobs({
      claimant: "grader-after-expiry",
      capacity: 50,
      leaseSeconds: 1,
    })).find((claim) => claim.traceId === traceId);
    if (reclaimed === undefined) throw new Error("the expired job was not reclaimed");

    expect(reclaimed).toMatchObject({
      id: first.id,
      claimedBy: "grader-after-expiry",
      attempts: 2,
    });
    await expect(
      finishGradingJob(first.auth, first.id, first.claimedBy),
    ).resolves.toBeUndefined();
    await expect(getGradingJob(auth, first.id)).resolves.toMatchObject({
      status: "claimed",
      claimedBy: "grader-after-expiry",
    });

    await appendOne(reclaimed, 1, 1_777_000_013_000_000n);
    await expect(
      finishGradingJob(reclaimed.auth, reclaimed.id, reclaimed.claimedBy),
    ).resolves.toEqual({ id: reclaimed.id });
    await expect(getGradingJob(auth, reclaimed.id)).resolves.toBeUndefined();
  });
});

describe("queue load", () => {
  it("keeps Postgres job rows equal to live backlog while durable history grows", async () => {
    const tracePrefix = "f004";
    const traceCount = 64;
    const liveBacklog = 4;
    const traceIds = Array.from(
      { length: traceCount },
      (_, index) => `${tracePrefix}${index.toString(16).padStart(28, "0")}`,
    );
    const postgresJobCount = async (): Promise<number> => {
      const { rows } = await database.sql<{ count: string }>(
        "select count(*) as count from grading_job where trace_id like $1",
        [`${tracePrefix}%`],
      );
      return Number(rows[0]?.count ?? 0);
    };
    const durableCounts = async (): Promise<{
      readonly plans: number;
      readonly grades: number;
    }> => {
      const [counts] = await store.rows<{
        readonly plan_count: string;
        readonly grade_count: string;
      }>(`select
             (select count() from production_grading_plans
               where startsWith(trace_id, '${tracePrefix}')) as plan_count,
             (select count() from grades
               where startsWith(trace_id, '${tracePrefix}')) as grade_count`);
      return {
        plans: Number(counts?.plan_count ?? 0),
        grades: Number(counts?.grade_count ?? 0),
      };
    };
    const finish = async (
      claims: readonly GradingClaim[],
      firstGrade: number,
    ): Promise<void> => {
      await Promise.all(
        claims.map((claim, index) =>
          appendOne(
            claim,
            1,
            1_777_100_000_000_000n + BigInt(firstGrade + index),
          )
        ),
      );
      const finished = await Promise.all(
        claims.map((claim) =>
          finishGradingJob(claim.auth, claim.id, claim.claimedBy)
        ),
      );
      expect(finished.map((row) => row?.id)).toEqual(
        claims.map((claim) => claim.id),
      );
    };

    const requested = await Promise.all(
      traceIds.map((traceId) => request(traceId)),
    );
    expect(
      requested.every((result) => result.kind === "queued" && result.created),
    ).toBe(true);
    expect(await postgresJobCount()).toBe(traceCount);
    await expect(durableCounts()).resolves.toEqual({
      plans: traceCount,
      grades: 0,
    });

    const claimed: GradingClaim[] = [];
    while (claimed.length < traceCount) {
      const wave = await claimGradingJobs({
        claimant: "grader-queue-load",
        capacity: 16,
      });
      expect(wave.every((claim) => claim.traceId.startsWith(tracePrefix))).toBe(
        true,
      );
      if (wave.length === 0) {
        throw new Error("the queue load stopped before every job was claimed");
      }
      claimed.push(...wave);
    }
    expect(new Set(claimed.map((claim) => claim.traceId))).toEqual(
      new Set(traceIds),
    );

    const completed = claimed.slice(0, -liveBacklog);
    const live = claimed.slice(-liveBacklog);
    await finish(completed, 0);

    expect(await postgresJobCount()).toBe(liveBacklog);
    await expect(durableCounts()).resolves.toEqual({
      plans: traceCount,
      grades: traceCount - liveBacklog,
    });

    await finish(live, completed.length);

    expect(await postgresJobCount()).toBe(0);
    await expect(durableCounts()).resolves.toEqual({
      plans: traceCount,
      grades: traceCount,
    });
  });
});

describe("regrading uses frozen history", () => {
  it("appends another grade without following later definition or threshold edits", async () => {
    const traceId = "3333333333333333333333333333cccc";
    await request(traceId);
    const first = await claimTrace(traceId, "grader-before-edit");
    await appendOne(first, 1, 1_777_000_002_000_000n);
    await finishGradingJob(first.auth, first.id, first.claimedBy);

    await database.sql(
      `insert into grader_definition_version
         (definition_id, version, prompt, parameter_contract, output_contract,
          source_code, source_code_language, modalities, judge_model)
       values ($1, 2, null, '[]'::jsonb, '{}'::jsonb,
               'return 0', 'javascript', '["chat", "voice"]'::jsonb, null)`,
      [definitionId],
    );
    await database.sql(
      "update grader_definition set current_definition_version = 2 where id = $1",
      [definitionId],
    );
    await database.sql(
      "update project_grader set pass_threshold = 0.2 where id = $1",
      [projectGraderId],
    );

    const reopened = await regradeTrace(auth, { source: "production", traceId });
    expect(reopened).toMatchObject({
      kind: "queued",
      reopened: true,
      alreadyWaiting: false,
    });
    await expect(regradeTrace(auth, { source: "production", traceId }))
      .resolves.toEqual({
        kind: "queued",
        jobId: reopened.kind === "queued" ? reopened.jobId : "",
        reopened: false,
        alreadyWaiting: true,
      });
    const second = await claimTrace(traceId, "grader-after-edit");
    expect(entryOf(second)).toMatchObject({
      graderDefinitionVersion: 1,
      graderPassThreshold: 0.7,
      definition: { definitionVersion: 1, sourceCode: "return 1" },
    });
    await appendOne(second, 0.5, 1_777_000_003_000_000n);
    await finishGradingJob(second.auth, second.id, second.claimedBy);

    const grades = await readTraceGrades(auth, {
      source: "production",
      traceId,
    });
    expect(grades.history).toHaveLength(2);
    expect(grades.current).toMatchObject([{
      score: 0.5,
      gradingSequence: 2,
      graderPassThreshold: 0.7,
      result: "failed",
    }]);
    await expect(readTraceGrading(auth, { source: "production", traceId }))
      .resolves.toMatchObject({
        state: "complete",
        combinedScore: 0.5,
        current: [{ graderName: "Policy quality", result: "failed" }],
      });
  });

  it("reopens above the attempt range reserved by an abandoned worker", async () => {
    const traceId = "3434343434343434343434343434dddd";
    const sameCompletionTime = 1_777_000_003_500_000n;
    await request(traceId);

    const first = await claimTrace(traceId, "grader-abandoned-one");
    await database.sql(
      `update grading_job
          set heartbeat_at = now() - interval '10 minutes'
        where id = $1`,
      [first.id],
    );
    const second = await claimTrace(traceId, "grader-abandoned-two");
    await database.sql(
      `update grading_job
          set heartbeat_at = now() - interval '10 minutes'
        where id = $1`,
      [second.id],
    );
    const stale = await claimTrace(traceId, "grader-abandoned-three");
    await database.sql(
      `update grading_job
          set heartbeat_at = now() - interval '10 minutes'
        where id = $1`,
      [stale.id],
    );
    await claimGradingJobs({
      claimant: "grader-abandoned-sweeper",
      capacity: 50,
      leaseSeconds: 1,
    });
    await expect(getGradingJob(auth, stale.id)).resolves.toMatchObject({
      status: "abandoned",
      sequenceBase: 0,
      attempts: 3,
    });

    await expect(regradeTrace(auth, { source: "production", traceId }))
      .resolves.toMatchObject({ kind: "queued", reopened: true });
    const fresh = await claimTrace(traceId, "grader-after-abandonment");
    expect(fresh).toMatchObject({ sequenceBase: 3, attempts: 1 });

    await appendOne(fresh, 1, sameCompletionTime);
    await finishGradingJob(fresh.auth, fresh.id, fresh.claimedBy);
    // The expired worker can still finish after its lease and the PG row are gone.
    await appendOne(stale, 0, sameCompletionTime);

    const grades = await readTraceGrades(auth, { source: "production", traceId });
    expect(grades.current).toMatchObject([{
      score: 1,
      gradingSequence: 4,
      result: "passed",
    }]);
  });

  it("stores an empty selection as not requested and creates no job", async () => {
    await database.sql(
      `update project_grader
          set scope = '{"simulations":[],"production":null}'::jsonb
        where id = $1`,
      [projectGraderId],
    );
    const traceId = "4444444444444444444444444444dddd";

    await expect(request(traceId)).resolves.toEqual({ kind: "not_requested" });
    await expect(getGradingJobForTrace(auth, traceId)).resolves.toBeUndefined();
    await expect(readTraceGrading(auth, { source: "production", traceId }))
      .resolves.toEqual({
        state: "not_requested",
        history: [],
        current: [],
        combinedScore: null,
      });
  });
});
