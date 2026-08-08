import {
  createPersona,
  getSimulation,
  removeConnection,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptsServiceToken,
  SERVICE_TOKEN_PREFIX,
} from "../src/auth/service-token.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { fixedWindowRateLimit } from "../src/http/rate-limit.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The simulator's claim door, over real HTTP against real Postgres.
 *
 * This is the one route a customer credential can never open: the service
 * token is the whole gate, the claim reaches every customer's queue at once,
 * and what comes back is the fully assembled spec — credentials included —
 * that the shipped simulator conducts from. So what is asserted here is what
 * that simulator observes: the token gate's one sentence, the held claim
 * answering the moment work arrives, every outgoing spec speaking the
 * contract, and a budget that belongs to no organization being spent by none.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

const RETELL = {
  type: "retell",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** One claim as the simulator makes it, with whatever token the test says. */
async function claim(
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
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
  agentId: string;
  connectionId: string;
  versionId: string;
}> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  // The persona is authored at the seam — no route ships for one — and the
  // test then names her, which is what the claimed spec's traits come from.
  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });
  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    ...RESCHEDULING,
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    agentId,
    connectionId,
    versionId: String(pushed.body.version_id),
  };
}

/** A run over the customer's connection, whose simulation lands queued. */
async function aQueuedRun(
  key: string,
  connectionId: string,
  versionId: string,
): Promise<{ runId: string; simulationId: string }> {
  const started = await ask(api.app, "POST", "/api/runs", key, {
    connection: connectionId,
    test_versions: [versionId],
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const simulations = started.body.simulations as { id: string }[];
  const first = simulations[0];
  if (first === undefined) throw new Error("the run has no simulation");
  return { runId: String(started.body.id), simulationId: first.id };
}

describe("the token gate", () => {
  it("refuses a missing, wrong, unprefixed or customer token with one actionable sentence", async () => {
    const { key } = await aCustomerReadyToRun("claims_gate");

    const refusals = await Promise.all([
      claim(undefined, { claimant: "sim-1", capacity: 1, wait_seconds: 0 }),
      claim("egma_st_not-the-configured-one", {
        claimant: "sim-1",
        capacity: 1,
        wait_seconds: 0,
      }),
      claim("unprefixed-token", { claimant: "sim-1", capacity: 1, wait_seconds: 0 }),
      // A customer's own real key: a credential for reading their data,
      // and exactly the thing this door must never widen into claiming.
      claim(key, { claimant: "sim-1", capacity: 1, wait_seconds: 0 }),
    ]);

    for (const refused of refusals) {
      expect(refused.statusCode).toBe(401);
      expect(refused.body.error).toBe("not_authenticated");
      expect(String(refused.body.message)).toContain(
        "EGMA_SIMULATOR_SERVICE_TOKEN",
      );
    }
  });

  it("compares tokens in constant time, hashing both sides first", () => {
    const configured = `${SERVICE_TOKEN_PREFIX}the-configured-secret`;
    expect(
      acceptsServiceToken(`Bearer ${configured}`, configured),
    ).toBe(true);
    expect(
      acceptsServiceToken(`Bearer ${SERVICE_TOKEN_PREFIX}wrong`, configured),
    ).toBe(false);
    // Different lengths must answer false rather than throw: the hash is
    // what equalises them before the constant-time compare.
    expect(
      acceptsServiceToken(
        `Bearer ${SERVICE_TOKEN_PREFIX}${"x".repeat(200)}`,
        configured,
      ),
    ).toBe(false);
    expect(acceptsServiceToken("Bearer unprefixed", configured)).toBe(false);
    expect(acceptsServiceToken(undefined, configured)).toBe(false);
  });
});

describe("claiming work", () => {
  it("answers a queued simulation as a schema-valid spec, credentials included", async () => {
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_spec");
    const { runId, simulationId } = await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);

    const specs = answered.body.specs as Record<string, unknown>[];
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    if (spec === undefined) throw new Error("no spec came back");

    // The whole point of validating on the way out: what leaves this door is
    // exactly what the simulator's own check will accept.
    expect(specComplaints(spec)).toEqual([]);

    expect(spec.contract_version).toBe(1);
    expect(spec.simulation_id).toBe(simulationId);
    expect(spec.modality).toBe("chat");
    expect(spec.connection).toEqual({
      type: "retell",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    expect(spec.persona).toEqual({ traits: NEUTRAL_TRAITS });
    expect(spec.scenario).toEqual({ instructions: RESCHEDULING.scenario });
    expect(spec.limits).toEqual({ max_duration_seconds: 600, max_turns: 60 });

    // The row carries the claim, and the run has started.
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("claimed");
    expect(row?.claimedBy).toBe("sim-under-test");
    expect(row?.heartbeatAt).toBeInstanceOf(Date);

    const header = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    expect(header.body.status).toBe("running");
  });

  it("splits one queue between two claimants without handing anything out twice", async () => {
    const { key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_race");
    await aQueuedRun(key, connectionId, versionId);
    await aQueuedRun(key, connectionId, versionId);

    const [blue, green] = await Promise.all([
      claim(api.config.simulatorServiceToken, {
        claimant: "simulator-blue-1",
        capacity: 2,
        wait_seconds: 0,
      }),
      claim(api.config.simulatorServiceToken, {
        claimant: "simulator-green-2",
        capacity: 2,
        wait_seconds: 0,
      }),
    ]);

    const taken = [
      ...(blue.body.specs as { simulation_id: string }[]),
      ...(green.body.specs as { simulation_id: string }[]),
    ].map((spec) => spec.simulation_id);
    expect(taken).toHaveLength(2);
    expect(new Set(taken).size).toBe(2);
  });

  it("clamps capacity at fifty rather than refusing a large fleet", async () => {
    api = await createApi("claims_clamp");
    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-1",
      capacity: 500,
      wait_seconds: 0,
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.body.specs).toEqual([]);
  });

  it("refuses a body it cannot read, saying what to send instead", async () => {
    api = await createApi("claims_body");
    const token = api.config.simulatorServiceToken;

    const noClaimant = await claim(token, { capacity: 1, wait_seconds: 0 });
    expect(noClaimant.statusCode).toBe(400);
    expect(noClaimant.body.error).toBe("invalid_request");
    expect(String(noClaimant.body.message)).toContain("claimant");

    const badCapacity = await claim(token, {
      claimant: "sim-1",
      capacity: 0,
      wait_seconds: 0,
    });
    expect(badCapacity.statusCode).toBe(400);
    expect(String(badCapacity.body.message)).toContain("capacity");

    const badWait = await claim(token, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: "soon",
    });
    expect(badWait.statusCode).toBe(400);
    expect(String(badWait.body.message)).toContain("wait_seconds");
  });
});

describe("the held claim", () => {
  it("answers within about a second of a simulation being queued", async () => {
    const { key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_hold");

    const asked = Date.now();
    const holding = claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 20,
    });

    // Work arrives while the claim is being held open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await aQueuedRun(key, connectionId, versionId);

    const answered = await holding;
    const waited = Date.now() - asked;

    expect(answered.statusCode).toBe(200);
    expect(answered.body.specs as unknown[]).toHaveLength(1);
    // Well before the twenty seconds asked for: the hold noticed the queue
    // fill on its ~1s re-check rather than sitting out the request.
    expect(waited).toBeLessThan(8_000);
  });

  it("bounds the hold by the client's own wait_seconds", async () => {
    api = await createApi("claims_bounded");

    const asked = Date.now();
    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 1,
    });
    const waited = Date.now() - asked;

    expect(answered.statusCode).toBe(200);
    expect(answered.body.specs).toEqual([]);
    // Held about the one second asked for — never the 15s default, never
    // the 25s cap — so a short-waiting client cannot see a timeout.
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(6_000);
  });

  it("answers an empty queue at once when the client will not wait", async () => {
    api = await createApi("claims_no_wait");

    const asked = Date.now();
    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });

    expect(answered.statusCode).toBe(200);
    expect(answered.body.specs).toEqual([]);
    expect(Date.now() - asked).toBeLessThan(2_000);
  });
});

describe("what the claim door never touches", () => {
  it("spends no organization's request budget, and no budget stops a claim", async () => {
    // A budget of three, so the ceiling is reachable by hand.
    api = await createApi("claims_budget", {
      rateLimit: fixedWindowRateLimit({ limit: 3, windowMilliseconds: 60_000 }),
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    // Claims beyond any organization's budget, every one answered.
    for (let i = 0; i < 6; i += 1) {
      const answered = await claim(api.config.simulatorServiceToken, {
        claimant: "sim-1",
        capacity: 1,
        wait_seconds: 0,
      });
      expect(answered.statusCode).toBe(200);
    }

    // The organization's own budget is untouched by all of that…
    const read = await ask(api.app, "GET", "/api/agents", key);
    expect(read.statusCode).toBe(200);

    // …and once the organization does spend it, the claim door is unmoved.
    let refused = 0;
    for (let i = 0; i < 6; i += 1) {
      const answer = await ask(api.app, "GET", "/api/agents", key);
      if (answer.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);

    const stillClaims = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
    });
    expect(stillClaims.statusCode).toBe(200);
  });
});

describe("a simulation the platform cannot hand over", () => {
  it("lands as dispatch_failed at once, while the rest of the batch still dispatches", async () => {
    const { ada, key, agentId, connectionId, versionId } =
      await aCustomerReadyToRun("claims_skip");

    // Two runs over two connections; one connection disappears before the
    // claim, so one spec can be assembled and one cannot.
    const doomed = await aQueuedRun(key, connectionId, versionId);
    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Second desk",
      connection: { ...RETELL, config: { retellAgentId: "agent_in_retell_2" } },
    });
    const secondConnection = (registered.body.connection as { id: string }).id;
    const healthy = await aQueuedRun(key, secondConnection, versionId);

    await removeConnection(contextFor(ada, "member"), agentId, connectionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    expect(answered.statusCode).toBe(200);

    const specs = answered.body.specs as { simulation_id: string }[];
    expect(specs.map((spec) => spec.simulation_id)).toEqual([
      healthy.simulationId,
    ]);

    // The unbuildable row landed terminal at claim time: failed with the
    // platform's own reason, never blamed on the simulator, never left for
    // the sweep to misname orphaned — and never back through the queue, so a
    // second ask does not see it again.
    const row = await getSimulation(contextFor(ada, "member"), doomed.simulationId);
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("dispatch_failed");
    expect(row?.endedAt).toBeInstanceOf(Date);

    const again = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    expect(again.body.specs).toEqual([]);

    // That landing was the doomed run's last outstanding conversation, so
    // the run settles now, with counts that say what happened.
    const header = await ask(api.app, "GET", `/api/runs/${doomed.runId}`, key);
    expect(header.body.status).toBe("completed");
    expect(header.body.completed_count).toBe(0);
    expect(header.body.failed_count).toBe(1);
    expect(header.body.canceled_count).toBe(0);
  });

  it("lands a credential that will not unseal the same way, and the batch dispatches whole", async () => {
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_corrupt");

    const doomed = await aQueuedRun(key, connectionId, versionId);
    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Second desk",
      connection: { ...RETELL, config: { retellAgentId: "agent_in_retell_2" } },
    });
    const secondConnection = (registered.body.connection as { id: string }).id;
    const healthy = await aQueuedRun(key, secondConnection, versionId);

    // The one write no seam should offer: a sealed envelope replaced with
    // bytes that will never decrypt, which is what a lost encryption key or
    // a hand-edited row leaves behind. Unsealing it throws rather than
    // answering empty, and that throw must cost one row, not the batch.
    await api.database.sql(
      "update connection set credentials = 'not-an-envelope-at-all' where id = $1",
      [connectionId],
    );

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    expect(answered.statusCode).toBe(200);

    const specs = answered.body.specs as { simulation_id: string }[];
    expect(specs.map((spec) => spec.simulation_id)).toEqual([
      healthy.simulationId,
    ]);

    // The unopenable row took the same honest landing — the throw cost one
    // row its dispatch, and the batch around it went out whole.
    const row = await getSimulation(
      contextFor(ada, "member"),
      doomed.simulationId,
    );
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("dispatch_failed");
  });
});
