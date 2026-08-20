import { newId } from "@egma/ids";
import {
  createPersona,
  getSimulation,
  listRunEvents,
  SPEED_RANGE,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import { ProviderCredentialSourceUnavailableError } from "@egma/provider-credentials";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptsServiceToken,
  SERVICE_TOKEN_PREFIX,
} from "../src/auth/service-token.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { fixedWindowRateLimit } from "../src/http/rate-limit.ts";
import {
  createApi,
  type TestApi,
  type TestApiOptions,
} from "./support/api.ts";
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
  vi.restoreAllMocks();
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

const LIVEKIT = {
  type: "livekit",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

const PHONE = {
  type: "phone",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

/** The ordinary direct Retell target in these route tests is a chat agent. */
const RETELL_CHAT_FETCH: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.includes("/v2/list-agents")) {
    throw new Error(`Unexpected Retell read: ${url}`);
  }
  return new Response(
    JSON.stringify({
      items: [
        { agent_id: "agent_in_retell_1", agent_name: "Front desk", channel: "chat" },
        { agent_id: "agent_in_retell_2", agent_name: "Second desk", channel: "chat" },
      ],
      has_more: false,
    }),
    { status: 200 },
  );
};

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
    payload: { contract_versions: [2], ...body },
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

/** A customer with an agent, a persona, and a test — everything a run needs. */
async function aCustomerReadyToRun(
  label: string,
  options: TestApiOptions = {},
): Promise<{
  ada: Customer;
  key: string;
  agentId: string;
  connectionId: string;
  versionId: string;
}> {
  api = await createApi(label, {
    ...options,
    retellFetch: options.retellFetch ?? RETELL_CHAT_FETCH,
  });
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

/** A voice run whose persona listens through OpenAI's realtime adapter. */
async function aRealtimeVoiceCustomerReadyToRun(
  label: string,
  options: TestApiOptions = {},
  connection: typeof LIVEKIT | typeof PHONE = LIVEKIT,
  speed = 1,
): Promise<{
  ada: Customer;
  key: string;
  connectionId: string;
  versionId: string;
}> {
  api = await createApi(label, options);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Live voice desk",
    connection,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(contextFor(ada, "member"), {
    name: "Realtime Rita",
    traits: NEUTRAL_TRAITS,
    models: {
      llm: { provider: "openai", model: "gpt-4o-mini" },
      stt: { provider: "openai", model: "gpt-live-transcribe" },
      tts: {
        provider: "cartesia",
        model: "sonic-3.5",
        voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
        speed,
      },
    },
  });
  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    ...RESCHEDULING,
    personas: ["Realtime Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    connectionId,
    versionId: String(pushed.body.version_id),
  };
}

/**
 * Which agents a pinned version's test applies to, set through the door that
 * owns that relation.
 *
 * A run may only pair an agent with a test linked to it, and a test authored
 * before a second agent existed applies only to the first. Nothing here is
 * under test — it is the world a claim needs before it can be asked for.
 */
async function applyTo(
  key: string,
  versionId: string,
  agentIds: readonly string[],
): Promise<void> {
  const version = await ask(
    api.app,
    "GET",
    `/api/test-versions/${versionId}`,
    key,
  );
  expect(version.statusCode, JSON.stringify(version.body)).toBe(200);
  const linked = await ask(
    api.app,
    "POST",
    `/api/tests/${String(version.body.test_id)}/agents`,
    key,
    { agents: [...agentIds] },
  );
  expect(linked.statusCode, JSON.stringify(linked.body)).toBe(200);
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
    idempotency_key: newId("run"),
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
    const lines: string[] = [];
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_spec", {
        logTo: { write: (line) => lines.push(line) },
      });
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

    expect(spec.contract_version).toBe(2);
    expect(spec.simulation_id).toBe(simulationId);
    expect(
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (line) =>
            line["otel.event.name"] === "egma.simulation.dispatched",
        ),
    ).toMatchObject({
      "egma.run_id": runId,
      "egma.simulation_id": simulationId,
    });
    expect(spec.modality).toBe("chat");
    expect(spec.connection).toEqual({
      type: "retell",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    expect(spec.persona).toEqual({
      traits: NEUTRAL_TRAITS,
    });
    expect(spec.models).toEqual({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        key: "openai-key-held-by-this-test-suite",
      },
      stt: { provider: "openai", model: "gpt-live-transcribe" },
      tts: {
        provider: "cartesia",
        model: "sonic-3.5",
        voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
        speed: 1,
      },
    });
    expect(spec.scenario).toEqual({ instructions: RESCHEDULING.scenario });
    expect(spec.limits).toEqual({ max_duration_seconds: 600, max_turns: 60 });
    // A run that mocks nothing hands over the work order it always did.
    // An empty list would be a claim about tools where this project has
    // made none, and most projects have made none.
    expect("mock_tools" in spec).toBe(false);
    // And so does a platform nobody has configured: no block at all, which
    // is byte for byte the document this door produced before the settings
    // existed. Every fixture written before today is still what it sends.
    expect("platform" in spec).toBe(false);

    // The row carries the claim, and the run has started.
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("claimed");
    expect(row?.claimedBy).toBe("sim-under-test");
    expect(row?.heartbeatAt).toBeInstanceOf(Date);

    const header = await ask(api.app, "GET", `/api/runs/${runId}`, key);
    expect(header.body.status).toBe("running");
  });

  it("carries the answers this simulation serves, resolved into one world", async () => {
    api = await createApi("claims_mock_tools", {
      retellFetch: RETELL_CHAT_FETCH,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Front desk",
      connection: RETELL,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const connectionId = (registered.body.connection as { id: string }).id;
    await createPersona(contextFor(ada, "member"), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });

    // The project's world: two tools answered for every test it runs.
    for (const written of [
      { tool: "check_availability", answer: { slots: ["Tuesday 14:00"] } },
      { tool: "send_confirmation_sms", answer: { delivered: true }, delay_ms: 250 },
    ]) {
      const authored = await ask(api.app, "POST", "/api/mock-tools", key, written);
      expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);
    }

    // And one test that forces a branch the project's world does not have.
    const pushed = await ask(api.app, "POST", "/api/tests", key, {
      ...RESCHEDULING,
      personas: ["Impatient Rita"],
      mock_tools: [
        { tool: "check_availability", answer: { slots: [] } },
        { tool: "book_appointment", error: "the booking service is down" },
      ],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    await aQueuedRun(key, connectionId, String(pushed.body.version_id));
    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    const spec = (answered.body.specs as Record<string, unknown>[])[0];
    if (spec === undefined) throw new Error("no spec came back");
    expect(specComplaints(spec)).toEqual([]);

    // The override beat the default of the same name and took its place;
    // the default the test said nothing about stayed; and the override for
    // a tool no default covers joined the end. One world, decided here, so
    // there is nothing left for the simulator to choose between.
    expect(spec.mock_tools).toEqual([
      {
        tool_name: "check_availability",
        answer: { answer: { slots: [] } },
        delay_milliseconds: 0,
      },
      {
        tool_name: "send_confirmation_sms",
        answer: { answer: { delivered: true } },
        delay_milliseconds: 250,
      },
      {
        tool_name: "book_appointment",
        answer: { error: "the booking service is down" },
        delay_milliseconds: 0,
      },
    ]);
  });

  it("goes on serving the world its run froze after the mock tool is edited", async () => {
    api = await createApi("claims_mock_snapshot", {
      retellFetch: RETELL_CHAT_FETCH,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Front desk",
      connection: RETELL,
    });
    const connectionId = (registered.body.connection as { id: string }).id;
    await createPersona(contextFor(ada, "member"), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });
    const authored = await ask(api.app, "POST", "/api/mock-tools", key, {
      tool: "check_availability",
      answer: { slots: ["Tuesday 14:00"] },
    });
    const pushed = await ask(api.app, "POST", "/api/tests", key, {
      ...RESCHEDULING,
      personas: ["Impatient Rita"],
    });
    await aQueuedRun(key, connectionId, String(pushed.body.version_id));

    // The edit lands after the run was created, which is the case the
    // snapshot exists for: a mock tool is unversioned and an edit
    // overwrites the row, so a run reading the row at claim time would
    // hand two simulations of one run two different worlds.
    const edited = await ask(
      api.app,
      "PATCH",
      `/api/mock-tools/${String(authored.body.id)}`,
      key,
      { answer: { slots: [] } },
    );
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 4,
      wait_seconds: 0,
    });
    const spec = (answered.body.specs as Record<string, unknown>[])[0];
    expect(spec?.mock_tools).toEqual([
      {
        tool_name: "check_availability",
        answer: { answer: { slots: ["Tuesday 14:00"] } },
        delay_milliseconds: 0,
      },
    ]);
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
  it("blocks a legacy text-labelled row when Retell says its agent is voice", async () => {
    const providerReads: string[] = [];
    const retellFetch: typeof fetch = async (input) => {
      providerReads.push(String(input));
      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: "agent_in_retell_1",
              agent_name: "Voice front desk",
              channel: "voice",
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    };
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_retell_voice_mismatch", {
        retellFetch,
      });
    const doomed = await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });

    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.specs).toEqual([]);
    expect(providerReads).toHaveLength(1);
    expect(providerReads[0]).toContain("/v2/list-agents");
    const row = await getSimulation(
      contextFor(ada, "member"),
      doomed.simulationId,
    );
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("dispatch_failed");
  });

  it("releases a transient claim, and lands a cancel that arrives during its next check", async () => {
    let holdProvider = false;
    let providerStarted!: () => void;
    let letProviderFinish!: () => void;
    const providerDidStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerMayFinish = new Promise<void>((resolve) => {
      letProviderFinish = resolve;
    });
    const { ada, key, connectionId, versionId } =
      await aCustomerReadyToRun("claims_retell_temporarily_unavailable", {
        retellFetch: async () => {
          if (holdProvider) {
            providerStarted();
            await providerMayFinish;
          }
          return new Response("temporarily unavailable", { status: 503 });
        },
      });
    const waiting = await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });

    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.specs).toEqual([]);
    const row = await getSimulation(
      contextFor(ada, "member"),
      waiting.simulationId,
    );
    expect(row?.status).toBe("queued");
    expect(row?.endingReason).toBeNull();
    expect(row?.claimedBy).toBeNull();
    const feed = await listRunEvents(contextFor(ada, "member"), waiting.runId);
    expect(
      feed?.events
        .filter((event) => event.simulationId === waiting.simulationId)
        .map((event) => event.status),
    ).toEqual(["claimed", "queued"]);

    // The same row is claimed again. This time Cancel lands while Retell is
    // still being checked, before any simulator receives a spec.
    holdProvider = true;
    const checking = claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    await providerDidStart;
    const canceled = await ask(
      api.app,
      "POST",
      `/api/runs/${waiting.runId}/cancel`,
      key,
    );
    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);
    letProviderFinish();

    const afterCancel = await checking;
    expect(afterCancel.statusCode, JSON.stringify(afterCancel.body)).toBe(200);
    expect(afterCancel.body.specs).toEqual([]);
    const stopped = await getSimulation(
      contextFor(ada, "member"),
      waiting.simulationId,
    );
    expect(stopped?.status).toBe("canceled");
    expect(stopped?.endingReason).toBeNull();
    const settled = await ask(
      api.app,
      "GET",
      `/api/runs/${waiting.runId}`,
      key,
    );
    expect(settled.body).toMatchObject({
      status: "canceled",
      canceled_count: 1,
      finished_at: expect.any(String),
    });
    const finalFeed = await listRunEvents(
      contextFor(ada, "member"),
      waiting.runId,
    );
    expect(
      finalFeed?.events
        .filter((event) => event.simulationId === waiting.simulationId)
        .map((event) => event.status),
    ).toEqual(["claimed", "queued", "claimed", "canceled"]);
  });

  it("starts independent Retell checks together and bounds a provider that never answers", async () => {
    let active = 0;
    let mostActive = 0;
    let reads = 0;
    let bothProviderReadsStarted!: () => void;
    const providerReadsStarted = new Promise<void>((resolve) => {
      bothProviderReadsStarted = resolve;
    });
    const retellFetch: typeof fetch = async (_input, init) => {
      reads += 1;
      active += 1;
      mostActive = Math.max(mostActive, active);
      if (reads === 2) bothProviderReadsStarted();
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("the Retell check had no deadline");
      }
      return new Promise<Response>((_resolve, reject) => {
        const stopped = (): void => {
          active -= 1;
          reject(signal.reason ?? new Error("the Retell check ended"));
        };
        if (signal.aborted) stopped();
        else signal.addEventListener("abort", stopped, { once: true });
      });
    };
    const { key, agentId, connectionId, versionId } =
      await aCustomerReadyToRun("claims_retell_bounded_batch", {
        retellFetch,
      });
    const second = await ask(api.app, "POST", "/api/agents", key, {
      name: "Second desk",
      connection: {
        ...RETELL,
        config: { retellAgentId: "agent_in_retell_2" },
      },
    });
    expect(second.statusCode, JSON.stringify(second.body)).toBe(201);
    const secondAgent = (second.body.agent as { id: string }).id;
    const secondConnection = (second.body.connection as { id: string }).id;
    await applyTo(key, versionId, [agentId, secondAgent]);
    await Promise.all([
      aQueuedRun(key, connectionId, versionId),
      aQueuedRun(key, secondConnection, versionId),
    ]);

    const providerDeadlines: number[] = [];
    const deadlineControllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      providerDeadlines.push(milliseconds);
      const controller = new AbortController();
      deadlineControllers.push(controller);
      return controller.signal;
    });

    const answering = claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 2,
      wait_seconds: 0,
    });
    await providerReadsStarted;

    expect(reads).toBe(2);
    expect(mostActive).toBe(2);
    expect(providerDeadlines).toEqual([15_000, 15_000]);

    for (const controller of deadlineControllers) {
      controller.abort(new Error("the controlled provider deadline ended"));
    }
    const answered = await answering;

    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.specs).toEqual([]);
    expect(active).toBe(0);
  });

  it("lands as dispatch_failed at once, while the rest of the batch still dispatches", async () => {
    const { ada, key, agentId, connectionId, versionId } =
      await aCustomerReadyToRun("claims_skip");

    // Two runs over two connections; one connection stops resolving before the
    // claim, so one spec can be assembled and one cannot.
    const doomed = await aQueuedRun(key, connectionId, versionId);
    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Second desk",
      connection: { ...RETELL, config: { retellAgentId: "agent_in_retell_2" } },
    });
    const secondAgent = (registered.body.agent as { id: string }).id;
    const secondConnection = (registered.body.connection as { id: string }).id;
    // The test was authored before this agent existed, so nothing yet says it
    // is worth running against it — and a run may only pair the two once
    // somebody has.
    await applyTo(key, versionId, [agentId, secondAgent]);
    const healthy = await aQueuedRun(key, secondConnection, versionId);

    // Marked archived in the row rather than through the Archive verb, on
    // purpose: Archive settles the queue in the same transaction, so going
    // through it would cancel the very simulation this test needs to reach the
    // claim. What is under test is the claim door meeting a spec it cannot
    // assemble, whatever left it that way.
    await api.database.sql(
      "update connection set archived_at = now() where id = $1",
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
    const { ada, key, agentId, connectionId, versionId } =
      await aCustomerReadyToRun("claims_corrupt");

    const doomed = await aQueuedRun(key, connectionId, versionId);
    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Second desk",
      connection: { ...RETELL, config: { retellAgentId: "agent_in_retell_2" } },
    });
    const secondAgent = (registered.body.agent as { id: string }).id;
    const secondConnection = (registered.body.connection as { id: string }).id;
    // The test was authored before this agent existed, so nothing yet says it
    // is worth running against it — and a run may only pair the two once
    // somebody has.
    await applyTo(key, versionId, [agentId, secondAgent]);
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

describe("one source of execution truth", () => {
  it("keeps OpenAI realtime STT paired with its model and OpenAI account key", async () => {
    const { key, connectionId, versionId } =
      await aRealtimeVoiceCustomerReadyToRun(
        "claims_realtime_stt_pair",
        {
          providerCredentials: {
            load: async () => ({
              openai: "one-openai-account-key",
              cartesia: "one-cartesia-account-key",
            }),
          },
        },
        LIVEKIT,
        SPEED_RANGE.slowest,
      );
    await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    const spec = (answered.body.specs as Record<string, unknown>[])[0];
    expect(specComplaints(spec)).toEqual([]);
    expect(spec?.models).toEqual({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        key: "one-openai-account-key",
      },
      stt: {
        provider: "openai",
        model: "gpt-live-transcribe",
        key: "one-openai-account-key",
      },
      tts: {
        provider: "cartesia",
        model: "sonic-3.5",
        voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
        speed: SPEED_RANGE.slowest,
        key: "one-cartesia-account-key",
      },
    });
    expect(spec?.platform).toBeUndefined();

    const withSpeed = (speed: number): Record<string, unknown> => {
      const changed = structuredClone(spec ?? {});
      const models = changed.models as Record<string, Record<string, unknown>>;
      const tts = models.tts;
      if (tts === undefined) throw new Error("the claimed spec has no TTS model");
      tts.speed = speed;
      return changed;
    };
    expect(specComplaints(withSpeed(SPEED_RANGE.fastest))).toEqual([]);
    expect(
      specComplaints(withSpeed(SPEED_RANGE.slowest - 0.0001)),
    ).not.toEqual([]);
    expect(
      specComplaints(withSpeed(SPEED_RANGE.fastest + 0.0001)),
    ).not.toEqual([]);
  });

  it("keeps the carrier credential out of a connection that cannot use it", async () => {
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "claims_carrier_only",
      {
        platformSettings: {
          carrier_trunk_address: "acme.pstn.twilio.com",
          carrier_trunk_number: "+15550100",
          carrier_trunk_username: "acme-trunk",
          carrier_trunk_password: "the-carrier-issued-this-one",
        },
      },
    );
    await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    const spec = (answered.body.specs as Record<string, unknown>[])[0];
    expect(specComplaints(spec)).toEqual([]);
    expect(spec?.platform).toBeUndefined();
    expect(spec?.models).toBeDefined();
  });

  it("puts only the carrier on a phone claim", async () => {
    const { key, connectionId, versionId } =
      await aRealtimeVoiceCustomerReadyToRun(
        "claims_phone_carrier_only",
        {
          platformSettings: {
            carrier_trunk_address: "acme.pstn.twilio.com",
            carrier_trunk_number: "+15550100",
            carrier_trunk_username: "acme-trunk",
            carrier_trunk_password: "the-carrier-issued-this-one",
          },
        },
        PHONE,
      );
    await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    const spec = (answered.body.specs as Record<string, unknown>[])[0];
    expect(specComplaints(spec)).toEqual([]);
    expect(spec?.platform).toEqual({
      carrier: {
        trunk_address: "acme.pstn.twilio.com",
        trunk_number: "+15550100",
        trunk_username: "acme-trunk",
        trunk_password: "the-carrier-issued-this-one",
      },
    });
    expect(spec?.models).toBeDefined();
  });

  it("reads a fresh credential bundle for each simulation and sends only the chat leg's key", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        openai: "openai-first",
        deepgram: "deepgram-first",
        cartesia: "cartesia-first",
      })
      .mockResolvedValueOnce({
        openai: "openai-rotated",
        deepgram: "deepgram-rotated",
        cartesia: "cartesia-rotated",
      });
    const { key, connectionId, versionId } = await aCustomerReadyToRun(
      "claims_credentials_rotate",
      { providerCredentials: { load } },
    );

    const claimedKey = async (): Promise<Record<string, unknown>> => {
      await aQueuedRun(key, connectionId, versionId);
      const answered = await claim(api.config.simulatorServiceToken, {
        claimant: "sim-under-test",
        capacity: 1,
        wait_seconds: 0,
      });
      const spec = (answered.body.specs as Record<string, unknown>[])[0];
      if (spec === undefined) throw new Error("no spec came back");
      return spec.models as Record<string, unknown>;
    };

    const first = await claimedKey();
    const second = await claimedKey();
    expect(load).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ llm: { key: "openai-first" } });
    expect(second).toMatchObject({ llm: { key: "openai-rotated" } });
    expect(first).toMatchObject({
      stt: { provider: "openai", model: "gpt-live-transcribe" },
      tts: { provider: "cartesia", model: "sonic-3.5" },
    });
    expect((first.stt as Record<string, unknown>).key).toBeUndefined();
    expect((first.tts as Record<string, unknown>).key).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("deepgram-first");
    expect(JSON.stringify(first)).not.toContain("cartesia-first");
  });

  it("releases work when the current AWS bundle cannot be read", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ProviderCredentialSourceUnavailableError())
      .mockResolvedValueOnce({ openai: "openai-after-retry" });
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "claims_credentials_unavailable",
      { providerCredentials: { load } },
    );
    const { simulationId } = await aQueuedRun(key, connectionId, versionId);

    const deferred = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    expect(deferred.body.specs).toEqual([]);
    expect(
      (await getSimulation(contextFor(ada, "member"), simulationId))?.status,
    ).toBe("queued");

    const retried = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    expect(retried.body.specs as unknown[]).toHaveLength(1);
  });

  it("fails before dispatch when the selected provider has no current key", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "claims_credentials_missing",
      { providerCredentials: { load: async () => ({}) } },
    );
    const { simulationId } = await aQueuedRun(key, connectionId, versionId);

    const answered = await claim(api.config.simulatorServiceToken, {
      claimant: "sim-under-test",
      capacity: 1,
      wait_seconds: 0,
    });
    expect(answered.body.specs).toEqual([]);
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("failed");
    expect(row?.endingReason).toBe("dispatch_failed");
  });

  it("does not claim work for a worker that cannot read contract version 2", async () => {
    const { ada, key, connectionId, versionId } = await aCustomerReadyToRun(
      "claims_contract_cutover",
    );
    const { simulationId } = await aQueuedRun(key, connectionId, versionId);

    const refused = await claim(api.config.simulatorServiceToken, {
      claimant: "old-simulator",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1],
    });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.body.message)).toContain("version 2");
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("queued");
  });
});
