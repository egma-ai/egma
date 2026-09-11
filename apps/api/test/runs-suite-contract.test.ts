import {
  claimSimulations,
  completeSimulation,
  startSimulation,
} from "@egma/db";
import { newId } from "@egma/ids";
import { fetchRunDetails } from "../../cli/src/platform/runs.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createApi,
  type TestApi,
  type TestApiOptions,
} from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  projectKeyFor,
  request,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const LIVEKIT_CHAT = {
  agentPlatform: "livekit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "chat",
  config: { url: "wss://fixture.livekit.cloud", agentName: "agent_in_retell_run_contract" },
  credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
} as const;

const PHONE = {
  agentPlatform: null,
  connectionType: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

const PHONE_IS_READY = {
  trunkAddress: "egma-simulator-106e37f8.pstn.twilio.com",
  sourceNumber: "+18885550123",
  trunkUsername: "egma-test-trunk",
  trunkPassword: "the-carrier-issued-this-one",
} as const;

type ReadyRun = {
  readonly customer: Customer;
  readonly key: string;
  readonly suiteId: string;
  readonly testId: string;
  readonly agentId: string;
  readonly connectionId: string;
};

async function readyToRun(
  label: string,
  connection: Record<string, unknown> = LIVEKIT_CHAT,
  options: TestApiOptions = {},
): Promise<ReadyRun> {
  api = await createApi(label, { traceStore: true, ...options });
  const customer = await signUp(api.app, `${label}@acme.example`, "Acme");
  const key = await projectKeyFor(api.app, customer);

  const suite = await request(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  const suiteId = String(suite.body.id);

  const test = await request(api.app, "POST", "/v1/tests", key, {
    suiteId: suiteId,
    name: "Reschedules a booking",
    scenario: "Move Thursday's booking to next week.",
    expectedBehaviors: ["confirms the new time before finishing"],
    personas: ["Everyday caller"],
  });
  expect(test.statusCode, JSON.stringify(test.body)).toBe(201);

  const registered = await request(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "livekit",
    name: "Front desk",
    connection,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agent = registered.body.agent as { id: string };
  const reached = registered.body.connection as { id: string };

  return {
    customer,
    key,
    suiteId,
    testId: String(test.body.id),
    agentId: agent.id,
    connectionId: reached.id,
  };
}

function start(
  ready: ReadyRun,
  key = ready.key,
): Promise<Answer> {
  return request(api.app, "POST", "/v1/runs", key, {
    suiteId: ready.suiteId,
    agentId: ready.agentId,
    connectionId: ready.connectionId,
  });
}

async function listedRunIds(key: string, query: string): Promise<readonly string[]> {
  const read = await request(api.app, "GET", `/v1/runs?${query}`, key);
  expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
  return (read.body.runs as Array<{ id: string }>).map((one) => one.id);
}

describe("suite-selected run reads", () => {
  it("keeps every active list filter exact", async () => {
    const ready = await readyToRun("run_suite_filters", LIVEKIT_CHAT, {
      traceStore: true,
    });
    const started = await start(ready);
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    const page = await request(
      api.app,
      "GET",
      `/v1/runs/${runId}/simulations`,
      ready.key,
    );
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
    const simulationId = String(
      (page.body.simulations as Array<{ id: string }>)[0]?.id,
    );

    const auth = contextFor(ready.customer, "member");
    const claimant = "run-suite-contract";
    const claimed = (await claimSimulations({ claimant, capacity: 50 }))
      .find((one) => one.id === simulationId);
    if (claimed === undefined) throw new Error("the run's simulation was not claimed");
    await startSimulation(auth, simulationId, claimant);
    await completeSimulation(auth, simulationId, claimant, {
      endingReason: "agent_ended",
    });

    const createdAt = new Date(String(started.body.createdAt));
    const matching = [
      ["suiteId", ready.suiteId],
      ["agentId", ready.agentId],
      ["connectionId", ready.connectionId],
      ["testId", ready.testId],
      ["status", "completed"],
      ["since", new Date(createdAt.getTime() - 1_000).toISOString()],
      ["until", new Date(createdAt.getTime() + 1_000).toISOString()],
    ] as const;
    for (const [field, value] of matching) {
      const query = new URLSearchParams({ [field]: value }).toString();
      expect(await listedRunIds(ready.key, query), field).toContain(runId);
    }

    const excluding = [
      ["suiteId", newId("ste")],
      ["agentId", newId("agt")],
      ["connectionId", newId("con")],
      ["testId", newId("tst")],
      ["status", "canceled"],
      ["since", new Date(createdAt.getTime() + 1_000).toISOString()],
      ["until", new Date(createdAt.getTime() - 1_000).toISOString()],
    ] as const;
    for (const [field, value] of excluding) {
      const query = new URLSearchParams({ [field]: value }).toString();
      expect(await listedRunIds(ready.key, query), field).not.toContain(runId);
    }

    const retired = await request(
      api.app,
      "GET",
      "/v1/runs?verdict=passed",
      ready.key,
    );
    expect(retired.statusCode).toBe(422);
  });
});

describe("run admission", () => {
  it("refuses an unready phone platform with zero writes and admits a ready one", async () => {
    const blocked = await readyToRun("run_phone_blocked", PHONE);
    const refused = await start(blocked);
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toBe("phone_setup_required");
    expect(await listedRunIds(blocked.key, "pageSize=1")).toEqual([]);
    const viewer = await colleagueOf(
      api.app,
      blocked.customer,
      "phone-viewer@acme.example",
      "viewer",
    );
    expect((await start(blocked, viewer.secret)).statusCode).toBe(403);

    await api.close();
    const ready = await readyToRun("run_phone_ready", PHONE, {
      carrierRoute: PHONE_IS_READY,
    });
    const started = await start(ready);
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
    });
  });
});

describe("run authorization", () => {
  it("lets a viewer read and follow, but only members of the owning organization start or cancel", async () => {
    const ready = await readyToRun("run_roles_and_tenants");
    const started = await start(ready);
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    const viewer = await colleagueOf(
      api.app,
      ready.customer,
      "viewer@acme.example",
      "viewer",
    );
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const globexKey = await projectKeyFor(api.app, grace);

    expect((await start(ready, viewer.secret)).statusCode).toBe(403);
    const detail = await request(
      api.app,
      "GET",
      `/v1/runs/${runId}`,
      viewer.secret,
    );
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.eventThrough).toBe(0);
    expect(await listedRunIds(viewer.secret, "pageSize=50")).toContain(runId);
    const events = await request(
      api.app,
      "GET",
      `/v1/runs/${runId}/events?after=0`,
      viewer.secret,
    );
    expect(events.statusCode, JSON.stringify(events.body)).toBe(200);
    expect(events.body.next).toBe(detail.body.eventThrough);
    expect(
      (await request(
        api.app,
        "POST",
        `/v1/runs/${runId}/cancel`,
        viewer.secret,
        {},
      )).statusCode,
    ).toBe(403);

    expect((await start(ready, globexKey)).statusCode).toBe(422);
    expect(await listedRunIds(globexKey, "pageSize=50")).toEqual([]);
    for (const [method, path] of [
      ["GET", `/v1/runs/${runId}`],
      ["GET", `/v1/runs/${runId}/events?after=0`],
      ["POST", `/v1/runs/${runId}/cancel`],
    ] as const) {
      const answer = await request(
        api.app,
        method,
        path,
        globexKey,
        method === "POST" ? {} : undefined,
      );
      expect(answer.statusCode, `${method} ${path}`).toBe(404);
    }
  });
});

describe("run concurrency contract", () => {
  it("defaults chat to ten, persists an override, and rejects invalid requests", async () => {
    const ready = await readyToRun("run_concurrency");
    const standard = await start(ready);
    expect(standard.statusCode).toBe(201);
    expect(standard.body.concurrency).toBe(10);
    const body = { suiteId: ready.suiteId, agentId: ready.agentId, connectionId: ready.connectionId };
    const custom = await request(api.app, "POST", "/v1/runs", ready.key, { ...body, concurrency: 100 });
    expect(custom.statusCode).toBe(201);
    expect(custom.body.concurrency).toBe(100);
    const read = await request(api.app, "GET", `/v1/runs/${String(custom.body.id)}`, ready.key);
    expect(read.body.concurrency).toBe(100);
    const details = await fetchRunDetails(
      { url: "https://egma.example", key: ready.key },
      { runId: String(custom.body.id), projectId: ready.customer.projectId },
      async (input, init) => {
        const url = new URL(String(input));
        const response = await api.app.inject({
          method: "GET", url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers)),
        });
        return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
      },
    );
    expect(details.run.concurrency).toBe(100);
    expect(details.simulations).toHaveLength(Number(custom.body.expectedSimulationCount));
    expect(details.simulations[0]?.test.scenario).toBe("Move Thursday's booking to next week.");
    expect(details.simulations[0]).toHaveProperty("gradeHistory");
    expect(details.simulations[0]).toHaveProperty("transcript");
    for (const concurrency of [0, -1, 1.5, "4", null, 2147483648]) {
      const refused = await request(api.app, "POST", "/v1/runs", ready.key, { ...body, concurrency });
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    }
    const listed = await request(api.app, "GET", "/v1/runs", ready.key);
    expect(listed.body.runs).toHaveLength(2);
  });
});
