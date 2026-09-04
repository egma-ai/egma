import { newId } from "@egma/ids";
import { createPersona, sealAgentMonitoringKey } from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { MOCK_TOOL_PREFIX, mockToolBase } from "../src/routes/mock-endpoint.ts";
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
 * The mock endpoint, over real HTTP: the one new public surface, answering the
 * calls a mocked run's temporary agent version sends it.
 *
 * What is asserted is what a developer would see — the answer the agent
 * received and what the simulation's record says afterwards. Nothing here
 * asserts how egma arranged any of it, and nothing here reaches a network: the
 * calls arrive the way Retell's would, at the address the transform writes.
 *
 * **The answers come off the test, and only off the test.** There is no project
 * list to merge, no run-level switch to consult and no snapshot to freeze, so
 * two simulations of one run answer for exactly what their own tests named.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const RETELL_CHAT_FETCH: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.includes("/v2/list-agents")) {
    throw new Error(`Unexpected Retell read: ${url}`);
  }
  return new Response(
    JSON.stringify({
      items: [
        {
          agent_id: "agent_in_retell_1",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    }),
    { status: 200 },
  );
};

/** The sealed platform key this agent's signature check would use. */
const PLATFORM_KEY = "retell-platform-key-Z9Y8X7W6";

const CONDUCTOR = "sim-under-test";

/** One mock tool a test carries, in the shape the write takes. */
type AuthoredMockTool =
  | { readonly tool: string; readonly answer: unknown }
  | { readonly tool: string; readonly error: string };

const ONE_FREE_SLOT: readonly AuthoredMockTool[] = [
  { tool: "get_availability", answer: { slots: ["Tuesday 14:00"] } },
];

type Ready = {
  readonly ada: Customer;
  readonly key: string;
  readonly agentId: string;
  readonly runId: string;
  readonly simulationId: string;
};

/**
 * A customer with a running simulation whose test names its own mock tools.
 *
 * The whole path is the real one: register, author a test carrying its world,
 * start a run, claim the simulation and report it running — so what this
 * endpoint answers from is the test a developer really wrote.
 */
async function aRunningSimulation(
  label: string,
  mockTools: readonly AuthoredMockTool[] = ONE_FREE_SLOT,
  /** Where this deployment's log lines go, for the proof that reads them. */
  logTo?: { write(line: string): void },
): Promise<Ready> {
  api = await createApi(label, {
    traceStore: true,
    retellFetch: RETELL_CHAT_FETCH,
    ...(logTo === undefined ? {} : { logTo }),
  });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "Front desk",
    connection: RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

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
    mockTools,
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/v1/runs", key, {
    suiteId: String(suite.body.id),
    agentId,
    connectionId,
    idempotencyKey: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const runId = String(started.body.id);

  const page = await ask(
    api.app,
    "GET",
    `/v1/runs/${runId}/simulations?pageSize=1`,
    key,
  );
  const simulations = page.body.simulations as { id: string }[];
  const simulationId = simulations[0]?.id;
  if (simulationId === undefined) throw new Error("the run has no simulation");

  await claim();
  await reportRunning(simulationId);

  // The agent's platform key, sealed through the one function that seals one.
  // The signature check needs a key to check against, and this file is about
  // the check rather than about how a key gets there.
  await sealAgentMonitoringKey(contextFor(ada, "admin"), {
    agentId,
    agentPlatform: "retell",
    platformAgentId: "agent_in_retell_1",
    apiKey: PLATFORM_KEY,
  });

  return { ada, key, agentId, runId, simulationId };
}

/** One claim, as the simulator makes it. */
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

async function reportRunning(simulationId: string): Promise<void> {
  const running = await api.app.inject({
    method: "POST",
    url: reportPathFor(simulationId),
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: {
      contract_version: 1,
      simulation_id: simulationId,
      events: [
        {
          kind: "status",
          event_id: "evt-000001",
          at: "2026-08-05T09:00:00.000000Z",
          status: "running",
          reason: null,
        },
      ],
    },
  });
  expect(running.statusCode, running.body).toBe(200);
}

/** The path one tool call arrives at, as the temporary version's URL sends it. */
function mockToolPath(simulationId: string, toolName: string): string {
  return (
    `${MOCK_TOOL_PREFIX}/${encodeURIComponent(simulationId)}` +
    `/${encodeURIComponent(toolName)}`
  );
}

/** One tool call, as the temporary version's URL would send it. */
async function call(
  where: {
    readonly simulationId: string;
    readonly toolName: string;
  },
  options: {
    readonly body?: string;
    /** A GET tool's arguments ride the query string, so a GET sends no body. */
    readonly method?: "GET" | "POST";
    readonly query?: string;
    /** Whatever the customer's own tool configuration would send along. */
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ statusCode: number; raw: string; json: unknown }> {
  const method = options.method ?? "POST";
  const body = options.body ?? JSON.stringify({ service: "facial", date: "2026-09-01" });
  const path = mockToolPath(where.simulationId, where.toolName);
  const response = await api.app.inject({
    method,
    url: options.query === undefined ? path : `${path}?${options.query}`,
    headers: {
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
    ...(method === "GET" ? {} : { payload: body }),
  });
  let json: unknown;
  try {
    json = JSON.parse(response.body) as unknown;
  } catch {
    json = undefined;
  }
  return { statusCode: response.statusCode, raw: response.body, json };
}

/** Every tool span filed against one simulation's trace. */
async function toolSpansOf(simulationId: string): Promise<
  {
    readonly tool_name: string;
    readonly tool_arguments: string;
    readonly tool_result: string;
    readonly payload: string;
    readonly duration_ns: string;
  }[]
> {
  const store = api.traceStore;
  if (store === undefined) throw new Error("this API has no trace store");
  const traceId = traceIdOfSimulation(simulationId);
  return store.rows(
    `select tool_name, tool_arguments, tool_result, payload, ` +
      `toString(duration_ns) as duration_ns ` +
      `from spans final where trace_id = '${traceId}' and kind = 'tool' ` +
      `order by started_at asc`,
  );
}

describe("the address the transform writes", () => {
  it("is the deployment's own public origin, with no trailing slash", () => {
    expect(mockToolBase("https://egma.example.com/")).toBe(
      "https://egma.example.com/mock-tools",
    );
  });

  /**
   * The loop closed: the address built from that base is the address this
   * endpoint answers — the simulation, then the tool, and nothing else in
   * between.
   */
  it("is answered by this endpoint, tool name and all", async () => {
    const ready = await aRunningSimulation("mock_endpoint_round_trip", [
      { tool: "get_availability", answer: { ok: true } },
    ]);

    const written =
      `${mockToolBase("https://egma.example.com")}` +
      `/${ready.simulationId}/get_availability`;

    const answered = await api.app.inject({
      method: "POST",
      url: new URL(written).pathname,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ service: "facial" }),
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ ok: true });
  });

  it("routes a tool name carrying characters a path has to encode", async () => {
    // The tool this test names, named the way a real one can be.
    const fresh = await aRunningSimulation("mock_endpoint_encoded_name", [
      { tool: "price list/lookup?v=2", answer: { slots: ["Tuesday 14:00"] } },
    ]);

    const answered = await call({
      simulationId: fresh.simulationId,
      toolName: "price list/lookup?v=2",
    });
    expect(answered.statusCode, answered.raw).toBe(200);
    expect(answered.json).toEqual({ slots: ["Tuesday 14:00"] });
  });
});

describe("the two gates", () => {
  it("serves the answer the test named", async () => {
    const ready = await aRunningSimulation("mock_endpoint_serves");

    const answered = await call({
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });

    expect(answered.statusCode).toBe(200);
    expect(answered.json).toEqual({ slots: ["Tuesday 14:00"] });
  });

  it("refuses a simulation nobody is conducting", async () => {
    const ready = await aRunningSimulation("mock_endpoint_dead_run");

    const refused = await call({
      simulationId: newId("sim"),
      toolName: "get_availability",
    });
    expect(refused.statusCode).toBe(404);
    expect((refused.json as { refusal: string }).refusal).toBe("no_live_run");

    // And a simulation whose run has finished reads exactly like one that
    // never existed.
    await api.database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [ready.runId],
    );
    await api.database.sql(
      `update run set status = 'completed', finished_at = now(),
              completed_count = 1, failed_count = 0, canceled_count = 0
        where id = $1`,
      [ready.runId],
    );
    const afterwards = await call({
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });
    expect((afterwards.json as { refusal: string }).refusal).toBe("no_live_run");
  });

  it("refuses a tool this simulation's test did not name, and lands it", async () => {
    const ready = await aRunningSimulation("mock_endpoint_uncovered");

    const refused = await call({
      simulationId: ready.simulationId,
      toolName: "charge_card",
    });
    expect(refused.statusCode).toBe(404);
    expect((refused.json as { refusal: string }).refusal).toBe("tool_not_mocked");

    const spans = await toolSpansOf(ready.simulationId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.tool_name).toBe("charge_card");
    // Egma was in the path and said no. An unstamped span would say the
    // opposite — that the call went past egma to a real backend.
    expect(JSON.parse(spans[0]!.payload)["egma.tool.provenance"]).toBe("refused");
    expect(spans[0]?.tool_result).toBe("");
  });
});

describe("a tool the customer wrote as a GET", () => {
  /**
   * The transform keeps every tool's declared `method` byte-identical, so a GET
   * tool arrives here as a GET. A door that took only POST would answer those
   * with a 404 indistinguishable from an unmocked tool, and a developer would
   * go looking for a mock tool they had already authored.
   */
  it("is answered, and its query string is not read at all", async () => {
    const ready = await aRunningSimulation("mock_endpoint_get_tool");

    const answered = await call(
      {
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
      { method: "GET", query: "service=facial&date=2026-09-01" },
    );

    expect(answered.statusCode, answered.raw).toBe(200);
    expect(answered.json).toEqual({ slots: ["Tuesday 14:00"] });

    const spans = await toolSpansOf(ready.simulationId);
    expect(spans).toHaveLength(1);
    // **The cost of dropping the query string, paid where it falls.** A GET
    // tool's arguments ride in the same string as the customer's own static
    // parameters — their credentials among them — and egma cannot tell one
    // from the other, so it reads none of it. The call, the answer and the
    // provenance are on the record; the arguments are not.
    expect(spans[0]?.tool_arguments).toBe("");
    expect(JSON.stringify(spans[0])).not.toContain("facial");
    const payload = JSON.parse(spans[0]!.payload) as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    expect(payload["egma.tool.arguments"]).toBe("");
  });

  it("keeps every refusal distinct on a GET too", async () => {
    const ready = await aRunningSimulation("mock_endpoint_get_refusals", [
      { tool: "get_availability", answer: { ok: true } },
    ]);
    const asGet = { method: "GET" as const };

    const dead = await call(
      { simulationId: newId("sim"), toolName: "get_availability" },
      asGet,
    );
    expect((dead.json as { refusal: string }).refusal).toBe("no_live_run");

    const uncovered = await call(
      { simulationId: ready.simulationId, toolName: "charge_card" },
      asGet,
    );
    expect((uncovered.json as { refusal: string }).refusal).toBe(
      "tool_not_mocked",
    );

    // A GET carries no body, and nothing about it is authenticated: the
    // identifier of a live simulation and a tool its test named are the whole
    // of what admits it.
    const answered = await call(
      { simulationId: ready.simulationId, toolName: "get_availability" },
      asGet,
    );
    expect(answered.statusCode, answered.raw).toBe(200);
  });
});

describe("what the customer's own tool configuration sends along", () => {
  /**
   * The credentials arrive, and egma reads none of them.
   *
   * The temporary version keeps each tool's own headers and query params byte
   * for byte, because that same version serves the tools a test does **not**
   * mock and those calls have to authenticate exactly as production does. So a
   * mocked call carries the customer's backend credentials into egma's
   * ingress, and what this endpoint promises is that nothing of them is read,
   * logged, stored, or put on the record (ADR-0022).
   *
   * The sentinel is one string, looked for in every log line this deployment
   * wrote and in every column of the span that landed — so the proof does not
   * depend on knowing which field a leak would come out of.
   */
  it("drops every header and query value at the door, and writes none of them anywhere", async () => {
    const lines: string[] = [];
    const ready = await aRunningSimulation("mock_endpoint_drops_secrets", ONE_FREE_SLOT, {
      write: (line) => {
        lines.push(line);
      },
    });

    const answered = await call(
      { simulationId: ready.simulationId, toolName: "get_availability" },
      {
        query: "api_key=FIXTURESECRET_in_the_query",
        headers: {
          authorization: "Bearer FIXTURESECRET_in_the_header",
          "x-tenant-key": "FIXTURESECRET_in_another_header",
        },
      },
    );

    // The call is served: dropping the credentials is not refusing the call.
    expect(answered.statusCode, answered.raw).toBe(200);
    expect(answered.json).toEqual({ slots: ["Tuesday 14:00"] });

    // Nothing of them in anything this deployment logged.
    expect(lines.length, "the deployment logged nothing at all").toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, "a log line carries the customer's own credential").not.toContain(
        "FIXTURESECRET",
      );
    }

    // Nothing of them on the record either — every column of the span, so the
    // proof does not depend on guessing which field a leak would use.
    const spans = await toolSpansOf(ready.simulationId);
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans[0])).not.toContain("FIXTURESECRET");
    // The arguments column is the POST body and nothing else: the body is
    // egma's to read, and it landed.
    expect(JSON.parse(spans[0]!.tool_arguments)).toEqual({
      service: "facial",
      date: "2026-09-01",
    });
  });
});

describe("the platform's signature", () => {
  it("is not checked: a signed call and an unsigned one are answered alike", async () => {
    // Retell signs a custom-function call with the account's webhook-badged key,
    // which Egma does not hold, so on 2026-09-04 a check against the agent's
    // stored key refused every real call. The founder dropped the check. What
    // admits a call is the identifier of a live simulation and a tool its test
    // named — a header, any header, changes nothing.
    const ready = await aRunningSimulation("mock_endpoint_unsigned");
    const body = JSON.stringify({ service: "facial" });

    const signed = await call(
      { simulationId: ready.simulationId, toolName: "get_availability" },
      { body, headers: { "x-retell-signature": "v=1,d=not-a-real-digest" } },
    );
    expect(signed.statusCode, signed.raw).toBe(200);

    const unsigned = await call(
      { simulationId: ready.simulationId, toolName: "get_availability" },
      { body },
    );
    expect(unsigned.statusCode, unsigned.raw).toBe(200);
    expect(signed.raw).toBe(unsigned.raw);
  });
});

describe("what the record says afterwards", () => {
  it("carries the arguments, the answer, the elapsed time and the provenance", async () => {
    const ready = await aRunningSimulation("mock_endpoint_record");
    const body = JSON.stringify({ service: "facial", date: "2026-09-01" });

    await call(
      { simulationId: ready.simulationId, toolName: "get_availability" },
      { body },
    );

    const spans = await toolSpansOf(ready.simulationId);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.tool_name).toBe("get_availability");
    // The arguments as they arrived — the bytes, not a re-serialisation.
    expect(span.tool_arguments).toBe(body);
    expect(JSON.parse(span.tool_result)).toEqual({
      slots: ["Tuesday 14:00"],
    });

    const payload = JSON.parse(span.payload) as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    // The mock tool that answered is named by its tool name, which is the whole
    // of how one is named now that the answers live on the test.
    expect(payload["egma.tool.mock_tool"]).toBe("get_availability");
    // The span brackets the exchange, so the duration is a real interval.
    expect(Number(span.duration_ns)).toBeGreaterThanOrEqual(0);
  });

  it("keeps one row per call, because two calls are two facts", async () => {
    const ready = await aRunningSimulation("mock_endpoint_two_calls");
    const where = {
      simulationId: ready.simulationId,
      toolName: "get_availability",
    };

    await call(where, { body: JSON.stringify({ date: "2026-09-01" }) });
    await call(where, { body: JSON.stringify({ date: "2026-09-02" }) });

    const spans = await toolSpansOf(ready.simulationId);
    expect(spans).toHaveLength(2);
    expect(spans.map((one) => JSON.parse(one.tool_arguments).date).sort()).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("an authored failure", () => {
  it("reaches the agent as the backend failing, not as a successful result", async () => {
    const ready = await aRunningSimulation("mock_endpoint_error_answer", [
      { tool: "get_availability", error: "the booking service is down" },
    ]);

    const answered = await call({
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });

    // Proving the agent apologises instead of claiming success is the whole
    // reason an answer may be an error, so it must not arrive as a 200 with an
    // error object in it.
    expect(answered.statusCode).toBe(500);
    expect(answered.json).toEqual({ error: "the booking service is down" });

    const spans = await toolSpansOf(ready.simulationId);
    const payload = JSON.parse(spans[0]!.payload) as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    expect(JSON.parse(spans[0]!.tool_result)).toEqual({
      error: "the booking service is down",
    });
  });
});

describe("two tests of one run", () => {
  /**
   * The whole point of a test carrying its world: one run, two tests, two
   * different sets of mocked tools — and each simulation answers for exactly
   * what its own test named, with the other's tool refused as unmocked.
   */
  it("each answer for their own tools, and for nobody else's", async () => {
    api = await createApi("mock_endpoint_two_tests", {
      traceStore: true,
      retellFetch: RETELL_CHAT_FETCH,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: RETELL,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
      name: "Appointment changes",
    });
    expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
    await createPersona(contextFor(ada, "member"), {
      name: "Impatient Rita",
      ...NEUTRAL_PERSON,
    });

    for (const [name, tool] of [
      ["Books an appointment", "get_availability"],
      ["Pays for the appointment", "charge_card"],
    ] as const) {
      const pushed = await ask(api.app, "POST", "/v1/tests", key, {
        name,
        scenario: `Scenario for ${tool}.`,
        expectedBehaviors: ["confirms the outcome back before finishing"],
        suiteId: String(suite.body.id),
        personas: ["Impatient Rita"],
        mockTools: [{ tool, answer: { served: tool } }],
      });
      expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);
    }

    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId: String(suite.body.id),
      agentId,
      connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    // Which simulation is which is read off the work order each one was given,
    // because the scenario is the one field that names its test.
    const specs = await claim();
    expect(specs).toHaveLength(2);
    const byTool = new Map<string, string>();
    for (const spec of specs) {
      const instructions = String(
        (spec["scenario"] as { instructions: string }).instructions,
      );
      const tool = instructions.replace("Scenario for ", "").replace(".", "");
      byTool.set(tool, String(spec["simulation_id"]));
    }

    for (const [tool, other] of [
      ["get_availability", "charge_card"],
      ["charge_card", "get_availability"],
    ] as const) {
      const simulationId = byTool.get(tool);
      if (simulationId === undefined) throw new Error(`no simulation for ${tool}`);

      const own = await call({ simulationId, toolName: tool });
      expect(own.statusCode, own.raw).toBe(200);
      expect(own.json).toEqual({ served: tool });

      // The other test's tool is not this simulation's world, so it is refused
      // exactly as a tool nobody named would be.
      const foreign = await call({ simulationId, toolName: other });
      expect(foreign.statusCode).toBe(404);
      expect((foreign.json as { refusal: string }).refusal).toBe(
        "tool_not_mocked",
      );
    }
  });
});
