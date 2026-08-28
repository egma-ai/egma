import { newId } from "@egma/ids";
import {
  connectionOptionMetadata,
  createPersona,
  getSimulation,
  startRun,
  type ConductedWorld,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { reportPathFor } from "../src/routes/reports.ts";
import { readPlaygroundWorld } from "../src/providers/retell-playground.ts";
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
 * The playground lane's control-plane half, against a Retell that only exists
 * in this file.
 *
 * Nothing here reaches a network. What is asserted is what a developer
 * observes: the connection they can register, the refusal they read when their
 * agent is out of this lane's reach, the version stamped on the run and on
 * every conversation of it, and the work order a simulator would be handed.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/**
 * Whether the shipped simulator holds a playground plug.
 *
 * Read off the registry rather than written down, so that the day the plug
 * lands one boolean flips there and the assertions below start proving the
 * other half with nothing here to edit.
 */
const ADAPTER_HAS_SHIPPED =
  connectionOptionMetadata().find(
    (option) => option.connectionType === "retell_playground",
  )?.simulatorAdapter === true;

/** Planted in every connection below, and scanned for everywhere after. */
const SENTINEL_KEY = "retell-secret-SENTINEL-8QW3ZX7K2N";
const PLATFORM_AGENT = "agent_in_retell_1";
const SERVING_VERSION = 106;

const PLAYGROUND = {
  agentPlatform: "retell",
  connectionType: "retell_playground",
  accessVariant: "retell_playground.api_key",
  modality: "chat",
  config: { retellAgentId: PLATFORM_AGENT },
  credentials: { apiKey: SENTINEL_KEY },
} as const;

const RETELL_CHAT = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: PLATFORM_AGENT },
  credentials: { apiKey: SENTINEL_KEY },
} as const;

/**
 * A conversation flow with one tool of each class: one Egma stands in front
 * of, one that executes inside Retell, and one Egma does not intercept yet.
 */
const FLOW = {
  conversation_flow_id: "conversation_flow_2346a0e8367c",
  version: SERVING_VERSION,
  tools: [
    {
      type: "custom",
      name: "check_availability",
      url: "https://acme.example/availability",
    },
    { type: "transfer_call", name: "transfer_to_front_desk" },
  ],
  mcps: [{ mcp_id: "mcp_1", name: "inventory", url: "https://acme.example/mcp" }],
} as const;

type RetellPlan = {
  /** Which engine the agent version points at. */
  readonly engine?: Record<string, unknown> | undefined;
  /** What Retell's listing calls this agent's channel. */
  readonly channel?: "voice" | "chat" | undefined;
  /** The status the agent read answers with. */
  readonly agentStatus?: number | undefined;
  /** The status the engine read answers with. */
  readonly engineStatus?: number | undefined;
};

/** A Retell that answers exactly what one test's plan says, and records asks. */
function retell(plan: RetellPlan = {}): {
  readonly fetchImpl: typeof fetch;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);

    if (url.includes("/get-agent/")) {
      const status = plan.agentStatus ?? 200;
      if (status !== 200) {
        // Retell echoing the key back is the case credential discipline is
        // for: nothing of this body may reach a log, a report, or a refusal.
        return new Response(
          JSON.stringify({ message: `bad key ${SENTINEL_KEY}` }),
          { status },
        );
      }
      return new Response(
        JSON.stringify({
          agent_id: PLATFORM_AGENT,
          version: SERVING_VERSION,
          is_published: true,
          response_engine: plan.engine ?? {
            type: "conversation-flow",
            conversation_flow_id: FLOW.conversation_flow_id,
            version: SERVING_VERSION,
          },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/get-conversation-flow/") || url.includes("/get-retell-llm/")) {
      const status = plan.engineStatus ?? 200;
      if (status !== 200) {
        return new Response(
          JSON.stringify({ message: `no flow for ${SENTINEL_KEY}` }),
          { status },
        );
      }
      return new Response(JSON.stringify(FLOW), { status: 200 });
    }

    if (url.includes("/v2/list-agents")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: PLATFORM_AGENT,
              agent_name: "Front desk",
              channel: plan.channel ?? "chat",
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected Retell read: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** A customer with a suite, a persona and a test — everything a run needs. */
async function aCustomerReadyToRun(
  label: string,
  connection: typeof PLAYGROUND | typeof RETELL_CHAT,
  plan: RetellPlan = {},
  /** A trace store, for the one test that lands a terminal report. */
  traceStore = false,
): Promise<{
  ada: Customer;
  key: string;
  agentId: string;
  connectionId: string;
  suiteId: string;
  asked: string[];
  /** Every line the platform logged while this test ran, in order. */
  logs: string[];
}> {
  const { fetchImpl, asked } = retell(plan);
  const logs: string[] = [];
  api = await createApi(label, {
    retellFetch: fetchImpl,
    logTo: { write: (line: string) => logs.push(line) },
    ...(traceStore ? { traceStore: true } : {}),
  });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "Front desk",
    connection,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);

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

  return {
    ada,
    key,
    agentId: (registered.body.agent as { id: string }).id,
    connectionId: (registered.body.connection as { id: string }).id,
    suiteId: String(suite.body.id),
    asked,
    logs,
  };
}

describe("a Retell playground connection, through the API", () => {
  it("is registered, reads back as chat, and is offered in the options", async () => {
    const { key, connectionId } = await aCustomerReadyToRun(
      "playground_registered",
      PLAYGROUND,
    );

    const read = await ask(api.app, "GET", "/v1/connection-options", key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    const offered = (
      read.body.items as {
        connectionType: string;
        productLabel: string;
        modality: string;
        simulatorAdapter: boolean;
      }[]
    ).find((one) => one.connectionType === "retell_playground");
    expect(offered?.productLabel).toBe("Retell playground");
    expect(offered?.modality).toBe("chat");
    expect(offered?.simulatorAdapter).toBe(ADAPTER_HAS_SHIPPED);

    const { rows } = await api.database.sql<{
      connection_type: string;
      access_variant: string;
      modality: string;
      credentials_hint: string;
    }>(
      `select connection_type, access_variant, modality, credentials_hint
         from connection where id = $1`,
      [connectionId],
    );
    expect(rows[0]?.connection_type).toBe("retell_playground");
    expect(rows[0]?.access_variant).toBe("retell_playground.api_key");
    expect(rows[0]?.modality).toBe("chat");
    // Sealed: a read gives the last four characters and never the key.
    expect(rows[0]?.credentials_hint).toBe(SENTINEL_KEY.slice(-4));
  });

  it("refuses a garbage modality and an unknown config key by name", async () => {
    const { fetchImpl } = retell();
    api = await createApi("playground_refusals", { retellFetch: fetchImpl });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const nonsense = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: { ...PLAYGROUND, modality: "telepathy" },
    });
    expect(nonsense.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(nonsense.body.message)).toMatch(/telepathy/u);

    const strayKey = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk two",
      connection: {
        ...PLAYGROUND,
        config: { retellAgentId: PLATFORM_AGENT, retellAgentID: "typo" },
      },
    });
    expect(strayKey.statusCode).toBe(400);
    expect(String(strayKey.body.message)).toContain('has no key "retellAgentID"');
    expect(JSON.stringify(strayKey.body)).not.toContain(SENTINEL_KEY);
  });
});

describe("registering a playground connection against a named Retell agent", () => {
  /** The registration a connect flow makes: the agent named, the key pasted. */
  async function register(
    label: string,
    plan: RetellPlan,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const { fetchImpl } = retell(plan);
    api = await createApi(label, { retellFetch: fetchImpl });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    return ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: { ...PLAYGROUND, platformAgentId: PLATFORM_AGENT },
    });
  }

  it("confirms a voice agent and keeps the key on the connection", async () => {
    const registered = await register("playground_confirm_voice", {
      channel: "voice",
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const connection = registered.body.connection as {
      connectionType: string;
      productLabel: string;
      credentialsHint: string;
    };
    expect(connection.connectionType).toBe("retell_playground");
    expect(connection.productLabel).toBe("Retell playground");
    // Every exchange this connection conducts needs the key, so it keeps one.
    expect(connection.credentialsHint).toBe(SENTINEL_KEY.slice(-4));
  });

  it("reads back the custom-LLM refusal at the door, not at the first run", async () => {
    // The engine is a platform fact, so the check lives where the engine is
    // read — and it is read on the creation path as well as at run start, so
    // a developer whose agent this lane cannot reach hears about it while they
    // are registering rather than when a suite refuses to start.
    const refused = await register("playground_confirm_custom_llm", {
      channel: "voice",
      engine: { type: "custom-llm", llm_websocket_url: "wss://acme.example/llm" },
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain("custom LLM");
    expect(String(refused.body.message)).toContain("your own service");
    expect(String(refused.body.message)).toContain("SDK");
    expect(JSON.stringify(refused.body)).not.toContain(SENTINEL_KEY);
  });

  it("refuses a chat agent, which has its own door", async () => {
    const refused = await register("playground_confirm_chat_agent", {
      channel: "chat",
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain("Chat API");
  });
});

describe("the run-start read", () => {
  it("resolves the serving version and classes that version's tools", async () => {
    const { fetchImpl, asked } = retell();
    const read = await readPlaygroundWorld(
      { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
      fetchImpl,
    );

    expect(read.kind).toBe("world");
    if (read.kind !== "world") return;
    expect(read.world.agentVersion).toBe(SERVING_VERSION);
    expect(read.world.engine).toEqual({
      type: "conversation-flow",
      engineId: FLOW.conversation_flow_id,
      version: SERVING_VERSION,
    });
    // One tool of each class, from the configuration and not from a guess.
    expect(read.world.coverage).toEqual({
      mocked: ["check_availability"],
      notInterceptable: ["transfer_to_front_desk"],
      notInThisVersion: ["inventory"],
    });

    // It asks for `latest` exactly once, and reads the engine at the number
    // that came back. That is the opposite of leaning on the default: the
    // number is what every request from now on names.
    expect(asked.filter((url) => url.includes("latest"))).toHaveLength(1);
    expect(
      asked.some((url) =>
        url.includes(`/get-conversation-flow/${FLOW.conversation_flow_id}?version=${SERVING_VERSION}`),
      ),
    ).toBe(true);
  });

  it("refuses a custom LLM with Retell's own absence as the reason", async () => {
    const { fetchImpl } = retell({
      engine: { type: "custom-llm", llm_websocket_url: "wss://acme.example/llm" },
    });
    const read = await readPlaygroundWorld(
      { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
      fetchImpl,
    );

    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    expect(read.message).toContain("custom LLM");
    expect(read.message).toContain("your own service");
    // And where the future of reaching such an agent is, so the refusal is a
    // direction rather than a wall.
    expect(read.message).toContain("SDK");
  });

  it("fails loudly when Retell will not answer either read", async () => {
    for (const plan of [
      { agentStatus: 503 },
      { engineStatus: 503 },
    ] as const) {
      const { fetchImpl } = retell(plan);
      const read = await readPlaygroundWorld(
        { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
        fetchImpl,
      );
      expect(read.kind, JSON.stringify(plan)).toBe("unavailable");
      expect(String(read.kind === "unavailable" ? read.message : "")).toContain(
        "Nothing was started",
      );
      expect(JSON.stringify(read)).not.toContain(SENTINEL_KEY);
    }
  });

  it("refuses a rejected key and a vanished agent, quoting neither", async () => {
    for (const [plan, expected] of [
      [{ agentStatus: 401 }, /rejected this connection's stored API key/u],
      [{ agentStatus: 404 }, /no longer holds agent/u],
      [{ engineStatus: 404 }, /would not give up that version's tools/u],
    ] as const) {
      const { fetchImpl } = retell(plan);
      const read = await readPlaygroundWorld(
        { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
        fetchImpl,
      );
      expect(read.kind, JSON.stringify(plan)).toBe("refused");
      expect(read.kind === "refused" ? read.message : "").toMatch(expected);
      expect(JSON.stringify(read)).not.toContain(SENTINEL_KEY);
    }
  });
});

describe("a run over a Retell playground connection", () => {
  it("reads the world before anything is written, and fails the run when it cannot", async () => {
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "playground_run_unread",
      PLAYGROUND,
      { engineStatus: 503 },
    );

    const refused = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    // Retell would not answer, and asking again may well work — so it is not a
    // 422 about the request, and it says nothing was started.
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(503);
    expect(String(refused.body.error)).toBe("provider_unavailable");
    expect(String(refused.body.message)).toContain("Nothing was started");
    expect(JSON.stringify(refused.body)).not.toContain(SENTINEL_KEY);

    // Nothing was started, and that is a fact about the record rather than a
    // sentence: no run row, and therefore no simulation to conduct against a
    // world nobody read.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("fails the run loudly when the agent's brain is a custom LLM", async () => {
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "playground_run_custom_llm",
      PLAYGROUND,
      { engine: { type: "custom-llm", llm_websocket_url: "wss://acme.example/llm" } },
    );

    const refused = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain("custom LLM");
    expect(String(refused.body.message)).toContain("SDK");

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("either stamps the version it resolved, or says no simulator can conduct it", async () => {
    // One assertion that reads correctly on both sides of the plug landing.
    // Today the registry says no adapter ships for this kind, so the door
    // refuses at creation rather than queueing work forever; the day the
    // playground plug lands, one boolean in the registry flips and this same
    // test asserts the stamp instead, with nothing here to edit.
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "playground_run_stamp",
      PLAYGROUND,
    );

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });

    if (!ADAPTER_HAS_SHIPPED) {
      expect(started.statusCode, JSON.stringify(started.body)).toBe(422);
      expect(String(started.body.error)).toBe("no_adapter");
      return;
    }

    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.conductedAgentVersion).toBe(SERVING_VERSION);

    const runId = String(started.body.id);
    const detail = await ask(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(detail.body.conductedWorld).toEqual({
      agentVersion: SERVING_VERSION,
      engine: {
        type: "conversation-flow",
        engineId: FLOW.conversation_flow_id,
        version: SERVING_VERSION,
      },
      coverage: {
        mocked: ["check_availability"],
        notInterceptable: ["transfer_to_front_desk"],
        notInThisVersion: ["inventory"],
      },
    });
  });
});

/**
 * The stamp and the work order, driven through `startRun`'s own seam.
 *
 * The lane above is refused at the door until its plug ships, and what these
 * two prove is everything on the far side of that one boolean: that the
 * resolved version lands on the run **and** on every conversation of it, and
 * that a claim assembled from such a run carries the version, this
 * simulation's variables, and only the answers this lane may honestly serve.
 */
const A_CONDUCTED_WORLD: ConductedWorld = {
  agentVersion: SERVING_VERSION,
  engine: {
    type: "conversation-flow",
    engineId: FLOW.conversation_flow_id,
    version: SERVING_VERSION,
  },
  coverage: {
    mocked: ["check_availability"],
    notInterceptable: ["transfer_to_front_desk"],
    notInThisVersion: ["inventory"],
  },
};

describe("the sentinel Retell key", () => {
  it("reaches Retell and nothing else, on a run that starts and one that fails", async () => {
    // Planted in the connection, used for two provider reads, and then looked
    // for in every place a person or a machine would ever read: the responses,
    // the platform log, and the rows a reader can ask for.
    for (const plan of [{}, { agentStatus: 401 }, { engineStatus: 503 }]) {
      const { key, agentId, connectionId, suiteId, logs, asked } =
        await aCustomerReadyToRun(
          `playground_sentinel_${Object.keys(plan)[0] ?? "happy"}`,
          PLAYGROUND,
          plan,
        );

      const started = await ask(api.app, "POST", "/v1/runs", key, {
        suiteId,
        agentId,
        connectionId,
        idempotencyKey: newId("run"),
      });
      expect(started.body, JSON.stringify(started.body)).toBeDefined();

      // The key went out as a bearer token, which is the one place it belongs.
      expect(asked.length).toBeGreaterThan(0);

      // And it is in none of the three places anybody reads.
      expect(JSON.stringify(started.body)).not.toContain(SENTINEL_KEY);
      expect(logs.join("\n")).not.toContain(SENTINEL_KEY);

      const listed = await ask(api.app, "GET", "/v1/runs", key);
      expect(JSON.stringify(listed.body)).not.toContain(SENTINEL_KEY);

      const read = await ask(
        api.app,
        "GET",
        `/v1/agents/${agentId}`,
        key,
      );
      expect(JSON.stringify(read.body)).not.toContain(SENTINEL_KEY);

      await api.close();
    }
  });
});

describe("the version a run resolved, on the record", () => {
  it("lands on the run and on every conversation of it", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("playground_stamp_grain", RETELL_CHAT);

    const started = await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
      conductedWorld: A_CONDUCTED_WORLD,
    });

    const header = await ask(api.app, "GET", `/v1/runs/${started.id}`, key);
    expect(header.statusCode, JSON.stringify(header.body)).toBe(200);
    expect(header.body.conductedAgentVersion).toBe(SERVING_VERSION);
    expect(header.body.conductedWorld).toEqual(A_CONDUCTED_WORLD);

    // And at the evidence grain, which is the read a result is actually
    // looked at through: a simulation answers for itself.
    const listed = await ask(
      api.app,
      "GET",
      `/v1/runs/${started.id}/simulations`,
      key,
    );
    const simulations = listed.body.simulations as {
      id: string;
      conductedAgentVersion: number | null;
    }[];
    expect(simulations.length).toBeGreaterThan(0);
    for (const one of simulations) {
      expect(one.conductedAgentVersion).toBe(SERVING_VERSION);
    }

    const alone = await ask(
      api.app,
      "GET",
      `/v1/simulations/${simulations[0]?.id}`,
      key,
    );
    expect(alone.statusCode, JSON.stringify(alone.body)).toBe(200);
    expect(alone.body.conductedAgentVersion).toBe(SERVING_VERSION);
  });

  it("is absent on a run that pinned none", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("playground_stamp_absent", RETELL_CHAT);

    const started = await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });

    const header = await ask(api.app, "GET", `/v1/runs/${started.id}`, key);
    expect(header.body.conductedAgentVersion).toBeNull();
    expect(header.body.conductedWorld).toBeNull();
  });
});

describe("the coverage stamp a version-pinned run puts on its record", () => {
  it("is built from the version Egma read, and tolerates a plug with no provider reference", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun(
        "playground_stamp_coverage",
        RETELL_CHAT,
        {},
        true,
      );

    const authored = await ask(api.app, "POST", "/v1/mock-tools", key, {
      tool: "check_availability",
      answer: { ok: true },
      delayMs: 0,
    });
    expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);

    await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
      conductedWorld: A_CONDUCTED_WORLD,
    });

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: { claimant: "sim-under-test", capacity: 1, contract_versions: [5] },
    });
    const simulationId = String(
      (claimed.json() as { specs: { simulation_id: string }[] }).specs[0]
        ?.simulation_id,
    );

    const post = async (events: readonly Record<string, unknown>[]) =>
      api.app.inject({
        method: "POST",
        url: reportPathFor(simulationId),
        headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
        payload: { contract_version: 1, simulation_id: simulationId, events },
      });

    expect(
      (
        await post([
          {
            kind: "status",
            event_id: "evt-pg-000001",
            at: "2026-08-05T09:00:00.000000Z",
            status: "running",
            reason: null,
          },
        ])
      ).statusCode,
    ).toBe(200);

    // The plug reports no stamp of its own and **no provider reference**: the
    // playground stores nothing on Retell's side, so there is no id to hold the
    // exchange by, and everything downstream has to take that as an answer
    // rather than as a missing field.
    const landed = await post([
      {
        kind: "status",
        event_id: "evt-pg-000002",
        at: "2026-08-05T09:02:10.551000Z",
        status: "completed",
        reason: null,
        facts: {
          ending: "persona_concluded",
          started_at: "2026-08-05T09:00:00.000000Z",
          ended_at: "2026-08-05T09:02:10.551000Z",
          turn_count: 8,
          audio: null,
          provider_reference: null,
        },
      },
    ]);
    expect(landed.statusCode, landed.body).toBe(200);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    // Built from the run alone, and nothing about it was late: the tool list
    // came from the version Egma resolved before the first persona turn.
    expect(row?.mockToolCoverage).toEqual({
      discovered: [
        "check_availability",
        "transfer_to_front_desk",
        "inventory",
      ],
      covered: ["check_availability"],
      uncovered: ["transfer_to_front_desk", "inventory"],
      notInterceptable: ["transfer_to_front_desk"],
      notInThisVersion: ["inventory"],
    });
    expect(row?.providerReference).toBeNull();
    expect(row?.conductedAgentVersion).toBe(SERVING_VERSION);
  });
});

describe("the work order a version-pinned run hands over", () => {
  it("carries the version, this simulation's variables, and only the answers it may serve", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("playground_claim", RETELL_CHAT);

    // One answer per class of tool the agent has. Only the first is a name
    // this lane may honestly stand in front of.
    for (const [toolName, delay] of [
      ["check_availability", 250],
      ["transfer_to_front_desk", 0],
      ["inventory", 500],
    ] as const) {
      const authored = await ask(api.app, "POST", "/v1/mock-tools", key, {
        tool: toolName,
        answer: { ok: toolName },
        delayMs: delay,
      });
      expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);
    }

    const started = await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
      conductedWorld: A_CONDUCTED_WORLD,
    });

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: { claimant: "simulator-blue-1", capacity: 5, contract_versions: [5] },
    });
    expect(claimed.statusCode).toBe(200);
    const specs = (claimed.json() as { specs: Record<string, unknown>[] }).specs;
    expect(specs.length).toBeGreaterThan(0);
    const spec = specs[0] as Record<string, unknown>;

    // Always sent. The plug would conduct without it and the platform would
    // then choose its newest version, which a concurrent edit can move.
    expect(spec.agent_version).toBe(SERVING_VERSION);

    // Egma's own attribution variable, carrying this simulation and nothing
    // else — it is what a tool call the platform makes rides back on.
    expect(spec.dynamic_variables).toEqual({
      egma_simulation: spec.simulation_id,
    });

    // One entry per covered name only. A tool Egma classed *not interceptable
    // by construction* or *not in this version* gets none, so its calls reach
    // the real world and the record says which class it fell in.
    expect(spec.mock_tools).toEqual([
      {
        tool_name: "check_availability",
        answer: { answer: { ok: "check_availability" } },
        // Delays ride along on every lane and are never spent on chat.
        delay_milliseconds: 250,
      },
    ]);

    // The chat lane's own walls, by modality and by nothing else.
    expect(spec.modality).toBe("chat");
    expect(spec.limits).toEqual({ max_duration_seconds: 600, max_turns: 60 });

    // And the sentinel appears nowhere it should not: the connection block is
    // where a credential belongs, and it is the only place one is.
    const withoutConnection = { ...spec };
    delete withoutConnection.connection;
    expect(JSON.stringify(withoutConnection)).not.toContain(SENTINEL_KEY);
  });

  it("serves what the run resolved, unfiltered, on a lane that pinned nothing", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("playground_claim_unpinned", RETELL_CHAT);

    const authored = await ask(api.app, "POST", "/v1/mock-tools", key, {
      tool: "transfer_to_front_desk",
      answer: { ok: true },
      delayMs: 0,
    });
    expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);

    await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: { claimant: "simulator-blue-1", capacity: 5, contract_versions: [5] },
    });
    const spec = (claimed.json() as { specs: Record<string, unknown>[] })
      .specs[0] as Record<string, unknown>;

    // Egma itself is in the tool path on such a lane and answers for whatever
    // it is asked, so nothing is filtered — and no version is claimed.
    expect(spec.mock_tools).toEqual([
      {
        tool_name: "transfer_to_front_desk",
        answer: { answer: { ok: true } },
        delay_milliseconds: 0,
      },
    ]);
    expect(spec.agent_version).toBeUndefined();
    expect(spec.dynamic_variables).toBeUndefined();
  });
});
