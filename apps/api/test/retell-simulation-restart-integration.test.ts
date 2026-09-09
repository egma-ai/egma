import { afterAll, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  resolveRunStartReach,
  startRun,
  startSimulation,
  takeRetellSimulationCollectionLease,
} from "@egma/db";
import { buildApi } from "../src/server.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { drainPendingEvidence, pendingSegments } from "./support/ingestion.ts";
import { startObjectStorage } from "./support/object-storage.ts";
import { contextFor, projectKeyFor, request, signUp } from "./support/traces.ts";

const STARTED_AT = Date.parse("2026-09-08T17:00:00.000Z");
const ENDED_AT = Date.parse("2026-09-08T17:00:01.000Z");

const storage = await startObjectStorage("retell-simulation-restart");

afterAll(async () => { if (storage.available) storage.stop(); });

function runningStorage(): Extract<typeof storage, { available: true }> {
  if (!storage.available) throw new Error("the restart test has no object store");
  return storage;
}

it.runIf(storage.available)("a fresh API sweep recovers and stores a completed Retell call", async () => {
  let api: TestApi | undefined;
  let replacement: ReturnType<typeof buildApi> | undefined;
  let drainOnly: ReturnType<typeof buildApi> | undefined;
  let firstPulls = 0;
  try {
    api = await createApi("retell_simulation_restart", {
      traceStore: true,
      ingestStore: runningStorage().ingestStore,
      orphanSweepIntervalMilliseconds: 60 * 60_000,
      simulationPullOptions: { retryWaitsMilliseconds: [60_000] },
      retellReach: {
        fetchImpl: async () => {
          firstPulls += 1;
          return new Response(JSON.stringify({
            call_id: "call_restart",
            agent_id: "agent_restart",
            call_status: "ongoing",
            start_timestamp: STARTED_AT,
          }), { status: 200 });
        },
      },
    });
    const customer = await signUp(api.app, "restart@acme.example", "Acme");
    const auth = contextFor(customer, "member");
    const key = await projectKeyFor(api.app, customer);
    const agent = await createAgent(auth, {
      agentPlatform: "retell",
      name: "Restart front desk",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_restart" },
        credentials: { apiKey: "retell-restart-key-A1B2C3D4" },
      },
    });
    const persona = await createPersona(auth, {
      name: "Restart caller",
      identityName: "Rita",
      personality: "Patient",
      language: "en-US",
    });
    const suite = await createTestSuite(auth, { name: "Restart recovery" });
    await createTest(auth, {
      suiteId: suite.id,
      name: "Recovers",
      scenario: "Ask for help.",
      expectedBehaviors: ["answers"],
      personaIds: [persona.id],
    });
    const connectionId = agent.connection?.id ?? "";
    const reach = await resolveRunStartReach(auth, agent.id, connectionId);
    if (reach === undefined) throw new Error("the Retell connection has no run reach");
    const run = await startRun(auth, {
      suiteId: suite.id,
      agentId: agent.id,
      connectionId,
      agentVersion: 1,
      conductedConnectionIdentity: reach.connectionIdentity,
    });
    const claim = (await claimSimulations({ claimant: "restart-simulator", capacity: 1 }))[0];
    if (claim === undefined) throw new Error("no simulation was claimed");
    await startSimulation(auth, claim.id, "restart-simulator");
    const landed = await api.app.inject({
      method: "POST",
      url: `/v1/simulations/${claim.id}/reports`,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: {
        contract_version: 1,
        simulation_id: claim.id,
        events: [{
          kind: "status",
          event_id: "evt_retell_restart_completed",
          at: new Date(ENDED_AT).toISOString(),
          status: "completed",
          reason: null,
          facts: {
            ending: "agent_ended",
            started_at: new Date(STARTED_AT).toISOString(),
            ended_at: new Date(ENDED_AT).toISOString(),
            turn_count: 2,
            audio: null,
            provider_reference: "call_restart",
          },
        }],
      },
    });
    expect(landed.statusCode, landed.body).toBe(200);
    expect(firstPulls).toBe(1);

    // The report route holds the database lease while its incomplete record
    // waits in the background. Another replica sees no ownership to take.
    expect(await takeRetellSimulationCollectionLease(auth, claim.id)).toBeUndefined();

    await api.app.close();
    let drainRolePulls = 0;
    drainOnly = buildApi({
      config: {
        ...api.config,
        ingestion: { ...api.config.ingestion, role: "drain" },
      },
      orphanSweepIntervalMilliseconds: 5,
      retellReach: {
        fetchImpl: async () => {
          drainRolePulls += 1;
          return new Response("{}", { status: 500 });
        },
      },
      retellProductionIngestionIntervalMilliseconds: 5,
    });
    await drainOnly.app.ready();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(drainRolePulls).toBe(0);
    await drainOnly.app.close();
    drainOnly = undefined;

    replacement = buildApi({
      config: api.config,
      drainsPendingEvidence: false,
      orphanSweepIntervalMilliseconds: 5,
      retellReach: {
        fetchImpl: async () => new Response(JSON.stringify({
          call_id: "call_restart",
          agent_id: "agent_restart",
          call_status: "ended",
          start_timestamp: STARTED_AT,
          end_timestamp: ENDED_AT,
          transcript_with_tool_calls: [
            { role: "user", content: "Can you help?" },
            { role: "agent", content: "Yes." },
          ],
        }), { status: 200 }),
      },
      simulationPullOptions: { retryWaitsMilliseconds: [] },
      retellProductionIngestionIntervalMilliseconds: 60 * 60_000,
    });
    await replacement.app.ready();

    await expect.poll(
      async () => (await pendingSegments(runningStorage().ingestStore)).length,
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(2);
    await drainPendingEvidence(runningStorage().ingestStore);
    const store = api.traceStore;
    if (store === undefined) throw new Error("trace store was not started");
    await expect.poll(async () => {
      const [stored] = await store.rows<{ n: string }>(
        `select countDistinct(span_id) as n from spans final
         where run_id = '${run.id}' and emitter = 'agent' and provider_call_id = 'call_restart'`,
      );
      return Number(stored?.n);
    }, { timeout: 5_000 }).toBe(3);
    await expect.poll(async () => {
      const detail = await request(
        replacement!.app,
        "GET",
        `/v1/simulations/${claim.id}`,
        key,
      );
      const turns = (detail.body.transcript as { turns?: Array<{ kind?: string }> } | undefined)?.turns ?? [];
      return {
        status: detail.body.status,
        agentPovComplete: detail.body.agentPovComplete,
        human: turns.some((turn) => turn.kind === "turn:human"),
        agent: turns.some((turn) => turn.kind === "turn:agent"),
      };
    }, { timeout: 5_000 }).toEqual({
      status: "completed",
      agentPovComplete: true,
      human: true,
      agent: true,
    });
  } finally {
    await drainOnly?.app.close();
    await replacement?.app.close();
    await api?.close();
  }
});
