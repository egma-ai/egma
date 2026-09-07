import { newId } from "@egma/ids";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appendSpans,
  claimGradingJobs,
  connect,
  connectClickHouse,
  createCustomLlmGrader,
  disconnect,
  disconnectClickHouse,
  finishGradingJob,
  reconcileGraderCatalog,
  readTraceGrades,
  regradeTrace,
  requestGrading,
  upsertRateCard,
  type AuthContext,
  type NewSpan,
} from "@egma/db";

import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../packages/db/test/support/clickhouse.ts";
import {
  seedOrganization,
  seedUser,
} from "../../../packages/db/test/support/tenancy.ts";
import { gradeClaim } from "../src/grade.ts";

/**
 * What grading costs, written down beside what it decided.
 *
 * The seam is the judge's own provider: a fake OpenAI that answers and says
 * what it consumed, exactly as the real one does. Everything between that
 * answer and the stored record is Egma's — the normalisation that separates
 * the cached prompt, the identity that makes a resend collapse, the rating —
 * and this suite drives all of it through `gradeClaim`, which is what the
 * worker calls.
 *
 * Two organizations, because a spend row filed under the wrong customer is the
 * one defect a billing table cannot recover from.
 */

let database: MigratedDatabase;
let store: MigratedTraceStore;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

const ACME_TRACE = "aaaa5555555555555555555555550001";
const GLOBEX_TRACE = "bbbb5555555555555555555555550002";
const STARTED_AT = new Date("2026-09-10T10:00:00.000Z");

function contextFor(who: typeof acme, userId: string): AuthContext {
  return {
    organizationId: who.organization,
    projectId: who.project,
    userId,
    role: "member",
    via: "session",
  };
}

const actingAsAcme = () => contextFor(acme, ada);
const actingAsGlobex = () => contextFor(globex, grace);

function conversation(traceId: string): NewSpan {
  return {
    traceId,
    spanId: "1111111111111111",
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "production",
    startedAtMicroseconds: BigInt(STARTED_AT.getTime()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "conversation",
    kind: "conversation",
    status: "ok",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "call-fixture",
    agentPlatform: "retell",
    platformAgentId: "agent-fixture",
    platformAgentName: "Front desk",
    platformAgentVersion: "",
    connectionType: "phone_number",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: true,
  };
}

function agentTurn(traceId: string): NewSpan {
  return {
    ...conversation(traceId),
    spanId: "2222222222222222",
    parentSpanId: "1111111111111111",
    name: "agent_turn",
    kind: "turn:agent",
    text: "We hold bookings for thirty days, and I have moved yours to Friday.",
    endsTrace: false,
  };
}

/** The provider's own answer shape, decision and usage together. */
function answered(usage: Record<string, unknown>, id: string): Response {
  return new Response(
    JSON.stringify({
      id,
      model: "gpt-5.6-terra-2026-08-01",
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "met",
              rationale: "the agent named the window.",
              cited_turns: [1],
            }),
          },
        },
      ],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const ORDINARY_USAGE = {
  prompt_tokens: 1_400,
  completion_tokens: 48,
  total_tokens: 1_448,
  prompt_tokens_details: { cached_tokens: 1_024 },
};

/** A provider that answers every request, saying what each one consumed. */
function providerAnswering(...responses: readonly (() => Response)[]): void {
  let at = 0;
  vi.stubGlobal("fetch", async () => {
    const next = responses[Math.min(at, responses.length - 1)];
    at += 1;
    if (next === undefined) throw new Error("nothing left to answer with");
    return next();
  });
}

const CREDENTIALS = {
  async load() {
    return { openai: "sk-egma-grader-usage-NEVERLEAKME" };
  },
};

type UsageRow = {
  organization_id: string;
  project_id: string;
  work_kind: string;
  grading_job_id: string;
  simulation_id: string | null;
  attempt: string;
  provider: string;
  model: string;
  operation: string;
  unit: string;
  quantities: Record<string, number>;
  measurement: string;
  provider_ref: string | null;
  amount_micros: string;
  trace_id: string | null;
};

async function usageOf(traceId: string): Promise<UsageRow[]> {
  const { rows } = await database.sql<UsageRow>(
    "select * from usage_record where trace_id = $1 order by created_at, id",
    [traceId],
  );
  return rows;
}

/** One custom LLM grader on one project, and one production trace to grade. */
async function seedGrader(auth: AuthContext, label: string): Promise<string> {
  const created = await createCustomLlmGrader(auth, {
    name: `Policy compliance ${label}`,
    description: "Grades one policy instruction.",
    gradingInstructions: "the agent stated the cancellation policy",
    passesWhen: "the agent names the 30-day window",
    failsWhen: "the agent ends the call without naming a window",
    scope: { simulations: [], production: { sample_percent: 100 } },
    passThreshold: 1,
  });
  return created.projectGrader.id;
}

beforeAll(async () => {
  database = await createMigratedDatabase("grader_judge_usage");
  store = await createMigratedTraceStore("grader_judge_usage");
  connect({
    databaseUrl: database.url,
    encryptionKey: TEST_ENCRYPTION_KEY,
    maxConnections: 4,
  });
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "acme" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "globex" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
  await reconcileGraderCatalog();
  // The prices a deployment boots with. Without them the records would still
  // be written and would all cost nothing, which is the failure the rate-card
  // coverage test exists to prevent and this suite must not hide.
  await upsertRateCard();

  await seedGrader(actingAsAcme(), "acme");
  await seedGrader(actingAsGlobex(), "globex");
  await appendSpans(actingAsAcme(), [
    conversation(ACME_TRACE),
    agentTurn(ACME_TRACE),
  ]);
  await appendSpans(actingAsGlobex(), [
    conversation(GLOBEX_TRACE),
    agentTurn(GLOBEX_TRACE),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await disconnectClickHouse();
  await disconnect();
  await store.drop();
  await database.drop();
});

async function claimFor(auth: AuthContext, traceId: string) {
  await requestGrading(auth, {
    source: "production",
    traceId,
    traceStartedAt: STARTED_AT,
    endsTrace: true,
    evidenceReady: true,
    modality: "voice",
  });
  const claims = await claimGradingJobs({
    claimant: `judge-usage-${traceId.slice(0, 4)}`,
    capacity: 50,
  });
  const claim = claims.find((one) => one.traceId === traceId);
  if (claim === undefined) throw new Error(`${traceId} was not claimed`);
  return claim;
}

describe("a graded trace", () => {
  it("writes what its judge cost beside what its judge decided", async () => {
    providerAnswering(() => answered(ORDINARY_USAGE, "chatcmpl-acme-1"));

    const claim = await claimFor(actingAsAcme(), ACME_TRACE);
    await expect(
      gradeClaim(claim, { providerCredentials: CREDENTIALS }),
    ).resolves.toMatchObject({ graders: 1, grades: 1 });

    const graded = await readTraceGrades(actingAsAcme(), {
      source: "production",
      traceId: ACME_TRACE,
    });
    expect(graded.current).toMatchObject([{ score: 1, result: "passed" }]);

    const spend = await usageOf(ACME_TRACE);
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({
      organization_id: acme.organization,
      project_id: acme.project,
      work_kind: "grading",
      grading_job_id: claim.id,
      // A production trace has no simulation and no run, and the record says so
      // rather than pointing at something that is not there.
      simulation_id: null,
      provider: "openai",
      operation: "openai_chat_completions",
      unit: "tokens",
      measurement: "provider_reported",
      provider_ref: "chatcmpl-acme-1",
    });
    // The cached part of the prompt is charged at the cached rate, separately.
    expect(spend[0]?.quantities).toEqual({
      input_tokens: 376,
      cached_input_tokens: 1_024,
      output_tokens: 48,
    });
    // The pinned catalog model prices it, not the dated variant the provider
    // said it served: Egma's catalog is closed and the rate card is keyed by
    // it. gpt-5.6-terra is $2.00/1M in, $0.20/1M cached, $12.00/1M out.
    expect(spend[0]?.model).toBe("gpt-5.6-terra");
    expect(Number(spend[0]?.amount_micros)).toBe(752 + 205 + 576);

    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });

  it("counts one record per HTTP attempt the provider answered", async () => {
    // A rate limit the judge retries through, then two answered attempts of
    // the one call. Both generated tokens, so both are spend.
    providerAnswering(
      () => new Response("slow down", { status: 429 }),
      () => answered({ prompt_tokens: 100, completion_tokens: 10 }, "chatcmpl-g-2"),
    );

    const claim = await claimFor(actingAsGlobex(), GLOBEX_TRACE);
    await gradeClaim(claim, { providerCredentials: CREDENTIALS });

    const spend = await usageOf(GLOBEX_TRACE);
    // One record: the 429 generated nothing, so there was nothing to bill.
    expect(spend).toHaveLength(1);
    expect(spend[0]?.organization_id).toBe(globex.organization);
    expect(Number(spend[0]?.attempt)).toBe(claim.attempts);

    // The same claim graded again against the same answers — the delivery a
    // retried store write is — stores nothing a second time: the job, its
    // attempt, the grader, the assertion, the HTTP attempt and the response id
    // are all the same request.
    vi.unstubAllGlobals();
    providerAnswering(
      () => new Response("slow down", { status: 429 }),
      () => answered({ prompt_tokens: 100, completion_tokens: 10 }, "chatcmpl-g-2"),
    );
    await gradeClaim(claim, { providerCredentials: CREDENTIALS });
    expect(await usageOf(GLOBEX_TRACE)).toHaveLength(1);

    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
  });

  it("is new spend when the whole job is graded again", async () => {
    const before = (await usageOf(ACME_TRACE)).length;

    // The same answer and the same response id as the first grading, so the
    // only thing that can make this a different request is the job's own
    // attempt counter — which a regrade moves.
    providerAnswering(() => answered(ORDINARY_USAGE, "chatcmpl-acme-1"));
    await expect(
      regradeTrace(actingAsAcme(), { source: "production", traceId: ACME_TRACE }),
    ).resolves.toMatchObject({ kind: "queued" });
    const regrade = await claimGradingJobs({
      claimant: "judge-usage-regrade",
      capacity: 50,
    });
    const claim = regrade.find((one) => one.traceId === ACME_TRACE);
    if (claim === undefined) throw new Error("the regrade was not claimed");
    await gradeClaim(claim, { providerCredentials: CREDENTIALS });
    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);

    // The provider really was asked again, so the money really was spent
    // again — even though the answer, the grader, the assertion and the
    // provider's own response id are all identical to the first grading. The
    // work is what makes the identity: a finished job's row is deleted, so a
    // regrade is a new job, and its requests are new spend.
    const after = await usageOf(ACME_TRACE);
    expect(after).toHaveLength(before + 1);
    expect(new Set(after.map((row) => row.grading_job_id)).size).toBe(2);
    expect(new Set(after.map((row) => row.provider_ref))).toEqual(
      new Set(["chatcmpl-acme-1"]),
    );
  });

  it("keeps one customer's spend out of the other's", async () => {
    const mine = await usageOf(ACME_TRACE);
    const theirs = await usageOf(GLOBEX_TRACE);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    for (const row of mine) expect(row.organization_id).toBe(acme.organization);
    for (const row of theirs) {
      expect(row.organization_id).toBe(globex.organization);
    }
  });
});
