import { newId } from "@egma/ids";
import { createPersona } from "@egma/db";
import { SIMULATION_VARIABLE } from "@egma/retell";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { MOCK_TOOL_PREFIX } from "../src/routes/mock-endpoint.ts";
import { reportPathFor } from "../src/routes/reports.ts";
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
 * One mocked run, end to end, against a Retell that exists only in this file.
 *
 * The whole promise in one walk: a developer ticks the box, starts a run, and
 * every step of the mocked world happens — a temporary version branched from
 * the exact version the agent serves, its tools pointed at Egma, the live
 * version untouched, each simulation conducted against the temporary version,
 * a tool call answered from the run's frozen world and landed on the record
 * with `mocked` provenance and the three-class stamp, and the temporary version
 * deleted when the run ends.
 *
 * And the other half of the promise beside it: a run whose world cannot be
 * built is refused with the reason, before a single simulation is conducted,
 * with nothing written to the version the customer's callers are served from.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const FLOW = "conversation_flow_2346a0e8367c";
const CONDUCTOR = "sim-under-test";
const KEY = "retell-secret-A1B2C3D4WXYZ";

const LIVE_TOOL_URL = "https://backend.example.com/tools/get_availability";

const FLOW_TOOLS = [
  {
    tool_id: "tool-get_availability",
    type: "custom",
    name: "get_availability",
    description: "Look up open appointment slots.",
    url: LIVE_TOOL_URL,
    method: "POST",
    headers: { Authorization: "Bearer sk_live_FIXTURESECRET" },
    parameters: { type: "object", properties: {} },
    response_variables: { slots: "$.slots" },
  },
  {
    tool_id: "tool-transfer",
    type: "transfer_call",
    name: "transfer_to_front_desk",
    description: "Hands the caller to a person.",
  },
];

type Account = {
  /** How branching treats the engine: `share` is what the fork guard is for. */
  readonly branching?: "fork" | "share";
  readonly numbers?: readonly Record<string, unknown>[];
  /** Read afterwards, so a test can say what the account looks like now. */
  readonly state: {
    versions: Set<number>;
    engines: Map<number, Record<string, unknown>>;
    bindings: Map<string, readonly Record<string, unknown>[]>;
  };
};

function anAccount(options: { branching?: "fork" | "share" } = {}): {
  readonly fetchImpl: typeof fetch;
  readonly state: Account["state"];
} {
  const state: Account["state"] = {
    versions: new Set([105]),
    engines: new Map([[105, { conversation_flow_id: FLOW, version: 105, tools: structuredClone(FLOW_TOOLS) }]]),
    bindings: new Map([
      ["+12567332874", [{ agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 }]],
    ]),
  };
  const branching = options.branching ?? "fork";

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    // The path Retell's own address would carry, whatever host the caller
    // reached: this account answers wherever Egma sends a request.
    const path = new URL(url).pathname;

    if (path.includes("/v2/list-agents")) {
      return json({
        items: [
          { agent_id: RETELL_AGENT, agent_name: "After hours", channel: "voice" },
        ],
        has_more: false,
      });
    }
    if (path.startsWith("/v2/list-phone-numbers")) {
      return json({
        items: [...state.bindings].map(([number, inbound]) => ({
          phone_number: number,
          nickname: "After hours",
          inbound_agents: inbound,
        })),
        has_more: false,
      });
    }
    if (method === "PATCH" && path.startsWith("/update-phone-number/")) {
      const number = decodeURIComponent(path.slice("/update-phone-number/".length));
      state.bindings.set(
        number,
        body?.["inbound_agents"] as readonly Record<string, unknown>[],
      );
      return json({ phone_number: number });
    }
    if (path.startsWith("/get-agent/")) {
      const asked = new URL(url).searchParams.get("version") ?? "latest";
      const version =
        asked === "latest" ? Math.max(...state.versions) : Number(asked);
      if (!state.versions.has(version)) return json({ error: "gone" }, 404);
      return json({
        agent_id: RETELL_AGENT,
        version,
        is_published: version === 105,
        response_engine: {
          type: "conversation-flow",
          conversation_flow_id: FLOW,
          version,
        },
      });
    }
    if (path.startsWith("/get-conversation-flow/")) {
      const asked = Number(new URL(url).searchParams.get("version"));
      const document = state.engines.get(asked);
      return document === undefined
        ? json({ error: "gone" }, 404)
        : json(structuredClone(document));
    }
    if (method === "POST" && path.startsWith("/create-agent-version/")) {
      const base = Number(body?.["base_version"]);
      const next = Math.max(...state.versions) + 1;
      const engineVersion = branching === "share" ? base : next;
      if (branching !== "share") {
        state.engines.set(
          engineVersion,
          structuredClone(state.engines.get(base) ?? {}),
        );
      }
      state.versions.add(next);
      return json({
        agent_id: RETELL_AGENT,
        version: next,
        is_published: false,
        response_engine: {
          type: "conversation-flow",
          conversation_flow_id: FLOW,
          version: engineVersion,
        },
      });
    }
    if (method === "PATCH" && path.startsWith("/update-conversation-flow/")) {
      const asked = Number(new URL(url).searchParams.get("version"));
      const document = state.engines.get(asked);
      if (document === undefined) return json({ error: "gone" }, 404);
      Object.assign(document, structuredClone(body ?? {}));
      return json(document);
    }
    if (method === "DELETE" && path.startsWith("/delete-agent-version/")) {
      const asked = Number(path.split("/").at(-1));
      if (!state.versions.has(asked)) return json({ error: "gone" }, 404);
      state.versions.delete(asked);
      state.engines.delete(asked);
      return json({ deleted: true });
    }
    throw new Error(`Unexpected Retell request: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, state };
}

type Ready = {
  readonly ada: Customer;
  readonly key: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly suiteId: string;
  readonly state: Account["state"];
};

/** A ticked Retell agent with one test, ready for a run. */
async function aTickedAgent(
  label: string,
  options: { branching?: "fork" | "share" } = {},
): Promise<Ready> {
  const account = anAccount(options);
  api = await createApi(label, {
    traceStore: true,
    retellFetch: account.fetchImpl,
    mockToolWait: async () => undefined,
  });
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

  // The tick, with consent to pin the number that rides `latest`.
  const ticked = await ask(api.app, "PATCH", `/v1/agents/${agentId}`, key, {
    mockToolsDuringSimulations: true,
    pinNumbersDuringRuns: true,
  });
  expect(ticked.statusCode, JSON.stringify(ticked.body)).toBe(200);

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
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

  return {
    ada,
    key,
    agentId,
    connectionId,
    suiteId: String(suite.body.id),
    state: account.state,
  };
}

async function claim(): Promise<Record<string, unknown>[]> {
  const claimed = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: {
      claimant: CONDUCTOR,
      capacity: 50,
      wait_seconds: 0,
      contract_versions: [5],
    },
  });
  expect(claimed.statusCode, claimed.body).toBe(200);
  return (JSON.parse(claimed.body) as { specs: Record<string, unknown>[] })
    .specs;
}

async function report(
  simulationId: string,
  status: "running" | "completed",
): Promise<void> {
  const answered = await api.app.inject({
    method: "POST",
    url: reportPathFor(simulationId),
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: {
      contract_version: 1,
      simulation_id: simulationId,
      events: [
        status === "running"
          ? {
              kind: "status",
              event_id: "evt-000001",
              at: "2026-08-05T09:00:00.000000Z",
              status: "running",
              reason: null,
            }
          : {
              kind: "status",
              event_id: "evt-000002",
              at: "2026-08-05T09:01:00.000000Z",
              status: "completed",
              reason: "agent_ended",
              facts: {
                ending: "agent_ended",
                started_at: "2026-08-05T09:00:00.000000Z",
                ended_at: "2026-08-05T09:01:00.000000Z",
                turn_count: 6,
                audio: null,
                provider_reference: null,
              },
            },
      ],
    },
  });
  expect(answered.statusCode, answered.body).toBe(200);
}

describe("one mocked run, from the tick to the teardown", () => {
  it("branches, swaps, conducts, records, and gives the account back", async () => {
    const ready = await aTickedAgent("mocked_run_end_to_end");

    const started = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    // The world, as the run recorded it.
    const header = await ask(api.app, "GET", `/v1/runs/${runId}`, ready.key);
    const world = header.body.mockedWorld as {
      servingVersion: number;
      draftVersion: number;
      coverage: Record<string, string[]>;
      numbers: { number: string; pinned: boolean }[];
    };
    expect(world.servingVersion).toBe(105);
    expect(world.draftVersion).toBe(106);
    expect(world.coverage).toEqual({
      mocked: ["get_availability"],
      notInterceptable: ["transfer_to_front_desk"],
      notInThisVersion: [],
    });
    expect(world.numbers).toEqual([
      {
        number: "+12567332874",
        pinned: true,
        bindings: [
          { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
        ],
      },
    ]);

    // The account, as it stands mid-run: the temporary version points at Egma,
    // the serving version is exactly as it was, and the number that rode
    // `latest` is pinned to a real version so a caller reaches the real agent.
    const draftTools = (ready.state.engines.get(106)?.["tools"] ??
      []) as Record<string, unknown>[];
    expect(String(draftTools[0]?.["url"])).toContain(
      `${MOCK_TOOL_PREFIX}/${runId}/{{${SIMULATION_VARIABLE}}}/get_availability`,
    );
    expect(draftTools[0]?.["headers"]).toEqual({});
    const servingTools = (ready.state.engines.get(105)?.["tools"] ??
      []) as Record<string, unknown>[];
    expect(servingTools[0]?.["url"]).toBe(LIVE_TOOL_URL);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: 105, weight: 2 },
    ]);

    // The claim hands the simulation the temporary version and its variables.
    const specs = await claim();
    expect(specs).toHaveLength(1);
    const spec = specs[0] as Record<string, unknown>;
    const simulationId = String(spec["simulation_id"]);
    expect(spec["agent_version"]).toBe(106);
    expect(spec["dynamic_variables"]).toEqual({
      [SIMULATION_VARIABLE]: simulationId,
    });
    // And its answers, resolved from the run's frozen world.
    expect(spec["mock_tools"]).toEqual([
      {
        tool_name: "get_availability",
        answer: { answer: { slots: "" } },
        delay_milliseconds: 0,
      },
    ]);

    await report(simulationId, "running");

    // The tool call, arriving at the address the transform wrote.
    const answered = await api.app.inject({
      method: "POST",
      url:
        `${MOCK_TOOL_PREFIX}/${encodeURIComponent(runId)}` +
        `/${encodeURIComponent(simulationId)}/get_availability`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ service: "facial" }),
    });
    expect(answered.statusCode, answered.body).toBe(200);
    // The answer the tick seeded, derived from the tool's own declaration.
    expect(JSON.parse(answered.body)).toEqual({ slots: "" });

    await report(simulationId, "completed");

    // The record: the exchange, with `mocked` provenance naming the mock tool.
    const store = api.traceStore;
    if (store === undefined) throw new Error("this API has no trace store");
    const spans = await store.rows<{
      tool_name: string;
      tool_arguments: string;
      tool_result: string;
      payload: string;
    }>(
      `select tool_name, tool_arguments, tool_result, payload from spans final ` +
        `where trace_id = '${traceIdOfSimulation(simulationId)}' and kind = 'tool'`,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.tool_name).toBe("get_availability");
    expect(spans[0]?.tool_arguments).toBe(JSON.stringify({ service: "facial" }));
    expect(spans[0]?.tool_result).toBe(JSON.stringify({ slots: "" }));
    const payload = JSON.parse(spans[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    expect(payload["egma.tool.mock_tool"]).toMatch(/^mck_/u);

    // The stamp, in all three classes, on the simulation's own row.
    const page = await ask(
      api.app,
      "GET",
      `/v1/runs/${runId}/simulations`,
      ready.key,
    );
    const simulation = (page.body.simulations as Record<string, unknown>[])[0];
    expect(simulation?.["mockToolCoverage"]).toEqual({
      discovered: ["get_availability", "transfer_to_front_desk"],
      covered: ["get_availability"],
      uncovered: ["transfer_to_front_desk"],
      notInterceptable: ["transfer_to_front_desk"],
      notInThisVersion: [],
    });

    // And the account, given back: the temporary version deleted first, then
    // the number's routing restored exactly as it was read.
    expect(ready.state.versions.has(106)).toBe(false);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);
    const settled = await ask(api.app, "GET", `/v1/runs/${runId}`, ready.key);
    expect(
      (settled.body.mockedWorld as { draftVersion: number | null }).draftVersion,
    ).toBeNull();
    expect(
      (settled.body.mockedWorld as { numbers: { pinned: boolean }[] }).numbers[0]
        ?.pinned,
    ).toBe(false);
  });
});

describe("a run whose world cannot be built", () => {
  it("is refused with the reason, before a single simulation is conducted", async () => {
    // The fork guard's case: Retell answers a branch that still points at the
    // serving version's own engine version.
    const ready = await aTickedAgent("mocked_run_unbuildable", {
      branching: "share",
    });

    const refused = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toBe("mocked_world_unbuildable");
    expect(String(refused.body.message)).toContain("wrote nothing and stopped");

    // Nothing was written to the version the customer's callers are served
    // from, and no simulation was ever claimable.
    const servingTools = (ready.state.engines.get(105)?.["tools"] ??
      []) as Record<string, unknown>[];
    expect(servingTools[0]?.["url"]).toBe(LIVE_TOOL_URL);
    expect(await claim()).toEqual([]);

    // The stray version it minted was given back, and so was the number.
    expect(ready.state.versions.has(106)).toBe(false);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);
  });
});
