import {
  appendVerdicts,
  claimSimulations,
  completeSimulation,
  listGraders,
  PREDEFINED_GRADERS,
  startSimulation,
} from "@egma/db";
import { newId } from "@egma/ids";
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

const RETELL = {
  agentPlatform: "retell",
  connectionKind: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_run_contract" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const PHONE = {
  agentPlatform: null,
  connectionKind: "phone_number",
  accessVariant: "phone_number.public_e164",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

const PHONE_IS_READY = {
  carrier_trunk_address: "egma-simulator-106e37f8.pstn.twilio.com",
  carrier_trunk_number: "+18885550123",
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
  connection: Record<string, unknown> = RETELL,
  options: TestApiOptions = {},
): Promise<ReadyRun> {
  api = await createApi(label, options);
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
  });
  expect(test.statusCode, JSON.stringify(test.body)).toBe(201);

  const registered = await request(api.app, "POST", "/v1/agents", key, {
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
  idempotencyKey = newId("run"),
): Promise<Answer> {
  return request(api.app, "POST", "/v1/runs", key, {
    suiteId: ready.suiteId,
    agentId: ready.agentId,
    connectionId: ready.connectionId,
    idempotencyKey: idempotencyKey,
  });
}

async function listedRunIds(key: string, query: string): Promise<readonly string[]> {
  const read = await request(api.app, "GET", `/v1/runs?${query}`, key);
  expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
  return (read.body.runs as Array<{ id: string }>).map((one) => one.id);
}

describe("suite-selected run reads", () => {
  it("keeps every active list filter exact", async () => {
    const ready = await readyToRun("run_suite_filters", RETELL, {
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

    const behaviorCopy = (await listGraders(auth)).items.find(
      (one) => one.libraryId === PREDEFINED_GRADERS.expectedBehaviors,
    );
    if (behaviorCopy === undefined) {
      throw new Error("the project has no expected-behaviors grader");
    }
    await appendVerdicts(auth, [{
      traceId: simulationId,
      graderId: behaviorCopy.id,
      graderVersionId: behaviorCopy.versionId,
      assertion: "behavior_1",
      source: "simulation",
      verdict: "passed",
      score: 1,
      rationale: "The agent confirmed the new time.",
      citedSpanIds: [],
      runId,
      agentId: ready.agentId,
      agentVersionId: "",
      judgedAtMicroseconds: BigInt(Date.now()) * 1000n,
    }]);

    const createdAt = new Date(String(started.body.createdAt));
    const matching = [
      ["suiteId", ready.suiteId],
      ["agentId", ready.agentId],
      ["connectionId", ready.connectionId],
      ["testId", ready.testId],
      ["status", "completed"],
      ["verdict", "passed"],
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
      ["verdict", "failed"],
      ["since", new Date(createdAt.getTime() + 1_000).toISOString()],
      ["until", new Date(createdAt.getTime() - 1_000).toISOString()],
    ] as const;
    for (const [field, value] of excluding) {
      const query = new URLSearchParams({ [field]: value }).toString();
      expect(await listedRunIds(ready.key, query), field).not.toContain(runId);
    }
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
      platformSettings: PHONE_IS_READY,
    });
    const started = await start(ready);
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      connectionKind: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
    });
  });
});

describe("run authorization", () => {
  it("lets a viewer read and follow, but only members of the owning organization start or cancel", async () => {
    const ready = await readyToRun("run_roles_and_tenants");
    const memberAttempt = "member-start-before-role-check";
    const started = await start(ready, ready.key, memberAttempt);
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
    // Replaying the member's successful key is still a start operation. A
    // later role reduction must take effect before the ledger is read.
    expect(
      (await start(ready, viewer.secret, memberAttempt)).statusCode,
    ).toBe(403);
    expect(
      (await request(api.app, "GET", `/v1/runs/${runId}`, viewer.secret))
        .statusCode,
    ).toBe(200);
    expect(await listedRunIds(viewer.secret, "pageSize=50")).toContain(runId);
    expect(
      (await request(
        api.app,
        "GET",
        `/v1/runs/${runId}/events?after=0`,
        viewer.secret,
      )).statusCode,
    ).toBe(200);
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
