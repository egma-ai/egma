import { newId } from "@egma/ids";
import {
  createPersona,
  getSimulation,
  resolveRunStartReach,
  startRun,
  updateConnection,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { reportPathFor } from "../src/routes/reports.ts";
import { readTextModeWorld } from "../src/providers/retell-run-start.ts";
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
 * The text-mode lane's control-plane half, against a Retell that only exists
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

/** Planted in every connection below, and scanned for everywhere after. */
const SENTINEL_KEY = "retell-secret-SENTINEL-8QW3ZX7K2N";
const PLATFORM_AGENT = "agent_in_retell_1";
const SERVING_VERSION = 106;

const TEXT_MODE = {
  agentPlatform: "retell",
  connectionType: "retell_text_mode",
  accessVariant: "retell_text_mode.api_key",
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

/** The voice door beside text mode: a web call against the same agent. */
const WEB_CALL = {
  agentPlatform: "retell",
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
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
  connection: typeof TEXT_MODE | typeof RETELL_CHAT,
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

describe("a Retell text mode connection, through the API", () => {
  it("is registered, reads back as chat, and is offered in the options", async () => {
    const { key, connectionId } = await aCustomerReadyToRun(
      "text_mode_registered",
      TEXT_MODE,
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
    ).find((one) => one.connectionType === "retell_text_mode");
    expect(offered?.productLabel).toBe("Retell text mode");
    expect(offered?.modality).toBe("chat");
    // The plug ships, so the catalog a form is drawn from says a run over
    // this kind is one Egma can actually conduct.
    expect(offered?.simulatorAdapter).toBe(true);

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
    expect(rows[0]?.connection_type).toBe("retell_text_mode");
    expect(rows[0]?.access_variant).toBe("retell_text_mode.api_key");
    expect(rows[0]?.modality).toBe("chat");
    // Sealed: a read gives the last four characters and never the key.
    expect(rows[0]?.credentials_hint).toBe(SENTINEL_KEY.slice(-4));
  });

  it("refuses a garbage modality and an unknown config key by name", async () => {
    const { fetchImpl } = retell();
    api = await createApi("text_mode_refusals", { retellFetch: fetchImpl });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const nonsense = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: { ...TEXT_MODE, modality: "telepathy" },
    });
    expect(nonsense.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(nonsense.body.message)).toMatch(/telepathy/u);

    const strayKey = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk two",
      connection: {
        ...TEXT_MODE,
        config: { retellAgentId: PLATFORM_AGENT, retellAgentID: "typo" },
      },
    });
    expect(strayKey.statusCode).toBe(400);
    expect(String(strayKey.body.message)).toContain('has no key "retellAgentID"');
    expect(JSON.stringify(strayKey.body)).not.toContain(SENTINEL_KEY);
  });
});

describe("registering a text-mode connection against a named Retell agent", () => {
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
      connection: { ...TEXT_MODE, platformAgentId: PLATFORM_AGENT },
    });
  }

  it("confirms a voice agent and keeps the key on the connection", async () => {
    const registered = await register("text_mode_confirm_voice", {
      channel: "voice",
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const connection = registered.body.connection as {
      connectionType: string;
      productLabel: string;
      credentialsHint: string;
    };
    expect(connection.connectionType).toBe("retell_text_mode");
    expect(connection.productLabel).toBe("Retell text mode");
    // Every exchange this connection conducts needs the key, so it keeps one.
    expect(connection.credentialsHint).toBe(SENTINEL_KEY.slice(-4));
  });

  it("reads back the custom-LLM refusal at the door, not at the first run", async () => {
    // The engine is a platform fact, so the check lives where the engine is
    // read — and it is read on the creation path as well as at run start, so
    // a developer whose agent this lane cannot reach hears about it while they
    // are registering rather than when a suite refuses to start.
    const refused = await register("text_mode_confirm_custom_llm", {
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
    const refused = await register("text_mode_confirm_chat_agent", {
      channel: "chat",
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain("Chat API");
  });
});

describe("one Retell agent through both a text and a voice door, on the web's fresh flow", () => {
  /**
   * The web connect flow registers a fresh agent by POSTing a plain
   * registration — it has no name-clash fallback of its own, unlike the CLI. So
   * the server is what has to land the other modality on the first door's agent.
   * Both text mode (chat) and the web call (voice) key on the vendor agent
   * id, so it does: a connection added, never a twin, in either order.
   */
  async function bothDoors(
    label: string,
    firstDoor: typeof TEXT_MODE | typeof WEB_CALL,
    secondDoor: typeof TEXT_MODE | typeof WEB_CALL,
  ): Promise<void> {
    const { fetchImpl } = retell({ channel: "voice" });
    api = await createApi(label, { retellFetch: fetchImpl });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const post = (door: typeof TEXT_MODE | typeof WEB_CALL) =>
      ask(api.app, "POST", "/v1/agents", key, {
        agentPlatform: "retell",
        name: "Front desk",
        connection: { ...door, platformAgentId: PLATFORM_AGENT },
      });

    const first = await post(firstDoor);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(first.body.result).toBe("created");

    const second = await post(secondDoor);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(201);
    // Attached to the first door's agent, not a second identity.
    expect(second.body.result).toBe("connection_added");
    expect((second.body.agent as { id: string }).id).toBe(
      (first.body.agent as { id: string }).id,
    );

    // One Egma agent, two connections; the sentinel key never surfaced.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from agent",
    );
    expect(rows[0]?.count).toBe("1");
    expect(JSON.stringify(second.body)).not.toContain(SENTINEL_KEY);
  }

  it("attaches the web call after text mode, on one egma agent", async () => {
    await bothDoors("web_text_mode_then_webcall", TEXT_MODE, WEB_CALL);
  });

  it("attaches text mode after the web call, on one egma agent", async () => {
    await bothDoors("web_webcall_then_text_mode", WEB_CALL, TEXT_MODE);
  });
});

describe("the run-start read", () => {
  it("resolves the serving version, and answers that and nothing else", async () => {
    const { fetchImpl, asked } = retell();
    const read = await readTextModeWorld(
      { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
      fetchImpl,
    );

    expect(read.kind).toBe("world");
    if (read.kind !== "world") return;
    expect(read.agentVersion).toBe(SERVING_VERSION);
    // The version is the whole answer. The engine is read as a gate — can this
    // lane reach this agent at all — and dropped; the three classes of a
    // version's tools belong to the enable-time screen, which computes them
    // live rather than off a list a run start froze.
    expect(Object.keys(read)).toEqual(["kind", "agentVersion"]);

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
    const read = await readTextModeWorld(
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
      const read = await readTextModeWorld(
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
      const read = await readTextModeWorld(
        { apiKey: SENTINEL_KEY, agentId: PLATFORM_AGENT },
        fetchImpl,
      );
      expect(read.kind, JSON.stringify(plan)).toBe("refused");
      expect(read.kind === "refused" ? read.message : "").toMatch(expected);
      expect(JSON.stringify(read)).not.toContain(SENTINEL_KEY);
    }
  });
});

describe("a run over a Retell text mode connection", () => {
  it("reads the world before anything is written, and fails the run when it cannot", async () => {
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "text_mode_run_unread",
      TEXT_MODE,
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
      "text_mode_run_custom_llm",
      TEXT_MODE,
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

  it("stamps the version it resolved, once, on the run", async () => {
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "text_mode_run_stamp",
      TEXT_MODE,
    );

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.agentVersion).toBe(SERVING_VERSION);

    // **Once, and on the run.** The run resolves the version before its first
    // simulation exists, so every conversation of it shares one value — and
    // two copies of a fact that cannot differ within a run is one too many.
    const runId = String(started.body.id);
    const detail = await ask(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(detail.body.agentVersion).toBe(SERVING_VERSION);
    expect(detail.body.tempMockAgentVersion).toBeNull();
    expect(detail.body.tempMockAgentVersionCleanup).toBeNull();
    expect(detail.body.mockMetadata).toBeNull();
  });
});

/**
 * The stamp, driven through `startRun`'s own seam.
 *
 * The lane's own proof above goes the whole way over HTTP and is the one that
 * says the product works. These sit beside it to say two things that door
 * cannot: what the write does when handed a world **directly**, so the record
 * shape is pinned independently of whatever the run-start read happened to
 * resolve; and what it does when handed **none**, which is the case no caller
 * should ever produce and every caller would produce silently if the write did
 * not refuse it.
 *
 * A connection that reads no platform at run start carries the first of those,
 * because a lane that pins nothing is exactly where a stray stamp would be
 * hardest to notice.
 */

describe("the sentinel Retell key", () => {
  it("reaches Retell and nothing else, on a run that starts and one that fails", async () => {
    // Planted in the connection, used for two provider reads, and then looked
    // for in every place a person or a machine would ever read: the responses,
    // the platform log, and the rows a reader can ask for.
    for (const plan of [{}, { agentStatus: 401 }, { engineStatus: 503 }]) {
      const { key, agentId, connectionId, suiteId, logs, asked } =
        await aCustomerReadyToRun(
          `text_mode_sentinel_${Object.keys(plan)[0] ?? "happy"}`,
          TEXT_MODE,
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
      await aCustomerReadyToRun("text_mode_stamp_grain", RETELL_CHAT);

    const started = await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
      agentVersion: SERVING_VERSION,
    });

    const header = await ask(api.app, "GET", `/v1/runs/${started.id}`, key);
    expect(header.statusCode, JSON.stringify(header.body)).toBe(200);
    expect(header.body.agentVersion).toBe(SERVING_VERSION);

    // The simulations of one run carry no copy of it: the run resolves the
    // version once and every conversation of it shares that one value.
    const listed = await ask(
      api.app,
      "GET",
      `/v1/runs/${started.id}/simulations`,
      key,
    );
    const simulations = listed.body.simulations as Record<string, unknown>[];
    expect(simulations.length).toBeGreaterThan(0);
    for (const one of simulations) {
      expect(Object.hasOwn(one, "conductedAgentVersion")).toBe(false);
    }
  });

  it("refuses to write a run whose world was never read", async () => {
    // The guard that makes "never a silent conduct against an unread world" a
    // property of the write rather than a habit of one caller. The route reads
    // first and fails loudly; this is what happens if some later caller forgets
    // to — a refusal, rather than a run conducted against a world nobody
    // looked at, carrying a coverage stamp nobody checked.
    const { ada, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "text_mode_unread_world_refused",
      TEXT_MODE,
    );

    await expect(
      startRun(contextFor(ada, "member"), {
        suiteId,
        agentId,
        connectionId,
        idempotencyKey: newId("run"),
      }),
    ).rejects.toThrow(/without the run-start read of the agent's platform/u);

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("is absent on a run that pinned none", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("text_mode_stamp_absent", RETELL_CHAT);

    const started = await startRun(contextFor(ada, "member"), {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });

    const header = await ask(api.app, "GET", `/v1/runs/${started.id}`, key);
    expect(header.body.agentVersion).toBeNull();
  });

  it("refuses a run whose connection was edited between the read and the write", async () => {
    // The race the run route cannot hold a lock across: the world is read from
    // the connection over the network, before the run's transaction opens, so
    // an edit can land in between — the agent moved, the address changed, the
    // key rotated — and the version and tools frozen from the old target would
    // be stamped onto a run whose record names the new one. Reproduced exactly:
    // read the reach's stamp, land an edit, then start the run with the stamp
    // the world was read at.
    const { ada, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("text_mode_connection_raced", TEXT_MODE);
    const who = contextFor(ada, "member");

    const reach = await resolveRunStartReach(who, agentId, connectionId);
    expect(reach).toBeDefined();
    if (reach === undefined) return;

    // The edit lands after the world was read: the agent, the address and the
    // key all move.
    await updateConnection(who, agentId, connectionId, {
      config: { retellAgentId: "agent_moved_elsewhere" },
      credentials: { apiKey: "retell-secret-ROTATED-4321" },
    });

    await expect(
      startRun(who, {
        suiteId,
        agentId,
        connectionId,
        idempotencyKey: newId("run"),
        agentVersion: SERVING_VERSION,
        conductedConnectionIdentity: reach.connectionIdentity,
      }),
    ).rejects.toThrow(/was edited while Egma was reading the agent's platform/u);

    // Nothing was written: a run stamped with a world from one target and a
    // snapshot of another never reached the record.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("refuses even when the edit shares the connection's millisecond", async () => {
    // The reason the token is the identity and not a clock. `updated_at` lands
    // on the millisecond, so an edit inside the same millisecond as the read
    // would carry an equal timestamp — and a timestamp guard would wave it
    // through. Here the identity-bearing config is changed while `updated_at`
    // is pinned back to the exact value the read saw, the pathological case a
    // clock cannot tell from no edit at all. The fingerprint is over the
    // config and the sealed key, so it catches it regardless.
    const { ada, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("text_mode_connection_same_ms", TEXT_MODE);
    const who = contextFor(ada, "member");

    const [before] = (
      await api.database.sql<{ updated_at: string }>(
        "select updated_at from connection where id = $1",
        [connectionId],
      )
    ).rows;
    const reach = await resolveRunStartReach(who, agentId, connectionId);
    expect(reach).toBeDefined();
    if (reach === undefined || before === undefined) return;

    // The agent moves, and `updated_at` is put back to what the read saw — so
    // the row's timestamp is byte-for-byte the reach's, and only the identity
    // has changed.
    await api.database.sql(
      "update connection set config = $1::jsonb, updated_at = $2 where id = $3",
      [
        JSON.stringify({ retellAgentId: "agent_same_millisecond" }),
        before.updated_at,
        connectionId,
      ],
    );

    await expect(
      startRun(who, {
        suiteId,
        agentId,
        connectionId,
        idempotencyKey: newId("run"),
        agentVersion: SERVING_VERSION,
        conductedConnectionIdentity: reach.connectionIdentity,
      }),
    ).rejects.toThrow(/was edited while Egma was reading the agent's platform/u);

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("writes the run when the connection held still through the read", async () => {
    // The same path with no edit: the fingerprint the world was read at still
    // equals the connection under the lock, so the world and the target agree
    // and the run is written.
    const { ada, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("text_mode_connection_still", TEXT_MODE);
    const who = contextFor(ada, "member");

    const reach = await resolveRunStartReach(who, agentId, connectionId);
    expect(reach).toBeDefined();
    if (reach === undefined) return;

    const started = await startRun(who, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
      agentVersion: SERVING_VERSION,
      conductedConnectionIdentity: reach.connectionIdentity,
    });
    expect(started.agentVersion).toBe(SERVING_VERSION);
  });
});

describe("what a version-pinned run's landing records", () => {
  it("leaves the coverage stamp to the seam that owns it, and takes no provider reference", async () => {
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun(
        "text_mode_stamp_coverage",
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
      agentVersion: SERVING_VERSION,
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
    // text mode stores nothing on Retell's side, so there is no id to hold the
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
    // **No stamp, and that is the settled answer.** The coverage stamp is the
    // LiveKit in-room seam's, where the agent declares its tools per
    // conversation and two simulations of one run can honestly differ. This
    // lane decides what it answers for once per run and marks each answered
    // call on the transcript, so a per-simulation copy would be a second
    // version of a fact that cannot differ. Absent is the report saying nobody
    // was ever asked — a different sentence from three empty lists.
    expect(row?.mockToolCoverage).toBeNull();
    expect(row?.providerReference).toBeNull();

    // What the run conducted against lives on the run, once.
    const header = await ask(api.app, "GET", `/v1/runs/${row?.runId}`, key);
    expect(header.body.agentVersion).toBe(SERVING_VERSION);
  });
});

describe("the work order a version-pinned run hands over", () => {
  it("carries the version, this simulation's variables, and what the run resolved", async () => {
    const { key, agentId, connectionId, suiteId } = await aCustomerReadyToRun(
      "text_mode_claim",
      TEXT_MODE,
    );

    // One answer per class of tool the agent has.
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

    // Started over the door, so the version on the work order is the one the
    // run-start read actually resolved from the platform rather than one this
    // test handed in.
    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

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

    // The connection block the plug reads, exactly as it expects it.
    expect(spec.connection).toEqual({
      agent_platform: "retell",
      connection_type: "retell_text_mode",
      access_variant: "retell_text_mode.api_key",
      config: { retellAgentId: PLATFORM_AGENT },
      credentials: { apiKey: SENTINEL_KEY },
    });

    // Always sent. The plug would conduct without it and the platform would
    // then choose its newest version, which a concurrent edit can move.
    expect(spec.agent_version).toBe(SERVING_VERSION);

    // Egma's own attribution variable, carrying this simulation and nothing
    // else — it is what a tool call the platform makes rides back on.
    expect(spec.dynamic_variables).toEqual({
      egma_simulation: spec.simulation_id,
    });

    // **What the run resolved, unfiltered.** The three-class read is computed
    // live for the enable-time screen and stored nowhere, so there is no
    // stored list here to filter by. Retell answers for a name or runs the
    // customer's real implementation, and the record marks a call `mocked`
    // when the run's snapshot covers its name — the live text-mode e2e is the
    // gate that proves the wire.
    expect(spec.mock_tools).toEqual([
      {
        tool_name: "check_availability",
        answer: { answer: { ok: "check_availability" } },
        // Delays ride along on every lane and are never spent on chat.
        delay_milliseconds: 250,
      },
      {
        tool_name: "transfer_to_front_desk",
        answer: { answer: { ok: "transfer_to_front_desk" } },
        delay_milliseconds: 0,
      },
      {
        tool_name: "inventory",
        answer: { answer: { ok: "inventory" } },
        delay_milliseconds: 500,
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

  it("carries no answers at all when the connection's switch is off", async () => {
    // **A text run with the switch off goes real.** The switch is on the
    // connection and the run froze it at start, so whether a run is mocked is
    // read from its own snapshot on every lane — never from the connection
    // row, which may have moved since.
    const { ada, key, agentId, connectionId, suiteId } =
      await aCustomerReadyToRun("text_mode_claim_unmocked", TEXT_MODE);

    const authored = await ask(api.app, "POST", "/v1/mock-tools", key, {
      tool: "check_availability",
      answer: { ok: true },
      delayMs: 0,
    });
    expect(authored.statusCode, JSON.stringify(authored.body)).toBe(201);

    const untick = await ask(
      api.app,
      "PATCH",
      `/v1/agents/${agentId}/connections/${connectionId}`,
      key,
      { mockToolsEnabled: false },
    );
    expect(untick.statusCode, JSON.stringify(untick.body)).toBe(200);

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId,
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.mockToolsEnabled).toBe(false);

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: { claimant: "simulator-blue-1", capacity: 5, contract_versions: [5] },
    });
    const spec = (claimed.json() as { specs: Record<string, unknown>[] })
      .specs[0] as Record<string, unknown>;

    // No answers at all — an empty list would be a claim about tools where
    // there is nothing to claim. The version is still named, because a chat
    // result speaks for the version real traffic reaches either way.
    expect(spec.mock_tools).toBeUndefined();
    expect(spec.agent_version).toBe(SERVING_VERSION);
    void ada;
  });
});
