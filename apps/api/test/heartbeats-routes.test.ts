import {
  claimSimulations,
  completeSimulation,
  createPersona,
  failSimulationDispatch,
  getSimulation,
  startSimulation,
  type SimulationClaim,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { HEARTBEATS_PATH } from "../src/routes/heartbeats.ts";
import { fixedWindowRateLimit } from "../src/http/rate-limit.ts";
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
 * The simulator's heartbeat door, over real HTTP against real Postgres.
 *
 * What is asserted here is what the shipped simulator observes: the token
 * gate's one sentence, a `directive` that is `null` while the conversation is
 * the claimant's to conduct and `"cancel"` the moment it is not — requested
 * cancellation and every row beyond help answering alike, because the
 * simulator obeys exactly one directive and must stop conducting closed
 * conversations. There is deliberately no 404 anywhere in the matrix, and no
 * organization's request budget moves.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const SIMULATOR = "sim-under-test";

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expectedBehaviors: ["confirms the new time back before finishing"],
} as const;

const RETELL = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** One beat as the simulator sends it, with whatever token the test says. */
async function beat(
  token: string | undefined,
  simulationId: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "POST",
    url: HEARTBEATS_PATH.replace(":simulationId", simulationId),
    ...(token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${token}` } }),
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

/** A customer with an agent, a persona, and a test — everything a run needs. */
async function aCustomerReadyToRun(label: string): Promise<{
  ada: Customer;
  key: string;
  connectionId: string;
  versionId: string;
}> {
  // A terminal completed simulation has the protected Expected behaviors
  // grader in its frozen plan, so completion probes the real trace store before
  // it can create work. This steering suite needs an empty store, not evidence.
  api = await createApi(label, { traceStore: true });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "Front desk",
    connection: RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  const suiteId = String(suite.body.id);

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });
  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    ...RESCHEDULING,
    suiteId,
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    connectionId,
    versionId: String(pushed.body.versionId),
  };
}

/** A run whose one simulation lands queued, ready to be claimed. */
async function aQueuedRun(
  key: string,
  connectionId: string,
  versionId: string,
): Promise<{ runId: string; simulationId: string }> {
  const version = await ask(
    api.app,
    "GET",
    `/v1/test-versions/${versionId}`,
    key,
  );
  expect(version.statusCode, JSON.stringify(version.body)).toBe(200);
  const agents = await ask(api.app, "GET", "/v1/agents?pageSize=200", key);
  expect(agents.statusCode, JSON.stringify(agents.body)).toBe(200);
  const agent = (agents.body.agents as Array<{
    id: string;
    connections: Array<{ id: string }>;
  }>).find((one) => one.connections.some((connection) => connection.id === connectionId));
  if (agent === undefined) throw new Error("the connection has no agent");

  const started = await ask(api.app, "POST", "/v1/runs", key, {
    suiteId: String(version.body.suiteId),
    agentId: agent.id,
    connectionId,
    idempotencyKey: newId("run"),
    expectedTestVersions: [{
      testId: String(version.body.testId),
      versionId,
    }],
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const page = await ask(
    api.app,
    "GET",
    `/v1/runs/${String(started.body.id)}/simulations?pageSize=1`,
    key,
  );
  expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
  const simulations = page.body.simulations as { id: string }[];
  const first = simulations[0];
  if (first === undefined) throw new Error("the run has no simulation");
  return { runId: String(started.body.id), simulationId: first.id };
}

/** A queued run claimed by the simulator under test, as the claim door would. */
async function aClaimedRun(
  key: string,
  connectionId: string,
  versionId: string,
): Promise<{ runId: string; simulationId: string; claim: SimulationClaim }> {
  const queued = await aQueuedRun(key, connectionId, versionId);
  const claims = await claimSimulations({ claimant: SIMULATOR, capacity: 50 });
  const claim = claims.find((one) => one.id === queued.simulationId);
  if (claim === undefined) throw new Error("the claim missed the run under test");
  return { ...queued, claim };
}

describe("the token gate", () => {
  it("refuses a missing, wrong, unprefixed or customer token with one actionable sentence", async () => {
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("beats_gate");
    const { simulationId } = await aClaimedRun(key, connectionId, versionId);

    // An old stamp first, so "the refused request wrote nothing" is a fact
    // about the row rather than an assumption.
    await api.database.sql(
      "update simulation set heartbeat_at = now() - interval '60 seconds' where id = $1",
      [simulationId],
    );
    const before = await getSimulation(contextFor(ada, "member"), simulationId);

    const refusals = await Promise.all([
      beat(undefined, simulationId, { claimant: SIMULATOR }),
      beat("egma_st_not-the-configured-one", simulationId, {
        claimant: SIMULATOR,
      }),
      beat("unprefixed-token", simulationId, { claimant: SIMULATOR }),
      // A customer's own real key: a credential for reading their data, and
      // exactly the thing this door must never answer a directive to.
      beat(key, simulationId, { claimant: SIMULATOR }),
    ]);

    for (const refused of refusals) {
      expect(refused.statusCode).toBe(401);
      expect(refused.body.error).toBe("not_authenticated");
      expect(String(refused.body.message)).toContain(
        "EGMA_SIMULATOR_SERVICE_TOKEN",
      );
    }

    // And none of them stamped the row.
    const after = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(after?.heartbeatAt).toEqual(before?.heartbeatAt);
  });
});

describe("a malformed beat", () => {
  it("is a 400 saying what to send, and never a directive", async () => {
    api = await createApi("beats_body");
    const token = api.config.simulatorServiceToken;
    const anywhere = newId("sim");

    const missing = await beat(token, anywhere, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe("invalid_request");
    expect(String(missing.body.message)).toContain("claimant");

    const empty = await beat(token, anywhere, { claimant: "   " });
    expect(empty.statusCode).toBe(400);
    expect(empty.body.error).toBe("invalid_request");

    const endless = await beat(token, anywhere, {
      claimant: "x".repeat(201),
    });
    expect(endless.statusCode).toBe(400);
    expect(String(endless.body.message)).toContain("200");
  });
});

describe("the steering matrix", () => {
  it("answers null to the claimant of a live conversation, and stamps the row", async () => {
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("beats_alive");
    const { simulationId } = await aClaimedRun(key, connectionId, versionId);

    // An old stamp first, so the beat's advance is observable.
    await api.database.sql(
      "update simulation set heartbeat_at = now() - interval '60 seconds' where id = $1",
      [simulationId],
    );

    const claimed = await beat(api.config.simulatorServiceToken, simulationId, {
      claimant: SIMULATOR,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.body).toEqual({ directive: null });

    const stamped = await getSimulation(
      contextFor(ada, "member"),
      simulationId,
    );
    expect(Date.now() - (stamped?.heartbeatAt?.getTime() ?? 0)).toBeLessThan(
      10_000,
    );

    // And the same once the conversation is underway.
    await startSimulation(contextFor(ada, "member"), simulationId, SIMULATOR);
    const running = await beat(api.config.simulatorServiceToken, simulationId, {
      claimant: SIMULATOR,
    });
    expect(running.body).toEqual({ directive: null });
  });

  it("carries a requested cancellation on the next beat", async () => {
    const { key, connectionId, versionId } =
      await aCustomerReadyToRun("beats_cancel");
    const { runId, simulationId } = await aClaimedRun(
      key,
      connectionId,
      versionId,
    );

    // The cancel arrives the way a person sends one: through the run's own
    // cancel route, while the simulator holds the conversation.
    const canceled = await ask(
      api.app,
      "POST",
      `/v1/runs/${runId}/cancel`,
      key,
    );
    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);

    const answered = await beat(
      api.config.simulatorServiceToken,
      simulationId,
      { claimant: SIMULATOR },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.body).toEqual({ directive: "cancel" });
  });

  it("answers cancel for every simulation beyond help, and 404 to nobody", async () => {
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("beats_beyond_help");
    const token = api.config.simulatorServiceToken;

    // Unknown: an id this egma never issued.
    const unknown = await beat(token, newId("sim"), { claimant: SIMULATOR });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toEqual({ directive: "cancel" });

    // Queued: nobody's to conduct yet, so nobody's to beat for.
    const queued = await aQueuedRun(key, connectionId, versionId);
    const unclaimed = await beat(token, queued.simulationId, {
      claimant: SIMULATOR,
    });
    expect(unclaimed.body).toEqual({ directive: "cancel" });

    // Another claimant's row: told to stop, and the row left unstamped so
    // the real claimant's silence still counts.
    const held = await aClaimedRun(key, connectionId, versionId);
    await api.database.sql(
      "update simulation set heartbeat_at = now() - interval '60 seconds' where id = $1",
      [held.simulationId],
    );
    const before = await getSimulation(
      contextFor(ada, "member"),
      held.simulationId,
    );
    const foreign = await beat(token, held.simulationId, {
      claimant: "some-other-simulator",
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.body).toEqual({ directive: "cancel" });
    const after = await getSimulation(
      contextFor(ada, "member"),
      held.simulationId,
    );
    expect(after?.heartbeatAt).toEqual(before?.heartbeatAt);

    // Terminal: the record already closed this conversation, so even its own
    // claimant is steered to stop.
    await startSimulation(contextFor(ada, "member"), held.simulationId, SIMULATOR);
    await completeSimulation(
      contextFor(ada, "member"),
      held.simulationId,
      SIMULATOR,
      { endingReason: "persona_concluded" },
    );
    const late = await beat(token, held.simulationId, { claimant: SIMULATOR });
    expect(late.statusCode).toBe(200);
    expect(late.body).toEqual({ directive: "cancel" });

    // And the platform's own landing is terminal like any other: a claimed
    // simulation that could not be handed over reads dispatch_failed on the
    // row, and its claimant's next beat is steered to stop the same way.
    const doomed = await aClaimedRun(key, connectionId, versionId);
    await failSimulationDispatch(
      doomed.claim.auth,
      doomed.claim.id,
      doomed.claim.claimedBy,
    );
    const undispatched = await beat(token, doomed.simulationId, {
      claimant: SIMULATOR,
    });
    expect(undispatched.statusCode).toBe(200);
    expect(undispatched.body).toEqual({ directive: "cancel" });
  });
});

describe("what the heartbeat door never touches", () => {
  it("spends no organization's request budget, and no budget stops a beat", async () => {
    // A budget of three, so the ceiling is reachable by hand.
    api = await createApi("beats_budget", {
      rateLimit: fixedWindowRateLimit({ limit: 3, windowMilliseconds: 60_000 }),
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const token = api.config.simulatorServiceToken;

    // Beats beyond any organization's budget, every one answered. The row
    // does not exist, which is the cheapest beat there is — and still a 200.
    for (let i = 0; i < 6; i += 1) {
      const answered = await beat(token, newId("sim"), { claimant: SIMULATOR });
      expect(answered.statusCode).toBe(200);
    }

    // The organization's own budget is untouched by all of that…
    const read = await ask(api.app, "GET", "/v1/agents", key);
    expect(read.statusCode).toBe(200);

    // …and once the organization does spend it, the heartbeat door is unmoved.
    let refused = 0;
    for (let i = 0; i < 6; i += 1) {
      const answer = await ask(api.app, "GET", "/v1/agents", key);
      if (answer.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);

    const stillBeats = await beat(token, newId("sim"), { claimant: SIMULATOR });
    expect(stillBeats.statusCode).toBe(200);
  });
});
