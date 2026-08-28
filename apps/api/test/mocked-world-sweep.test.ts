import { newId } from "@egma/ids";
import { createPersona, getRun, getSimulation } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { settleMockedWorlds } from "../src/mocked-world.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The sweep's two hard cases, both about a run that is `pending`.
 *
 * A mocked run's simulations are unclaimable until its world names a draft, so
 * a run whose build died leaves them queued forever — the sweep must find it
 * and cancel it (S2). But a run whose world is fully built and is merely
 * *waiting for a free simulator* is not stuck, and cancelling it for queue wait
 * would be a fate no other run in the product suffers (S3). One clock, two
 * answers, told apart by whether the draft exists.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const KEY = "retell-secret-A1B2C3D4WXYZ";

/** A Retell that only ever has to answer the delete a teardown might send. */
const RETELL: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  if (url.includes("/v2/list-agents")) {
    return json({
      items: [
        { agent_id: RETELL_AGENT, agent_name: "After hours", channel: "voice" },
      ],
      has_more: false,
    });
  }
  // A delete that should never be called in these tests: a stuck run has no
  // draft, and a built-world run waiting for a simulator is left alone.
  if (method === "DELETE") return json({ deleted: true });
  throw new Error(`the sweep test's Retell was asked something unexpected: ${method} ${url}`);
}) as typeof fetch;

const SWEEP_LOG = { error: () => undefined };

type Ready = {
  readonly ada: Customer;
  readonly agentId: string;
  readonly connectionId: string;
  readonly suiteId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
};

/** A ticked agent with a web-call connection and one test, all through the API. */
async function aTickedAgent(label: string): Promise<Ready> {
  api = await createApi(label, { retellFetch: RETELL });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "After hours",
    connection: {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: RETELL_AGENT },
      credentials: { apiKey: KEY },
      platformAgentId: RETELL_AGENT,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Regression",
  });
  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });
  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    name: "Books an appointment",
    scenario: "Wants the first free afternoon slot next week.",
    expectedBehaviors: ["confirms the time back before finishing"],
    suiteId: String(suite.body.id),
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const testRow = await api.database.sql<{ id: string; current_version_id: string }>(
    `select id, current_version_id from test where suite_id = $1 limit 1`,
    [String(suite.body.id)],
  );
  const personaRow = await api.database.sql<{ id: string; current_version_id: string }>(
    `select id, current_version_id from persona limit 1`,
  );

  return {
    ada,
    agentId,
    connectionId,
    suiteId: String(suite.body.id),
    testId: testRow.rows[0]!.id,
    testVersionId: testRow.rows[0]!.current_version_id,
    personaId: personaRow.rows[0]!.id,
    personaVersionId: personaRow.rows[0]!.current_version_id,
  };
}

/**
 * A run and one queued simulation, written straight into the store with a
 * chosen world and a chosen age.
 */
async function seedRun(
  ready: Ready,
  world: Record<string, unknown> | null,
  minutesOld: number,
): Promise<{ runId: string; simulationId: string }> {
  const runId = newId("run");
  const simulationId = newId("sim");
  const { organizationId, projectId } = contextFor(ready.ada, "member");
  await api.database.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, mock_tool_snapshot,
        mocked_world, expected_simulation_count, created_at)
     values ($1,$2,$3,$4,$5,$6,'pending','manual',$7::jsonb,$8::jsonb,$9::jsonb,1,
        now() - ($10 || ' minutes')::interval)`,
    [
      runId,
      organizationId,
      projectId,
      ready.suiteId,
      ready.agentId,
      ready.connectionId,
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        topology: "hosted-broker",
        environment: null,
        config: { retellAgentId: RETELL_AGENT },
      }),
      JSON.stringify({ defaults: [], overrides: {} }),
      world === null ? null : JSON.stringify(world),
      String(minutesOld),
    ],
  );
  await api.database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'voice','queued')`,
    [
      simulationId,
      runId,
      organizationId,
      projectId,
      ready.agentId,
      ready.connectionId,
      ready.personaId,
      ready.personaVersionId,
      ready.testId,
      ready.testVersionId,
    ],
  );
  return { runId, simulationId };
}

const MARKER = {
  servingVersion: 0,
  draftVersion: null,
  engine: { type: "", engineId: "", version: null },
  numbers: [],
  coverage: { mocked: [], notInterceptable: [], notInThisVersion: [] },
};

const BUILT = {
  servingVersion: 105,
  draftVersion: 106,
  engine: { type: "conversation-flow", engineId: "flow_1", version: 106 },
  numbers: [],
  coverage: { mocked: ["get_availability"], notInterceptable: [], notInThisVersion: [] },
};

describe("the sweep, over a run that is pending", () => {
  it("cancels a run whose build died before it named a draft", async () => {
    const ready = await aTickedAgent("sweep_cancels_stuck");
    // Its world is the building marker — the row a run wears while building,
    // with no draft — and it is twenty minutes old, well past the build window.
    const { runId, simulationId } = await seedRun(ready, MARKER, 20);
    const auth = contextFor(ready.ada, "member");

    await settleMockedWorlds(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    // The stuck run is canceled, so its unclaimable simulations stop waiting.
    expect((await getRun(auth, runId))?.status).toBe("canceled");
    expect((await getSimulation(auth, simulationId))?.status).toBe("canceled");
  });

  it("leaves a run alone whose world is built and is waiting for a simulator", async () => {
    const ready = await aTickedAgent("sweep_spares_waiting");
    // A fully built world — its draft exists — and just as old. This run is not
    // stuck; it is queued, waiting for a free simulator, and its clock is queue
    // wait, not a dead build.
    const { runId, simulationId } = await seedRun(ready, BUILT, 20);
    const auth = contextFor(ready.ada, "member");

    await settleMockedWorlds(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    // Untouched: still pending, its simulation still claimable, and its draft
    // never torn down. Cancelling it for queue wait would be a fate no other
    // run suffers.
    expect((await getRun(auth, runId))?.status).toBe("pending");
    expect((await getSimulation(auth, simulationId))?.status).toBe("queued");
    const after = await getRun(auth, runId);
    expect(after?.mockedWorld?.draftVersion).toBe(106);
  });

  it("does not cancel a stuck run that is still inside the build window", async () => {
    const ready = await aTickedAgent("sweep_young_stuck");
    // Same marker, but two minutes old — a build in flight, not a dead one.
    const { runId } = await seedRun(ready, MARKER, 2);
    const auth = contextFor(ready.ada, "member");

    await settleMockedWorlds(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    expect((await getRun(auth, runId))?.status).toBe("pending");
  });
});
