import { readFile } from "node:fs/promises";

import { cancelRun, claimSimulations, createPersona } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SDK_HELLO_PATH, SDK_TOOL_PATH } from "../src/routes/sdk-seam.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  mintKey,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The mock-tool seam a Pipecat bot speaks with egma over HTTPS, driven in
 * process against real stores. Every exchange of the shared seam fixture is
 * replayed as written: the SDK and the simulator test against the same file,
 * so a route, status, code or sentence that moves on this side fails here.
 */

type Json = Record<string, unknown>;

const SEAM = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/simulation-contract/fixtures/seam/sdk-https-exchange.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  readonly routes: Readonly<Record<string, string>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly not_a_simulation: { readonly status: number; readonly body: Json };
  readonly worlds: Readonly<
    Record<
      string,
      {
        readonly simulation_id: string;
        readonly mock_tools: readonly (
          | { readonly tool: string; readonly answer: unknown }
          | { readonly tool: string; readonly error: string }
        )[];
      }
    >
  >;
  readonly exchanges: Readonly<Record<string, Exchange>>;
  readonly agent_report: {
    readonly request: Json;
    readonly waiting: { readonly status: number; readonly response: Json };
    readonly accepted: { readonly status: number; readonly response: Json };
    readonly refused: { readonly status: number; readonly response: Json };
    readonly not_the_claimant: { readonly status: number; readonly response: Json };
  };
};

type Exchange = {
  readonly world?: string;
  readonly route: "hello" | "tool";
  readonly request?: Json;
  readonly request_is?: string;
  readonly without_authorization?: boolean;
  readonly status: number;
  readonly response?: Json;
  readonly response_is?: string;
  readonly bytes?: string;
  readonly records?: Json;
};

const IN_ROOM = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly messages: Readonly<Record<string, { readonly bytes: string }>> };

const CONDUCTOR = "egma-simulator-1";

const PIPECAT_CLOUD_VOICE = {
  agentPlatform: "pipecat",
  connectionType: "daily_room",
  accessVariant: "daily_room.pipecat_cloud",
  modality: "voice",
  config: { agentName: "lakeside-front-desk" },
  credentials: { publicApiKey: "pk_fixture0not0a0real0public0key" },
} as const;

let api: TestApi;
let ada: Customer;
let adaKey: string;
/** The fixture's simulation ids, mapped to the ones this store minted. */
const realIdOf = new Map<string, string>();

type World = {
  readonly simulationId: string;
  readonly runId: string;
  readonly agentId: string;
};

/** A value with every fixture simulation id replaced by its real one. */
function withRealIds(value: unknown): unknown {
  let text = JSON.stringify(value);
  for (const [fixtureId, realId] of realIdOf) text = text.replaceAll(fixtureId, realId);
  return JSON.parse(text) as unknown;
}

/** A value with every real simulation id replaced by the fixture's. */
function withFixtureIds(value: unknown): unknown {
  let text = JSON.stringify(value);
  for (const [fixtureId, realId] of realIdOf) text = text.replaceAll(realId, fixtureId);
  return JSON.parse(text) as unknown;
}

/** A value the fixture points at by dotted path, such as `exchanges.hello.request`. */
function at(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((held, key) => (held as Json)[key], SEAM as unknown);
}

async function sdk(
  path: string,
  body: unknown,
  /** `null` sends no Authorization header at all. */
  key: string | null = adaKey,
): Promise<{ statusCode: number; raw: string; json: Json }> {
  const answered = await api.app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json: Json = {};
  try {
    json = JSON.parse(answered.body) as Json;
  } catch {
    json = {};
  }
  return { statusCode: answered.statusCode, raw: answered.body, json };
}

function serviceHeaders(): Record<string, string> {
  return { authorization: `Bearer ${api.config.simulatorServiceToken}` };
}

async function registerReference(
  simulationId: string,
  providerReference: string = simulationId,
  claimant = CONDUCTOR,
) {
  return api.app.inject({
    method: "POST",
    url: `/v1/simulations/${simulationId}/provider-reference`,
    headers: serviceHeaders(),
    payload: { claimant, provider_reference: providerReference },
  });
}

async function agentReport(simulationId: string, body: unknown = SEAM.agent_report.request) {
  const answered = await api.app.inject({
    method: "POST",
    url: `/v1/simulations/${simulationId}/agent-report`,
    headers: serviceHeaders(),
    payload: body as Json,
  });
  return { statusCode: answered.statusCode, json: answered.json() as Json };
}

async function storedReport(simulationId: string): Promise<Json | null> {
  const { rows } = await api.database.sql<{ agent_report: Json | null }>(
    "select agent_report from simulation where id = $1",
    [simulationId],
  );
  return rows[0]?.agent_report ?? null;
}

/**
 * A claimed Pipecat Cloud simulation whose test mocks these tools, conducted
 * by this file's simulator name, with its provider reference registered
 * unless the case is about the reference not being there yet.
 */
async function aClaimedSimulation(
  label: string,
  mockTools: readonly Json[],
  register = true,
): Promise<World> {
  // One Pipecat Cloud agent name per world: the same name would be the same
  // connection, and registration would reuse the first agent.
  const agentName = `lakeside-${label.replaceAll(/[^A-Za-z0-9]+/g, "-")}`;
  const registered = await ask(api.app, "POST", "/v1/agents", adaKey, {
    agentPlatform: "pipecat",
    name: `Front desk ${label}`,
    connection: { ...PIPECAT_CLOUD_VOICE, config: { agentName } },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", adaKey, {
    name: `Bookings ${label}`,
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  await createPersona(contextFor(ada, "member"), {
    name: `Eleanor ${label}`,
    ...NEUTRAL_PERSON,
  });
  const pushed = await ask(api.app, "POST", "/v1/tests", adaKey, {
    name: `Books an appointment ${label}`,
    scenario: "Wants the first free afternoon slot next week.",
    expectedBehaviors: ["confirms the time back before finishing"],
    suiteId: String(suite.body.id),
    personas: [`Eleanor ${label}`],
    ...(mockTools.length === 0 ? {} : { mockTools }),
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/v1/runs", adaKey, {
    suiteId: String(suite.body.id),
    agentId,
    connectionId,
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const runId = String(started.body.id);
  const page = await ask(api.app, "GET", `/v1/runs/${runId}/simulations?pageSize=1`, adaKey);
  const simulationId = (page.body.simulations as { id: string }[])[0]?.id;
  if (simulationId === undefined) throw new Error("the run has no simulation");

  const [claimed] = await claimSimulations({ claimant: CONDUCTOR, capacity: 1 });
  expect(claimed?.id, "this run's simulation was the one to claim").toBe(simulationId);

  if (register) {
    const answered = await registerReference(simulationId);
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({
      simulation_id: simulationId,
      provider_reference: simulationId,
    });
  }
  return { simulationId, runId, agentId };
}

beforeAll(async () => {
  api = await createApi("pipecat_sdk_seam");
  ada = await signUp(api.app, "ada@lakeside.example", "Lakeside");
  adaKey = await projectKeyFor(api.app, ada);

  for (const [name, world] of Object.entries(SEAM.worlds)) {
    const claimed = await aClaimedSimulation(name, world.mock_tools as unknown as Json[]);
    realIdOf.set(world.simulation_id, claimed.simulationId);
  }
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe("the shared seam fixture", () => {
  it("names the routes this server answers", () => {
    expect(SEAM.routes).toMatchObject({
      hello: SDK_HELLO_PATH,
      tool: SDK_TOOL_PATH,
    });
    expect(SEAM.routes).not.toHaveProperty("confirm");
  });

  it("answers the simulator's poll with waiting before any hello", async () => {
    const calendar = realIdOf.get(SEAM.worlds.calendar!.simulation_id)!;
    const answered = await agentReport(calendar);
    expect(answered.statusCode).toBe(SEAM.agent_report.waiting.status);
    expect(withFixtureIds(answered.json)).toEqual(SEAM.agent_report.waiting.response);
  });

  const exchanges = Object.entries(SEAM.exchanges);
  it.each(exchanges)("replays %s", async (name, exchange) => {
    const body = withRealIds(exchange.request ?? at(exchange.request_is ?? ""));
    const path = SEAM.routes[exchange.route]!;
    const before =
      exchange.world === undefined
        ? null
        : await storedReport(realIdOf.get(SEAM.worlds[exchange.world]!.simulation_id)!);

    const answered = await sdk(
      path,
      body,
      exchange.without_authorization === true ? null : adaKey,
    );

    const expected = exchange.response ?? at(exchange.response_is ?? "");
    expect(answered.statusCode, `${name}: ${answered.raw}`).toBe(exchange.status);
    expect(withFixtureIds(answered.json)).toEqual(expected);
    if (exchange.bytes !== undefined) expect(answered.raw).toBe(exchange.bytes);

    if (exchange.world === undefined) return;
    const simulationId = realIdOf.get(SEAM.worlds[exchange.world]!.simulation_id)!;
    const stored = await storedReport(simulationId);

    if (exchange.records !== undefined) {
      const { first_at: firstAt, at: when, ...rest } = stored ?? {};
      expect(rest).toEqual(exchange.records);
      expect(typeof when).toBe("string");
      if (exchange.records.state === "accepted") expect(typeof firstAt).toBe("string");
    }
    if (name === "hello_repeated") {
      // The census is replaced and the time moves; the first acceptance stays.
      expect(stored?.first_at).toBe(before?.first_at);
      expect(Date.parse(String(stored?.at))).toBeGreaterThanOrEqual(
        Date.parse(String(before?.at)),
      );
    }
    if (exchange.route === "tool") {
      // A tool call records nothing.
      expect(stored).toEqual(before);
    }

    if (name === "hello") {
      const polled = await agentReport(simulationId);
      expect(polled.statusCode).toBe(SEAM.agent_report.accepted.status);
      const { at: polledAt, ...pinned } = withFixtureIds(polled.json) as Json;
      const { at: _fixtureAt, ...expectedPinned } = SEAM.agent_report.accepted.response;
      expect(pinned).toEqual(expectedPinned);
      expect(polledAt).toBe(stored?.at);
    }
    if (name === "hello_flows_mocked") {
      const polled = await agentReport(simulationId);
      expect(polled.statusCode).toBe(SEAM.agent_report.refused.status);
      const { at: _polledAt, ...pinned } = withFixtureIds(polled.json) as Json;
      const { at: _fixtureAt, ...expectedPinned } = SEAM.agent_report.refused.response;
      expect(pinned).toEqual(expectedPinned);
    }
    if (name === "hello_wrong_version") {
      expect(stored).toMatchObject({
        state: "refused",
        code: 904,
        message: (exchange.response as Json).message,
      });
    }
  });

  it("serves the in-room seam's own bytes for a tagged answer and error", () => {
    expect(SEAM.exchanges.tool_answer!.bytes).toBe(IN_ROOM.messages.tool_reply_answer!.bytes);
    expect(SEAM.exchanges.tool_error!.bytes).toBe(IN_ROOM.messages.tool_reply_error!.bytes);
  });

  it("refuses the simulator's poll from a claimant that does not hold the simulation", async () => {
    const calendar = realIdOf.get(SEAM.worlds.calendar!.simulation_id)!;
    const answered = await agentReport(calendar, { claimant: "egma-simulator-2" });
    expect(answered.statusCode).toBe(SEAM.agent_report.not_the_claimant.status);
    expect(answered.json).toEqual(SEAM.agent_report.not_the_claimant.response);
  });
});

describe("a hello repeated mid-simulation", () => {
  it("replaces an accepted report with the Flows refusal, which the simulator then reads", async () => {
    const world = await aClaimedSimulation("mid-simulation flows", [
      { tool: "check_calendar", answer: { slots: [] } },
      { tool: "route_to_billing", answer: { next: "billing" } },
    ]);
    const census = {
      provider_reference: world.simulationId,
      protocol_version: 1,
      tools: [{ name: "check_calendar", schema: { type: "object" } }],
    };

    const first = await sdk(SDK_HELLO_PATH, census);
    expect(first.statusCode, first.raw).toBe(200);
    expect((await agentReport(world.simulationId)).json).toMatchObject({ state: "accepted" });

    // The SDK learns a Flows function when the flow first offers it, and says
    // so in a second hello.
    const later = await sdk(SDK_HELLO_PATH, {
      ...census,
      tools: [
        ...census.tools,
        { name: "route_to_billing", schema: { type: "object", properties: {} }, flows: true },
      ],
    });
    const flowsMessage =
      'the test mocks "route_to_billing", and this is a Pipecat Flows function; Egma cannot mock it yet. ' +
      "Remove it from the test's mock tools. Flows functions that are not mocked run for real and are recorded.";
    expect(later.statusCode).toBe(422);
    expect(later.json).toEqual({ error: "flows_function_mocked", code: 905, message: flowsMessage });

    const polled = await agentReport(world.simulationId);
    expect(polled.statusCode).toBe(200);
    expect(polled.json).toEqual({
      simulation_id: world.simulationId,
      state: "refused",
      at: expect.any(String),
      code: 905,
      message: flowsMessage,
    });
    expect(await storedReport(world.simulationId)).toEqual({
      state: "refused",
      at: expect.any(String),
      code: 905,
      message: flowsMessage,
      tools: [
        { name: "check_calendar", schema: { type: "object" } },
        { name: "route_to_billing", schema: { type: "object", properties: {} }, flows: true },
      ],
    });
  });

  it("keeps the refusal for the rest of the simulation, whatever a later hello says", async () => {
    const world = await aClaimedSimulation("final refusal", [
      { tool: "check_calendar", answer: { slots: [] } },
      { tool: "route_to_billing", answer: { next: "billing" } },
    ]);
    const census = {
      provider_reference: world.simulationId,
      protocol_version: 1,
      tools: [{ name: "check_calendar" }],
    };
    expect((await sdk(SDK_HELLO_PATH, census)).statusCode).toBe(200);
    const flows = await sdk(SDK_HELLO_PATH, {
      ...census,
      tools: [...census.tools, { name: "route_to_billing", flows: true }],
    });
    expect(flows.statusCode).toBe(422);
    const refusedAt = (await agentReport(world.simulationId)).json;
    expect(refusedAt).toMatchObject({ state: "refused", code: 905 });

    // A hello that would be accepted on its own is answered with the refusal,
    // so the simulator's next poll still reads it.
    const later = await sdk(SDK_HELLO_PATH, census);
    expect(later.statusCode).toBe(422);
    expect(later.json).toEqual(flows.json);
    expect((await agentReport(world.simulationId)).json).toEqual(refusedAt);
  });

  it("names every mocked Flows function in census order", async () => {
    const world = await aClaimedSimulation("two flows functions", [
      { tool: "route_to_support", answer: { next: "support" } },
      { tool: "route_to_billing", answer: { next: "billing" } },
    ]);
    const answered = await sdk(SDK_HELLO_PATH, {
      provider_reference: world.simulationId,
      protocol_version: 1,
      tools: [
        { name: "route_to_billing", flows: true },
        { name: "route_to_support", flows: true },
      ],
    });
    expect(answered.statusCode).toBe(422);
    expect(answered.json).toEqual({
      error: "flows_function_mocked",
      code: 905,
      message: (at("exchanges.hello_flows_mocked") as { several_names_message: string })
        .several_names_message,
    });
  });
});

describe("the project key at the door", () => {
  it("refuses a key that names no project", async () => {
    const answered = await sdk(SDK_HELLO_PATH, at("exchanges.hello.request"), ada.secret);
    expect(answered.statusCode).toBe(403);
    expect(answered.json).toEqual({
      error: "not_permitted",
      message: "The Egma SDK needs a project API key; this key is not scoped to one project.",
    });
  });

  it("refuses a viewer's project key, which may not send traces", async () => {
    const vic = await colleagueOf(api.app, ada, "vic@lakeside.example", "viewer");
    const viewerKey = await mintKey(api.app, vic.cookie, "viewer terminal", vic.projectId);
    const answered = await sdk(
      SDK_TOOL_PATH,
      withRealIds(at("exchanges.tool_answer.request")),
      viewerKey,
    );
    expect(answered.statusCode).toBe(403);
    expect(answered.json).toMatchObject({ error: "not_permitted" });
  });

  it("answers a key of another project in the same organization as if the simulation were not there", async () => {
    const created = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const outboundKey = await mintKey(
      api.app,
      ada.cookie,
      "outbound terminal",
      String((created.json() as { id: string }).id),
    );
    for (const [path, body] of [
      [SDK_HELLO_PATH, at("exchanges.hello.request")],
      [SDK_TOOL_PATH, at("exchanges.tool_answer.request")],
    ] as const) {
      const answered = await sdk(path, withRealIds(body), outboundKey);
      expect(answered.statusCode, path).toBe(404);
      expect(answered.json).toEqual(SEAM.not_a_simulation.body);
    }
  });

  it("answers another project's key as if the simulation were not there", async () => {
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const graceKey = await projectKeyFor(api.app, grace);
    for (const [path, body] of [
      [SDK_HELLO_PATH, at("exchanges.hello.request")],
      [SDK_TOOL_PATH, at("exchanges.tool_answer.request")],
    ] as const) {
      const answered = await sdk(path, withRealIds(body), graceKey);
      expect(answered.statusCode).toBe(404);
      expect(answered.json).toEqual(SEAM.not_a_simulation.body);
    }
  });

  it("reads no body before the key, and bounds the body after it", async () => {
    const oversized = JSON.stringify({
      provider_reference: "sim_x",
      protocol_version: 1,
      tools: [{ name: "padding", schema: { text: "x".repeat(SEAM.limits.largest_hello_request_bytes!) } }],
    });
    expect((await sdk(SDK_HELLO_PATH, oversized, null)).statusCode).toBe(401);
    expect((await sdk(SDK_HELLO_PATH, oversized)).statusCode).toBe(413);

    const oversizedTool = JSON.stringify({
      provider_reference: "sim_x",
      name: "check_calendar",
      arguments: { text: "x".repeat(SEAM.limits.largest_tool_request_bytes!) },
    });
    expect((await sdk(SDK_TOOL_PATH, oversizedTool)).statusCode).toBe(413);
  });

  it("refuses a body that is not JSON as a message the exchange cannot read", async () => {
    const answered = await sdk(SDK_HELLO_PATH, "{not json");
    expect(answered.statusCode).toBe(422);
    expect(answered.json).toMatchObject({ error: "seam_refused", code: 901 });
  });
});

describe("what makes a simulation live for the SDK", () => {
  it("waits for the simulator to register the provider reference", async () => {
    const world = await aClaimedSimulation("unregistered", [], false);
    const census = { provider_reference: world.simulationId, protocol_version: 1, tools: [] };

    const early = await sdk(SDK_HELLO_PATH, census);
    expect(early.statusCode).toBe(404);
    expect(early.json).toEqual(SEAM.not_a_simulation.body);
    expect(await storedReport(world.simulationId)).toBeNull();

    expect((await registerReference(world.simulationId)).statusCode).toBe(200);
    const answered = await sdk(SDK_HELLO_PATH, census);
    expect(answered.statusCode, answered.raw).toBe(200);
    expect(answered.raw).toBe('{"protocol_version":1,"mocked_tools":[]}');
  });

  it("stops answering once the run is canceled", async () => {
    const world = await aClaimedSimulation("canceled", [
      { tool: "check_calendar", answer: { slots: [] } },
    ]);
    const call = { provider_reference: world.simulationId, name: "check_calendar" };
    expect((await sdk(SDK_TOOL_PATH, call)).statusCode).toBe(200);

    await cancelRun(contextFor(ada, "member"), world.runId);
    for (const [path, body] of [
      [SDK_TOOL_PATH, call],
      [SDK_HELLO_PATH, { provider_reference: world.simulationId, protocol_version: 1, tools: [] }],
    ] as const) {
      const answered = await sdk(path, body);
      expect(answered.statusCode).toBe(404);
      expect(answered.json).toEqual(SEAM.not_a_simulation.body);
    }
  });
});

describe("registering a Daily room simulation's provider reference", () => {
  it("takes only the simulation's own id, and says what else it would take", async () => {
    const world = await aClaimedSimulation("reference rules", [], false);

    const other = await registerReference(world.simulationId, "sim_somebody_else");
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({
      error: "invalid_request",
      message:
        "Registration requires a claimant and a provider reference: an Egma LiveKit room name, or this simulation's id for a Pipecat simulation.",
    });

    // A LiveKit room name is a well-formed reference, and not this lane's.
    const room = await registerReference(world.simulationId, `egma-sim-${world.simulationId}`);
    expect(room.statusCode).toBe(409);
    expect(room.json()).toEqual({
      error: "conflict",
      message: "This active claim cannot register that provider reference.",
    });

    const foreign = await registerReference(world.simulationId, world.simulationId, "egma-simulator-2");
    expect(foreign.statusCode).toBe(409);

    expect((await registerReference(world.simulationId)).statusCode).toBe(200);
    // A retry of the same registration is answered the same way.
    expect((await registerReference(world.simulationId)).statusCode).toBe(200);
  });

  it("forgets an earlier hello when the simulator registers again", async () => {
    const world = await aClaimedSimulation("fresh attempt", []);
    const hello = await sdk(SDK_HELLO_PATH, {
      provider_reference: world.simulationId,
      protocol_version: 1,
      tools: [],
    });
    expect(hello.statusCode).toBe(200);
    expect((await agentReport(world.simulationId)).json).toMatchObject({ state: "accepted" });

    expect((await registerReference(world.simulationId)).statusCode).toBe(200);
    expect((await agentReport(world.simulationId)).json).toEqual({
      simulation_id: world.simulationId,
      state: "waiting",
    });
  });
});

describe("the simulator's agent-report poll", () => {
  it("refuses a body that names no claimant, and a caller without the service token", async () => {
    const calendar = realIdOf.get(SEAM.worlds.calendar!.simulation_id)!;
    const bad = await agentReport(calendar, { claimant: "" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json).toMatchObject({ error: "invalid_request" });
    const extra = await agentReport(calendar, { claimant: CONDUCTOR, simulation_id: calendar });
    expect(extra.statusCode).toBe(400);

    const customer = await api.app.inject({
      method: "POST",
      url: `/v1/simulations/${calendar}/agent-report`,
      headers: { authorization: `Bearer ${adaKey}` },
      payload: SEAM.agent_report.request,
    });
    expect(customer.statusCode).toBe(401);
  });
});
