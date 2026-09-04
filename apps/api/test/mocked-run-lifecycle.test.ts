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
 * The whole promise in one walk: a developer writes a test that names the tools
 * it mocks, starts a run, and every step of the mocked world happens — a
 * temporary version branched from the exact version the agent serves, its tools
 * pointed at Egma, the live version untouched, each simulation conducted
 * against the temporary version, a tool call answered from the pinned test
 * version and landed on the record with `mocked` provenance, and the temporary
 * version deleted when the run ends.
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
    /**
     * Which of those versions Retell has published.
     *
     * Kept apart from `versions` because it is what the serving read now turns
     * on: `latest_published` resolves out of this set, and an account with
     * nothing in it is an agent a run is refused for.
     */
    published: Set<number>;
    engines: Map<number, Record<string, unknown>>;
    bindings: Map<string, readonly Record<string, unknown>[]>;
    /** Flipped by a test to make every delete fail — a teardown that cannot
     * finish, which is what leaves a world owed. */
    refuseDeletes: boolean;
    /**
     * Held by a test to stop **one** teardown inside its delete, so that a
     * second caller arrives while the first is halfway through putting the
     * account back. Consumed the first time it is used, so whoever comes next
     * is not stopped too.
     */
    holdOneDelete?: Promise<void> | undefined;
    /** Called as that delete arrives, so a test knows the teardown is inside. */
    onDelete?: () => void;
    /** Called as a version is branched, so a test knows a copy now stands. */
    onBranch?: () => void;
    /**
     * Every binding this account was asked to write, with the versions that
     * stood at the moment it was asked.
     *
     * A restore that lands while a newer version stands is the hijack itself:
     * `latest` written back onto somebody's temporary copy. What a test asserts
     * is not the order of two requests but that this never happened.
     */
    writes: { wrote: unknown; versionsStanding: number[] }[];
  };
};

function anAccount(
  options: {
    branching?: "fork" | "share";
    /** Whether the agent's one version is published. It is, unless said not. */
    published?: boolean;
  } = {},
): {
  readonly fetchImpl: typeof fetch;
  readonly state: Account["state"];
} {
  const state: Account["state"] = {
    versions: new Set([105]),
    published: new Set((options.published ?? true) ? [105] : []),
    engines: new Map([[105, { conversation_flow_id: FLOW, version: 105, tools: structuredClone(FLOW_TOOLS) }]]),
    bindings: new Map([
      ["+12567332874", [{ agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 }]],
    ]),
    refuseDeletes: false,
    writes: [],
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
    if (method === "GET" && path.startsWith("/get-phone-number/")) {
      // The restore reads the number before it writes, so this account has to
      // answer for one number as well as for the listing.
      const number = decodeURIComponent(path.slice("/get-phone-number/".length));
      const inbound = state.bindings.get(number);
      if (inbound === undefined) return json({ error: "gone" }, 404);
      return json({
        phone_number: number,
        nickname: "After hours",
        inbound_agents: inbound,
      });
    }
    if (method === "PATCH" && path.startsWith("/update-phone-number/")) {
      const number = decodeURIComponent(path.slice("/update-phone-number/".length));
      const inbound = body?.["inbound_agents"] as readonly Record<string, unknown>[];
      state.writes.push({
        wrote: inbound.map((one) => one["agent_version"]),
        versionsStanding: [...state.versions],
      });
      state.bindings.set(number, inbound);
      return json({ phone_number: number });
    }
    if (path.startsWith("/list-agent-versions/")) {
      // Retell's current listing, which is what a teardown proves a deletion
      // with. The legacy `/get-agent-versions` retires 2026-09-15 and this
      // account deliberately has no route for it.
      return json({
        items: [...state.versions].map((version) => ({
          version,
          is_published: state.published.has(version),
        })),
        has_more: false,
      });
    }
    if (path.startsWith("/get-agent/")) {
      const asked = new URL(url).searchParams.get("version") ?? "latest";
      const standing = [...state.versions];
      const published = standing.filter((one) => state.published.has(one));
      const version =
        asked === "latest"
          ? Math.max(...standing)
          : asked === "latest_published"
            ? (published.length === 0 ? Number.NaN : Math.max(...published))
            : Number(asked);
      if (!state.versions.has(version)) return json({ error: "gone" }, 404);
      return json({
        agent_id: RETELL_AGENT,
        version,
        is_published: state.published.has(version),
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
        state.engines.set(engineVersion, {
          ...structuredClone(state.engines.get(base) ?? {}),
          // A forked flow document reports its own version rather than the one
          // it was forked from — and that field is where Egma reads whether a
          // write landed in place or minted a version nothing can delete.
          version: engineVersion,
        });
      }
      state.versions.add(next);
      state.onBranch?.();
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
      const holding = state.holdOneDelete;
      if (holding !== undefined) {
        state.holdOneDelete = undefined;
        state.onDelete?.();
        await holding;
      }
      if (state.refuseDeletes) return json({ error: "not today" }, 500);
      // The version rides in the query string. Retell's router has no
      // path-segment route for it and answers that shape 404 "Cannot DELETE",
      // which Egma once read as "already deleted".
      const named = new URL(url).searchParams.get("version");
      if (named === null) return json({ error: "Cannot DELETE" }, 404);
      const asked = Number(named);
      if (!state.versions.has(asked)) return json({ error: "gone" }, 404);
      state.versions.delete(asked);
      state.published.delete(asked);
      // The flow version stays: Retell keeps it and offers no way to remove
      // one (verified live, 2026-08-31).
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

/**
 * A Retell agent with one test that carries its own mock tools, ready for a
 * run.
 *
 * The tools are named by the test and by nothing else: there is no switch on
 * the connection and no project list to seed, so a run is mocked exactly when
 * a test of it named a tool.
 */
async function anAgentReadyToRun(
  label: string,
  options: {
    branching?: "fork" | "share";
    published?: boolean;
    /** What the one test mocks. An empty list is a test that mocks nothing. */
    mockTools?: readonly Record<string, unknown>[];
  } = {},
): Promise<Ready> {
  const account = anAccount(options);
  api = await createApi(label, {
    traceStore: true,
    retellFetch: account.fetchImpl,
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
    mockTools: options.mockTools ?? [
      { tool: "get_availability", answer: { slots: ["Tuesday 14:00"] } },
    ],
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

describe("one mocked run, from the test to the teardown", () => {
  it("branches, swaps, conducts, records, and gives the account back", async () => {
    const ready = await anAgentReadyToRun("mocked_run_end_to_end");

    const started = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    // The four fields, as the run recorded them.
    const header = await ask(api.app, "GET", `/v1/runs/${runId}`, ready.key);
    expect(header.body.agentVersion).toBe(105);
    expect(header.body.tempMockAgentVersion).toBe(106);
    expect(header.body.tempMockAgentVersionCleanup).toBe(false);
    // The note names the engine this run's tools were read from, and claims
    // nothing about anything of the customer's — because Egma touched none of
    // it.
    expect(header.body.mockMetadata).toEqual({
      engine: {
        type: "conversation-flow",
        engineId: FLOW,
        version: 105,
      },
    });

    // The account, as it stands mid-run: the temporary version points at Egma,
    // the serving version is exactly as it was, and the number that rides
    // `latest` is exactly as the customer left it.
    const draftTools = (ready.state.engines.get(106)?.["tools"] ??
      []) as Record<string, unknown>[];
    expect(String(draftTools[0]?.["url"])).toContain(
      `${MOCK_TOOL_PREFIX}/${runId}/{{${SIMULATION_VARIABLE}}}/get_availability`,
    );
    expect(draftTools[0]?.["headers"]).toEqual({});
    expect(draftTools[0]?.["query_params"]).toEqual({});
    const servingTools = (ready.state.engines.get(105)?.["tools"] ??
      []) as Record<string, unknown>[];
    expect(servingTools[0]?.["url"]).toBe(LIVE_TOOL_URL);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
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
    // And its answers, straight off the pinned test version.
    expect(spec["mock_tools"]).toEqual([
      {
        tool_name: "get_availability",
        answer: { answer: { slots: ["Tuesday 14:00"] } },
      },
    ]);

    await report(simulationId, "running");

    // The tool call, arriving the way Retell's would. The endpoint is keyed on
    // the simulation alone; the URL the transform writes still carries the run
    // as well, and the two are joined back up when the transform is rewritten
    // onto per-tool variables.
    const answered = await api.app.inject({
      method: "POST",
      url:
        `${MOCK_TOOL_PREFIX}/${encodeURIComponent(simulationId)}` +
        `/get_availability`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ service: "facial" }),
    });
    expect(answered.statusCode, answered.body).toBe(200);
    // The answer the test named, and nothing derived from anywhere else.
    expect(JSON.parse(answered.body)).toEqual({ slots: ["Tuesday 14:00"] });

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
    expect(spans[0]?.tool_result).toBe(
      JSON.stringify({ slots: ["Tuesday 14:00"] }),
    );
    const payload = JSON.parse(spans[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    expect(payload["egma.tool.mock_tool"]).toBe("get_availability");

    // **No coverage anywhere on the record, and that is the settled answer.**
    // A simulation is answered for what its own test named, and every answered
    // call is on the transcript — which the span above is. A second, summarised
    // version of the same fact is a field two readers could disagree about.
    const page = await ask(
      api.app,
      "GET",
      `/v1/runs/${runId}/simulations`,
      ready.key,
    );
    const simulation = (page.body.simulations as Record<string, unknown>[])[0];
    expect(simulation).toBeDefined();
    expect("mockToolCoverage" in (simulation ?? {})).toBe(false);

    // And the account, given back: the temporary version deleted first, then
    // the number's routing restored exactly as it was read.
    expect(ready.state.versions.has(106)).toBe(false);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);
    const settled = await ask(api.app, "GET", `/v1/runs/${runId}`, ready.key);
    // The flag says the account is back. The version number and the note stay:
    // they are the record of what this run branched and what it put back.
    expect(settled.body.tempMockAgentVersionCleanup).toBe(true);
    expect(settled.body.tempMockAgentVersion).toBe(106);
  });
});

describe("a web-call run whose tests mock nothing", () => {
  it("still records the version it conducted against, and branches nothing", async () => {
    // The same agent and the same lane, with a test that names no tool. What
    // changes is the mocked world, not whether Egma knows which version
    // answered: a result nobody can tie to a version is a result nobody can act
    // on, mocked or not.
    const ready = await anAgentReadyToRun("web_call_unmocked_row", {
      mockTools: [],
    });

    const started = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    // The fourth sample row of the four-field table: one version, three nulls.
    const header = await ask(
      api.app,
      "GET",
      `/v1/runs/${String(started.body.id)}`,
      ready.key,
    );
    expect(header.body.agentVersion).toBe(105);
    expect(header.body.tempMockAgentVersion).toBeNull();
    expect(header.body.tempMockAgentVersionCleanup).toBeNull();
    expect(header.body.mockMetadata).toBeNull();

    // And the account is untouched: no version was branched, and the number
    // that rides `latest` was never repointed.
    expect([...ready.state.versions]).toEqual([105]);
    expect(ready.state.writes).toEqual([]);

    // **The record and the call agree.** A run row naming a version the call
    // did not target would be a result tied to the wrong agent, which is the
    // whole thing the pinning exists to prevent. There is no temporary copy on
    // this lane, so what the work order carries is the version run start
    // pinned — and the simulator sends exactly that as `agent_version` on
    // create-web-call.
    const [spec] = await claim();
    expect(spec?.["agent_version"]).toBe(105);
  });
});

describe("a run over a Retell lane against an agent that publishes nothing", () => {
  it("is refused before any run row exists, and names both doors", async () => {
    const ready = await anAgentReadyToRun("web_call_never_published", {
      published: false,
    });

    const refused = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });

    // A settled fact about the agent, not a bad moment: 422, not 503.
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    const message = String(refused.body.message);
    expect(message).toContain("no published version");
    // Door one, and door two.
    expect(message).toContain("Publish in Retell the version you want tested");
    expect(message).toContain("pin a Retell phone number that routes to this agent");
    expect(JSON.stringify(refused.body)).not.toContain(KEY);

    // Nothing was started, and that is a fact about the record rather than a
    // sentence: no run row, so no simulation can ever be conducted against a
    // version nobody chose.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*)::text as count from run",
    );
    expect(rows[0]?.count).toBe("0");

    // And nothing was written to Retell: no branch, no pin.
    expect([...ready.state.versions]).toEqual([105]);
    expect(ready.state.writes).toEqual([]);
  });

  it("conducts the run once that version is published", async () => {
    const ready = await anAgentReadyToRun("web_call_published_after", {
      published: false,
    });
    // The developer takes door one.
    ready.state.published.add(105);

    const started = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.agentVersion).toBe(105);
  });
});

describe("a run whose world cannot be built", () => {
  it("is refused with the reason, before a single simulation is conducted", async () => {
    // The fork guard's case: Retell answers a branch that still points at the
    // serving version's own engine version.
    const ready = await anAgentReadyToRun("mocked_run_unbuildable", {
      branching: "share",
    });

    const refused = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toBe("mock_tools_unbuildable");
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

/**
 * Two mocked runs of one agent overlapping is a hijack, not a queue.
 *
 * The first run pins a number riding `latest` and owes that binding back. If a
 * second run branched its own draft in the meantime, the first run's teardown
 * would restore `latest` onto the second run's draft — the newest version — and
 * real callers would reach a mocked agent. So the second run is refused.
 */
describe("a second mocked run on an agent already holding its world", () => {
  it("is refused with the reason, and writes nothing to the platform", async () => {
    const ready = await anAgentReadyToRun("mocked_run_second_refused");

    const first = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const firstRunId = String(first.body.id);
    // The first run holds the world: its draft exists and the number is pinned.
    expect(ready.state.versions.has(106)).toBe(true);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    const before = {
      versions: new Set(ready.state.versions),
      bindings: JSON.stringify([...ready.state.bindings]),
    };

    const second = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });

    // Refused as a conflict, naming the run to wait for.
    expect(second.statusCode, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error).toBe("mock_tools_agent_in_use");
    expect(String(second.body.message)).toContain(firstRunId);
    expect(String(second.body.message)).toContain("one mocked world per agent");

    // **Nothing reached the platform**: no second draft was branched, and the
    // first run's pin is exactly as it was.
    expect([...ready.state.versions].sort()).toEqual([...before.versions].sort());
    expect(JSON.stringify([...ready.state.bindings])).toBe(before.bindings);

    // And the first run's own record is untouched, still holding its copy.
    const header = await ask(api.app, "GET", `/v1/runs/${firstRunId}`, ready.key);
    expect(header.body.tempMockAgentVersion).toBe(106);
    expect(header.body.tempMockAgentVersionCleanup).toBe(false);

    // The refused run conducts nothing: only the first run's simulation is
    // ever claimable.
    const specs = await claim();
    expect(specs).toHaveLength(1);
    expect(String(specs[0]?.["agent_version"])).toBe("106");
  });

  it("lets the next run build once the first has finished and given the account back", async () => {
    const ready = await anAgentReadyToRun("mocked_run_second_after_teardown");

    const first = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);

    // Conduct the first run to its end, which tears its world down.
    const specs = await claim();
    const simulationId = String(specs[0]?.["simulation_id"]);
    await report(simulationId, "running");
    await report(simulationId, "completed");
    expect(ready.state.versions.has(106)).toBe(false);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    // Now the agent is free, and the next run builds its own world normally.
    const second = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(second.statusCode, JSON.stringify(second.body)).toBe(201);
    const header = await ask(
      api.app,
      "GET",
      `/v1/runs/${String(second.body.id)}`,
      ready.key,
    );
    // A fresh copy of its own, branched from the same serving version.
    expect(header.body.agentVersion).toBe(105);
    const branched = header.body.tempMockAgentVersion as number;
    expect(branched).toBeGreaterThan(105);
    expect(ready.state.versions.has(branched)).toBe(true);
  });
});

/**
 * The teardown and the next run's claim, meeting.
 *
 * A finished run never blocks a claim — its litter is the next run's sweep to
 * clear — so the two really do arrive at once every time a suite is started
 * again as soon as the last one ends. Without one fence over both, the first
 * run's delete is still in flight while the second branches its copy, and
 * Retell hands the next branch the lowest free number: the number the first
 * run is in the middle of deleting is the number the second is given. One
 * teardown would then delete the other run's live copy, and nothing downstream
 * could tell whose version it had been.
 */
describe("a teardown that is in flight when the next run starts", () => {
  it("makes the next run wait for it, and touches no binding either way", async () => {
    const ready = await anAgentReadyToRun("mocked_run_teardown_meets_claim");

    const first = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const specs = await claim();
    const simulationId = String(specs[0]?.["simulation_id"]);
    await report(simulationId, "running");

    // Stop the first run's teardown inside its delete, so the second run
    // arrives while the account still holds the copy and the pin.
    let release = (): void => undefined;
    ready.state.holdOneDelete = new Promise<void>((resume) => {
      release = () => {
        resume();
      };
    });
    const insideTheTeardown = new Promise<void>((reached) => {
      ready.state.onDelete = () => {
        reached();
      };
    });

    const landing = report(simulationId, "completed");
    await insideTheTeardown;

    // The next run, started now: its claim finds a finished run, which does
    // not block it, and it must still wait for the teardown to finish.
    const branched = new Promise<void>((minted) => {
      ready.state.onBranch = () => {
        minted();
      };
    });
    const second = ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    // The teardown is let go the moment the second run has branched — which is
    // the moment its copy could be hijacked — or after long enough that it
    // plainly never will. A build that is waiting its turn never gets there,
    // so this waits out the timer; a build that is not waiting gets there in
    // milliseconds and the restore below lands on top of its copy.
    await Promise.race([
      branched,
      new Promise((resume) => setTimeout(resume, 300)),
    ]);
    release();
    const [, answered] = await Promise.all([landing, second]);

    // **Not one write to a number, by either run.** Egma edits no customer's
    // inbound routing, so the number stands exactly as the customer left it
    // through both runs — during the first, during its teardown, and during
    // the second's build.
    expect(ready.state.writes).toEqual([]);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    // The second run got its turn: the agent was clean by the time it had the
    // fence, so it built a world of its own.
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(201);
    const header = await ask(
      api.app,
      "GET",
      `/v1/runs/${String(answered.body.id)}`,
      ready.key,
    );
    expect(header.body.tempMockAgentVersion).toBeGreaterThan(105);
  });
});

/**
 * The claim refuses two *live* worlds; this is the other half. A world whose
 * teardown failed belongs to a finished run — nothing blocks the claim — but
 * its restore is still owed, and it retries on a later terminal report. If the
 * next run branched first, that retry would put the number's `latest` binding
 * back while the new draft is the latest version, and real callers would reach
 * a mocked agent. So the build refuses while anything on the agent is owed,
 * which is what lets the retried restore always land on an account with no
 * temporary version standing.
 */
describe("a mocked run after a predecessor's teardown failed", () => {
  it("is refused until the debt settles, and the retried restore finds no draft", async () => {
    const ready = await anAgentReadyToRun("mocked_run_owed_refuses");

    const first = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const firstRunId = String(first.body.id);

    // The account stops honouring deletes, then the run is conducted to its
    // end: its teardown cannot delete the draft, and delete-before-restore
    // then keeps the pin in place — the draft stands, the world stays owed.
    ready.state.refuseDeletes = true;
    const specs = await claim();
    const simulationId = String(specs[0]?.["simulation_id"]);
    await report(simulationId, "running");
    await report(simulationId, "completed");
    expect(ready.state.versions.has(106)).toBe(true);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    // The next run is refused with the debt named, **before branching
    // anything**: no new version was minted and the pin is exactly as it was.
    const second = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(second.statusCode, JSON.stringify(second.body)).toBe(422);
    expect(second.body.error).toBe("mock_tools_unbuildable");
    expect(String(second.body.message)).toContain(firstRunId);
    expect(String(second.body.message)).toContain("could not be fully given back");
    expect([...ready.state.versions].sort()).toEqual([105, 106]);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    // The account honours deletes again, and the cleanup retries on the
    // predecessor's next terminal report. The retried restore finds **no
    // draft standing** — the refusal above is what guaranteed that — so
    // `latest` resolves to the real serving version and nothing else.
    ready.state.refuseDeletes = false;
    await report(simulationId, "completed");
    expect(ready.state.versions.has(106)).toBe(false);
    expect(ready.state.bindings.get("+12567332874")).toEqual([
      { agent_id: RETELL_AGENT, agent_version: "latest", weight: 2 },
    ]);

    // The agent is clean, and the next run builds normally.
    const third = await ask(api.app, "POST", "/v1/runs", ready.key, {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(third.statusCode, JSON.stringify(third.body)).toBe(201);
  });
});
