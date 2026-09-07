import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NotPermittedError,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  listSimulations,
  readSimulationUsage,
  recordProviderUsage,
  startRun,
  upsertRateCard,
  type AuthContext,
  type NewUsageRecord,
} from "../src/index.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Usage records, through the data-access module.
 *
 * Two organizations throughout, as every tenancy-touching suite here has: the
 * question a spend table has to answer correctly on its first day is whose
 * spend it is.
 */

let database: MigratedDatabase;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

function contextFor(
  who: typeof acme,
  role: "admin" | "member" | "viewer" = "member",
): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role,
    via: "session",
  };
}

/** One queued conversation, with everything a run needs around it. */
async function seedSimulation(who: typeof acme): Promise<{
  simulationId: string;
  runId: string;
}> {
  const auth = contextFor(who);
  const label = newId("run").slice(-8);
  const created = await createAgent(auth, {
    agentPlatform: "retell",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      identityName: "Sam Poole",
      personality: "Speaks plainly and asks one question at a time.",
      language: "en-US",
    })
  ).id;
  const suite = await createTestSuite(auth, { name: `Spend ${label}` });
  await createTest(auth, {
    suiteId: suite.id,
    name: `Reschedules ${label}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
  const started = await startRun(auth, {
    suiteId: suite.id,
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    idempotencyKey: newId("run"),
  });
  const simulation = (await listSimulations(auth, started.id))?.items[0];
  if (simulation === undefined) throw new Error("the run has no simulation");
  return { simulationId: simulation.id, runId: started.id };
}

const WHEN = new Date("2026-09-08T10:00:00.000Z");

function llmRecord(
  simulationId: string,
  runId: string,
  spanId: string,
  overrides: Partial<NewUsageRecord> = {},
): NewUsageRecord {
  return {
    identity: { work: "simulation", simulationId, spanId },
    occurredAt: WHEN,
    runId,
    traceId: "0198fb73d08e479627eea08a75fbf1d8",
    provider: "openai",
    model: "gpt-4o-mini",
    operation: "openai_chat_completions",
    quantities: {
      input_tokens: 1_000,
      cached_input_tokens: 400,
      output_tokens: 100,
    },
    measurement: "provider_reported",
    providerRef: "chatcmpl-1",
    paymentSource: "platform",
    rawUsage: { prompt_tokens: 1_400, completion_tokens: 100 },
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("usage_records");
  await upsertRateCard();
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p${who.projectId.slice(-6).toLowerCase()}` },
    ]);
    await seedUser(database, who.userId, `${who.userId}@example.test`);
  }
});

afterAll(async () => {
  await database.drop();
});

describe("one measured provider request", () => {
  it("is priced at the rate card and stored under the work's own tenancy", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    const written = await recordProviderUsage(contextFor(acme), [
      llmRecord(simulationId, runId, "aaaaaaaaaaaaaaa1"),
    ]);

    // 1,000 uncached tokens at $0.15/1M is 150 micros; 400 cached at $0.075/1M
    // is 30; 100 output at $0.60/1M is 60. The numbers are the published
    // prices, worked out by hand.
    expect(written).toEqual({ stored: 1, amountMicros: 240 });

    const { rows } = await database.sql<{
      organization_id: string;
      project_id: string;
      unit: string;
      amount_micros: string;
      priced_by: Record<string, string>;
      payment_source: string;
    }>(
      "select organization_id, project_id, unit, amount_micros, priced_by, payment_source " +
        "from usage_record where simulation_id = $1",
      [simulationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(acme.organizationId);
    expect(rows[0]?.project_id).toBe(acme.projectId);
    expect(rows[0]?.unit).toBe("tokens");
    expect(rows[0]?.payment_source).toBe("platform");
    expect(Object.keys(rows[0]?.priced_by ?? {}).sort()).toEqual([
      "cached_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
  });

  it("is stored once however many times the same one arrives", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    const record = llmRecord(simulationId, runId, "aaaaaaaaaaaaaaa2");

    const first = await recordProviderUsage(contextFor(acme), [record]);
    const again = await recordProviderUsage(contextFor(acme), [record]);

    expect(first.stored).toBe(1);
    expect(again).toEqual({ stored: 0, amountMicros: 0 });
    const usage = await readSimulationUsage(contextFor(acme), simulationId);
    expect(usage.requests).toBe(1);
  });

  it("is new spend when the same conversation is executed again", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    // A re-execution is a new simulation with new span ids. Same words, same
    // model, same provider reference — and correctly charged twice.
    const second = await seedSimulation(acme);
    await recordProviderUsage(contextFor(acme), [
      llmRecord(simulationId, runId, "bbbbbbbbbbbbbbb1"),
    ]);
    await recordProviderUsage(contextFor(acme), [
      llmRecord(second.simulationId, second.runId, "bbbbbbbbbbbbbbb2"),
    ]);

    expect(
      (await readSimulationUsage(contextFor(acme), simulationId)).amountMicros,
    ).toBe(240);
    expect(
      (await readSimulationUsage(contextFor(acme), second.simulationId))
        .amountMicros,
    ).toBe(240);
  });
});

describe("rating", () => {
  it("takes the newest price effective at or before the request", async () => {
    await upsertRateCard([
      {
        provider: "openai",
        model: "gpt-4o-mini",
        effectiveFrom: new Date("2026-09-09T00:00:00.000Z"),
        source: "https://developers.openai.com/api/docs/pricing",
        readAt: "2026-09-09",
        approximate: false,
        prices: [
          { usageType: "input_tokens", unit: "tokens", usdPerMillion: "1.50" },
        ],
      },
    ]);

    const before = await seedSimulation(acme);
    const after = await seedSimulation(acme);
    await recordProviderUsage(contextFor(acme), [
      {
        ...llmRecord(before.simulationId, before.runId, "ccccccccccccccc1"),
        quantities: { input_tokens: 1_000 },
      },
      {
        ...llmRecord(after.simulationId, after.runId, "ccccccccccccccc2"),
        occurredAt: new Date("2026-09-10T10:00:00.000Z"),
        quantities: { input_tokens: 1_000 },
      },
    ]);

    // The change applies from its own date forward and never backwards.
    expect(
      (await readSimulationUsage(contextFor(acme), before.simulationId))
        .amountMicros,
    ).toBe(150);
    expect(
      (await readSimulationUsage(contextFor(acme), after.simulationId))
        .amountMicros,
    ).toBe(1_500);
  });

  it("prices seconds of audio in the unit the provider bills", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    await recordProviderUsage(contextFor(acme), [
      {
        identity: { work: "simulation", simulationId, spanId: "ddddddddddddddd1" },
        occurredAt: WHEN,
        runId,
        provider: "deepgram",
        model: "nova-3-general",
        operation: "deepgram",
        quantities: { audio_seconds: 90 },
        measurement: "client_measured",
        paymentSource: "platform",
        rawUsage: {},
      },
    ]);
    const usage = await readSimulationUsage(contextFor(acme), simulationId);
    // 90 seconds at $0.0048 a minute is $0.0072, which is 7,200 micros.
    expect(usage.amountMicros).toBe(7_200);
    expect(usage.byModel[0]?.unit).toBe("seconds");
  });
});

describe("a simulation's cost, by provider and model", () => {
  it("sums the requests of each model and keeps their quantities", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    await recordProviderUsage(contextFor(acme), [
      llmRecord(simulationId, runId, "eeeeeeeeeeeeeee1"),
      llmRecord(simulationId, runId, "eeeeeeeeeeeeeee2"),
      {
        identity: { work: "simulation", simulationId, spanId: "eeeeeeeeeeeeeee3" },
        occurredAt: WHEN,
        runId,
        provider: "cartesia",
        model: "sonic-3.5",
        operation: "cartesia",
        quantities: { characters: 1_000 },
        measurement: "client_measured",
        paymentSource: "platform",
        rawUsage: {},
      },
    ]);

    const usage = await readSimulationUsage(contextFor(acme), simulationId);
    expect(usage.requests).toBe(3);
    // Two persona turns at 240 micros each, and 1,000 characters at $50/1M.
    expect(usage.amountMicros).toBe(480 + 50_000);
    expect(usage.byModel.map((one) => `${one.provider}/${one.model}`)).toEqual([
      "cartesia/sonic-3.5",
      "openai/gpt-4o-mini",
    ]);
    const llm = usage.byModel.find((one) => one.model === "gpt-4o-mini");
    expect(llm?.requests).toBe(2);
    expect(llm?.quantities).toEqual({
      input_tokens: 2_000,
      cached_input_tokens: 800,
      output_tokens: 200,
    });
  });

  it("is one organization's own, and never another's", async () => {
    const mine = await seedSimulation(acme);
    const theirs = await seedSimulation(globex);
    await recordProviderUsage(contextFor(acme), [
      llmRecord(mine.simulationId, mine.runId, "fffffffffffffff1"),
    ]);
    await recordProviderUsage(contextFor(globex), [
      llmRecord(theirs.simulationId, theirs.runId, "fffffffffffffff2"),
    ]);

    // Globex asking about Acme's conversation is answered about nothing —
    // the id is real and it is not theirs.
    expect(
      await readSimulationUsage(contextFor(globex), mine.simulationId),
    ).toEqual({ amountMicros: 0, requests: 0, byModel: [] });
    expect(
      (await readSimulationUsage(contextFor(globex), theirs.simulationId))
        .requests,
    ).toBe(1);
  });

  it("is readable by every role, and written by nobody read-only", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    await recordProviderUsage(contextFor(acme), [
      llmRecord(simulationId, runId, "999999999999999a"),
    ]);
    expect(
      (await readSimulationUsage(contextFor(acme, "viewer"), simulationId))
        .requests,
    ).toBe(1);
    await expect(
      recordProviderUsage(contextFor(acme, "viewer"), [
        llmRecord(simulationId, runId, "999999999999999b"),
      ]),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe("a grading job's requests", () => {
  it("are one record per HTTP attempt that answered, and a retry is new spend", async () => {
    const { simulationId, runId } = await seedSimulation(acme);
    const gradingJobId = newId("gjb");
    const projectGraderId = newId("grd");
    const judged = (
      attempts: number,
      httpAttempt: number,
      responseId: string,
    ): NewUsageRecord => ({
      identity: {
        work: "grading",
        gradingJobId,
        attempts,
        projectGraderId,
        assertion: "behavior_1",
        httpAttempt,
      },
      occurredAt: WHEN,
      runId,
      simulationId,
      provider: "openai",
      model: "gpt-5.6-terra",
      operation: "openai_chat_completions",
      quantities: { input_tokens: 1_000, output_tokens: 50 },
      measurement: "provider_reported",
      providerRef: responseId,
      paymentSource: "platform",
      rawUsage: { prompt_tokens: 1_000, completion_tokens: 50 },
    });

    // A first attempt that answered, a second HTTP attempt that also answered,
    // and then the whole job tried again.
    await recordProviderUsage(contextFor(acme), [
      judged(0, 1, "chatcmpl-a"),
      judged(0, 2, "chatcmpl-b"),
    ]);
    await recordProviderUsage(contextFor(acme), [judged(1, 1, "chatcmpl-c")]);
    // And the first delivery arriving again changes nothing.
    await recordProviderUsage(contextFor(acme), [judged(0, 1, "chatcmpl-a")]);

    const usage = await readSimulationUsage(contextFor(acme), simulationId);
    expect(usage.requests).toBe(3);
    // $2.00/1M in and $12.00/1M out: 2,000 + 600 micros per call.
    expect(usage.amountMicros).toBe(3 * 2_600);
  });
});
