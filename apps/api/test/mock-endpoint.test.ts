import { newId } from "@egma/ids";
import { createPersona, sealAgentMonitoringKey } from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import {
  MOCK_TOOL_PREFIX,
  mockToolBase,
  signatureFor,
  SIGNATURE_HEADER,
} from "../src/routes/mock-endpoint.ts";
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
 * received, how long it waited for it, and what the simulation's record says
 * afterwards. Nothing here asserts how egma arranged any of it, and nothing
 * here reaches a network: the calls arrive the way Retell's would, at the
 * address the transform writes.
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

/** Every delay the endpoint was asked to wait out, in the order it asked. */
let waited: number[] = [];

async function anInstance(label: string): Promise<void> {
  waited = [];
  api = await createApi(label, {
    traceStore: true,
    retellFetch: RETELL_CHAT_FETCH,
    mockToolWait: async (milliseconds: number) => {
      waited.push(milliseconds);
    },
  });
}

type Ready = {
  readonly ada: Customer;
  readonly key: string;
  readonly agentId: string;
  readonly runId: string;
  readonly simulationId: string;
};

/**
 * A customer with a running simulation, and one project mock tool answering
 * for `get_availability`.
 *
 * The whole path is the real one: register, author a test, start a run, claim
 * the simulation and report it running — so the world this endpoint resolves
 * against is the world a run really freezes.
 */
async function aRunningSimulation(
  label: string,
  /** What the one project mock tool answers with, as the write takes it. */
  answers: Record<string, unknown> = {
    answer: { slots: ["Tuesday 14:00"] },
    delayMs: 1500,
  },
): Promise<Ready> {
  await anInstance(label);
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

  const mocked = await ask(api.app, "POST", "/v1/mock-tools", key, {
    tool: "get_availability",
    ...answers,
  });
  expect(mocked.statusCode, JSON.stringify(mocked.body)).toBe(201);

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
  expect(claimed.statusCode).toBe(200);

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

/** One tool call, as the temporary version's URL would send it. */
async function call(
  where: {
    readonly runId: string;
    readonly simulationId: string;
    readonly toolName: string;
  },
  options: {
    readonly body?: string;
    readonly signature?: string;
  } = {},
): Promise<{ statusCode: number; raw: string; json: unknown }> {
  const body = options.body ?? JSON.stringify({ service: "facial", date: "2026-09-01" });
  const response = await api.app.inject({
    method: "POST",
    url:
      `${MOCK_TOOL_PREFIX}/${encodeURIComponent(where.runId)}` +
      `/${encodeURIComponent(where.simulationId)}` +
      `/${encodeURIComponent(where.toolName)}`,
    headers: {
      "content-type": "application/json",
      ...(options.signature === undefined
        ? {}
        : { [SIGNATURE_HEADER]: options.signature }),
    },
    payload: body,
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
});

describe("the three gates", () => {
  it("serves the resolved answer after the declared delay", async () => {
    const ready = await aRunningSimulation("mock_endpoint_serves");

    const answered = await call({
      runId: ready.runId,
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });

    expect(answered.statusCode).toBe(200);
    expect(answered.json).toEqual({ slots: ["Tuesday 14:00"] });
    // The market gap: a mocked backend takes as long as a real one.
    expect(waited).toEqual([1500]);
  });

  it("refuses a run that is not being conducted", async () => {
    const ready = await aRunningSimulation("mock_endpoint_dead_run");

    const refused = await call({
      runId: newId("run"),
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });
    expect(refused.statusCode).toBe(404);
    expect((refused.json as { refusal: string }).refusal).toBe("no_live_run");

    // And a run that has finished reads exactly like one that never existed.
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
      runId: ready.runId,
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });
    expect((afterwards.json as { refusal: string }).refusal).toBe("no_live_run");
  });

  it("refuses a simulation that belongs to another run", async () => {
    const ready = await aRunningSimulation("mock_endpoint_foreign_sim");

    const refused = await call({
      runId: ready.runId,
      simulationId: newId("sim"),
      toolName: "get_availability",
    });
    expect(refused.statusCode).toBe(404);
    expect((refused.json as { refusal: string }).refusal).toBe(
      "simulation_not_in_run",
    );
  });

  it("refuses a tool this simulation has no answer for, and lands it", async () => {
    const ready = await aRunningSimulation("mock_endpoint_uncovered");

    const refused = await call({
      runId: ready.runId,
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

describe("the signature", () => {
  it("admits a request signed with the key egma holds for the agent", async () => {
    const ready = await aRunningSimulation("mock_endpoint_signed");
    const body = JSON.stringify({ service: "facial" });

    const answered = await call(
      {
        runId: ready.runId,
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
      { body, signature: signatureFor(body, PLATFORM_KEY, Date.now()) },
    );
    expect(answered.statusCode).toBe(200);
  });

  it("refuses one signed with another key, distinctly, and lands it", async () => {
    const ready = await aRunningSimulation("mock_endpoint_bad_signature");
    const body = JSON.stringify({ service: "facial" });

    const refused = await call(
      {
        runId: ready.runId,
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
      { body, signature: signatureFor(body, "not-the-agents-key", Date.now()) },
    );
    expect(refused.statusCode).toBe(401);
    expect((refused.json as { refusal: string }).refusal).toBe("bad_signature");
    // The refusal never repeats the key it checked against.
    expect(refused.raw).not.toContain(PLATFORM_KEY);

    const spans = await toolSpansOf(ready.simulationId);
    expect(JSON.parse(spans[0]!.payload)["egma.tool.provenance"]).toBe("refused");
  });

  it("refuses a signature over different bytes than arrived", async () => {
    const ready = await aRunningSimulation("mock_endpoint_body_swapped");
    const signature = signatureFor(
      JSON.stringify({ service: "facial" }),
      PLATFORM_KEY,
      Date.now(),
    );

    const refused = await call(
      {
        runId: ready.runId,
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
      { body: JSON.stringify({ service: "massage" }), signature },
    );
    expect((refused.json as { refusal: string }).refusal).toBe("bad_signature");
  });

  it("refuses one signed outside the window a replay could not survive", async () => {
    const ready = await aRunningSimulation("mock_endpoint_stale_signature");
    const body = JSON.stringify({ service: "facial" });
    const longAgo = Date.now() - 10 * 60 * 1000;

    const refused = await call(
      {
        runId: ready.runId,
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
      { body, signature: signatureFor(body, PLATFORM_KEY, longAgo) },
    );
    expect((refused.json as { refusal: string }).refusal).toBe("bad_signature");
  });
});

describe("what the record says afterwards", () => {
  it("carries the arguments, the answer, the elapsed time and the provenance", async () => {
    const ready = await aRunningSimulation("mock_endpoint_record");
    const body = JSON.stringify({ service: "facial", date: "2026-09-01" });

    await call(
      {
        runId: ready.runId,
        simulationId: ready.simulationId,
        toolName: "get_availability",
      },
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
    // The mock tool that answered is named, so the record can say where the
    // answer came from.
    expect(String(payload["egma.tool.mock_tool"])).toMatch(/^mck_/u);
    // The span brackets the exchange, so the duration is a real interval.
    expect(Number(span.duration_ns)).toBeGreaterThanOrEqual(0);
  });

  it("keeps one row per call, because two calls are two facts", async () => {
    const ready = await aRunningSimulation("mock_endpoint_two_calls");
    const where = {
      runId: ready.runId,
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
    const ready = await aRunningSimulation("mock_endpoint_error_answer", {
      error: "the booking service is down",
      delayMs: 0,
    });

    const answered = await call({
      runId: ready.runId,
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

describe("a test's own override", () => {
  it("beats the project default of the same name", async () => {
    const ready = await aRunningSimulation("mock_endpoint_override");

    // The run's frozen world, with this simulation's pinned test version
    // answering `get_availability` its own way. Written here rather than
    // authored through a test, because freezing a version's overrides into a
    // run is not yet wired — what is proved is the endpoint's resolution,
    // which is where a per-test branch is actually served.
    const { rows } = await api.database.sql<{ test_version_id: string }>(
      "select test_version_id from simulation where id = $1",
      [ready.simulationId],
    );
    const testVersionId = rows[0]?.test_version_id;
    expect(testVersionId).toBeDefined();

    const snapshot = await api.database.sql<{ mock_tool_snapshot: unknown }>(
      "select mock_tool_snapshot from run where id = $1",
      [ready.runId],
    );
    const frozen = snapshot.rows[0]?.mock_tool_snapshot as {
      defaults: unknown[];
    };
    await api.database.sql(
      "update run set mock_tool_snapshot = $2::jsonb where id = $1",
      [
        ready.runId,
        JSON.stringify({
          defaults: frozen.defaults,
          overrides: {
            [testVersionId!]: [
              {
                toolName: "get_availability",
                answer: { answer: { slots: [] } },
                delayMilliseconds: 250,
              },
            ],
          },
        }),
      ],
    );

    const answered = await call({
      runId: ready.runId,
      simulationId: ready.simulationId,
      toolName: "get_availability",
    });

    expect(answered.statusCode).toBe(200);
    // "The calendar has no free slots" — the same test with one answer changed.
    expect(answered.json).toEqual({ slots: [] });
    expect(waited).toEqual([250]);

    const spans = await toolSpansOf(ready.simulationId);
    const payload = JSON.parse(spans[0]!.payload) as Record<string, unknown>;
    expect(payload["egma.tool.provenance"]).toBe("mocked");
    // Null exactly when a test's own override answered: an override is the
    // test's content and has no row of its own to name.
    expect(payload["egma.tool.mock_tool"]).toBeNull();
  });
});
