import { readFile } from "node:fs/promises";

import {
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  getGradingJobForTrace,
  listSimulations,
  readProductionGradingPlan,
  startRun,
  startSimulation,
} from "@egma/db";
import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSingleConnection } from "../../../packages/db/test/support/database.ts";
import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  contextFor,
  everySpan,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
  type DetailSpan,
} from "./support/traces.ts";

/**
 * A Pipecat bot's own record arriving at the OTLP door: the egma SDK's two
 * simulation flushes (turns and tools, then the closing turn with the root
 * last), and one production flush. Posted with a project key, drained, and
 * read back the way the run view and Monitoring read them.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-pipecat");

if (!storage.available) {
  process.stderr.write(`\nskipping the Pipecat ingest suite — ${storage.why}\n\n`);
}

const FIXTURE_SIMULATION_ID = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP";

async function spanFixture(name: string): Promise<string> {
  return readFile(
    new URL(
      `../../../packages/simulation-contract/fixtures/spans/agent-pov/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}

const FLUSH_TURNS_AND_TOOLS = await spanFixture("pipecat-simulation-flush-1-turns-and-tools.json");
const FLUSH_ROOT = await spanFixture("pipecat-simulation-flush-2-root.json");
const PRODUCTION_FLUSH = await spanFixture("pipecat-production-flush.json");

/** The wire trace ids the fixtures were exported under. */
const SIMULATION_WIRE_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PRODUCTION_WIRE_TRACE = "7d2c9a0e5b1f4c3aa8e6b0d4c2f19e57";

/** The moments the fixtures' spans fall between. */
const STARTED_AT = new Date(1_790_146_805_000);
const ENDED_AT = new Date(1_790_146_820_000);

const CONDUCTOR = "egma-simulator-pipecat-1";

let api: TestApi;
let lakeside: Customer;
let lakesideKey: string;

function store(): NonNullable<TestApi["traceStore"]> {
  const traceStore = api.traceStore;
  if (traceStore === undefined) throw new Error("this API has no trace store");
  return traceStore;
}

async function post(body: string, key: string) {
  return api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    payload: body,
  });
}

/** One flush, as the SDK would send it for this simulation. */
function namingSimulation(flush: string, simulationId: string): string {
  return flush.replaceAll(FIXTURE_SIMULATION_ID, simulationId);
}

type Landed = { readonly simulationId: string; readonly runId: string; readonly traceId: string };

/**
 * A Pipecat Cloud simulation that ran and landed, its provider reference
 * registered by the simulator over the route, and its test mocking one of the
 * two tools the agent calls.
 */
async function aLandedPipecatSimulation(label: string): Promise<Landed> {
  const auth = contextFor(lakeside, "member");
  const agent = await createAgent(auth, {
    agentPlatform: "pipecat",
    name: `Lakeside front desk ${label}`,
    connection: {
      agentPlatform: "pipecat",
      connectionType: "daily_room",
      accessVariant: "daily_room.pipecat_cloud",
      modality: "voice",
      config: { agentName: `lakeside-${label}` },
      credentials: { publicApiKey: "pk_fixture0not0a0real0public0key" },
    },
  });
  const personaId = (
    await createPersona(auth, { name: `Eleanor ${label}`, ...NEUTRAL_PERSON })
  ).id;
  const suiteId = (await createTestSuite(auth, { name: `Check-ups ${label}` })).id;
  await createTest(auth, {
    suiteId,
    name: `Moves a check-up ${label}`,
    scenario: "Their Tuesday check-up has to move to a Thursday.",
    expectedBehaviors: ["reads the new date back before finishing"],
    personaIds: [personaId],
    mockTools: [{ tool: "check_calendar", answer: { slots: [] } }],
  });
  const started = await startRun(auth, {
    suiteId,
    agentId: agent.id,
    connectionId: agent.connection?.id ?? "",
  });
  const simulation = (await listSimulations(auth, started.id, { limit: 1 }))?.items[0];
  if (simulation === undefined) throw new Error("the run has no simulation");

  const [claimed] = await claimSimulations({ claimant: CONDUCTOR, capacity: 1 });
  expect(claimed?.id).toBe(simulation.id);
  const registered = await api.app.inject({
    method: "POST",
    url: `/v1/simulations/${simulation.id}/provider-reference`,
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: { claimant: CONDUCTOR, provider_reference: simulation.id },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  await startSimulation(auth, simulation.id, CONDUCTOR);
  await completeSimulation(auth, simulation.id, CONDUCTOR, {
    endingReason: "agent_ended",
    turnCount: 5,
    providerReference: simulation.id,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
  });
  return {
    simulationId: simulation.id,
    runId: started.id,
    traceId: traceIdOfSimulation(simulation.id) ?? "",
  };
}

async function readSimulation(simulationId: string) {
  const read = await api.app.inject({
    method: "GET",
    url: `/v1/simulations/${simulationId}`,
    headers: { authorization: `Bearer ${lakesideKey}` },
  });
  expect(read.statusCode, read.body).toBe(200);
  return read.json() as {
    agentPovComplete: boolean;
    transcript: {
      traceId: string;
      turns: DetailSpan[];
      spans: DetailSpan[];
    } | null;
  };
}

beforeAll(async () => {
  if (!storage.available) return;
  api = await createApi("otlp_pipecat_ingest", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  lakeside = await signUp(api.app, "ada@lakeside.example", "Lakeside");
  lakesideKey = await projectKeyFor(api.app, lakeside);
}, 120_000);

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("a Pipecat simulation's own record", () => {
  let landed: Landed;

  beforeAll(async () => {
    landed = await aLandedPipecatSimulation("simulation");
  }, 120_000);

  it("is not complete, and not graded, until the root arrives", async () => {
    const auth = contextFor(lakeside, "member");
    const posted = await post(
      namingSimulation(FLUSH_TURNS_AND_TOOLS, landed.simulationId),
      lakesideKey,
    );
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json()).toEqual({});
    await api.drainEvidence();

    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();
    expect((await readSimulation(landed.simulationId)).agentPovComplete).toBe(false);

    const root = await post(namingSimulation(FLUSH_ROOT, landed.simulationId), lakesideKey);
    expect(root.statusCode, root.body).toBe(200);
    await api.drainEvidence();

    expect(await getGradingJobForTrace(auth, landed.traceId)).toMatchObject({
      source: "simulation",
      traceId: landed.traceId,
    });
    expect((await readSimulation(landed.simulationId)).agentPovComplete).toBe(true);
  });

  it("reads as the agent's transcript, with every tool call and the mocked one marked", async () => {
    const body = await readSimulation(landed.simulationId);
    const transcript = body.transcript;
    if (transcript === null) throw new Error("the simulation has no transcript");
    expect(transcript.traceId).toBe(landed.traceId);

    expect(transcript.turns.map(({ kind, text, pov }) => ({ kind, text, pov }))).toEqual([
      { kind: "turn:agent", text: "Thanks for calling Lakeside Dental. How can I help?", pov: "agent" },
      { kind: "turn:human", text: "I need to move my Tuesday check-up to a Thursday.", pov: "agent" },
      { kind: "turn:agent", text: "Let me look. Thursday the 13th has openings.", pov: "agent" },
      { kind: "turn:human", text: "Thursday works, thank you.", pov: "agent" },
      { kind: "turn:agent", text: "You're booked for Thursday the 13th at 9 a.m.", pov: "agent" },
    ]);

    const all = everySpan([...transcript.turns, ...transcript.spans]);
    const tools = all.filter((span) => span.kind === "tool");
    expect(
      tools.map((span) => [span.toolName, span.toolArguments, span.toolResult, span.status, span.toolProvenance]),
    ).toEqual([
      ["check_calendar", '{"day":"2026-08-13"}', '{"slots":[]}', "unset", "mocked"],
      ["charge_card", '{"amount_cents":1200}', "card processor timed out", "error", undefined],
    ]);
    expect([...new Set(all.map((span) => span.pov))]).toEqual(["agent"]);
    expect(all.filter((span) => span.kind === "root").map((span) => span.name)).toEqual([
      "pipecat_session",
    ]);
  });

  it("files every span under the simulation as the pipecat agent's POV, and ends no production trace", async () => {
    const rows = await store().rows<{
      source: string;
      emitter: string;
      agent_platform: string;
      run_id: string;
      n: string;
    }>(
      `select source, emitter, agent_platform, run_id, toString(count()) as n
         from spans final
        where trace_id = '${landed.traceId}'
        group by source, emitter, agent_platform, run_id`,
    );
    expect(rows).toEqual([
      {
        source: "simulation",
        emitter: "agent",
        agent_platform: "pipecat",
        run_id: landed.runId,
        n: "15",
      },
    ]);
    // The root closed the agent's record, and no production trace with it.
    const [plans] = await store().rows<{ n: string }>(
      `select toString(count()) as n from production_grading_plans
        where trace_id in ('${landed.traceId}', '${SIMULATION_WIRE_TRACE}')`,
    );
    expect(plans?.n).toBe("0");

    const production = await api.app.inject({
      method: "GET",
      url: `/v1/traces?from=${STARTED_AT.toISOString()}&to=${ENDED_AT.toISOString()}&source=production`,
      headers: { authorization: `Bearer ${lakesideKey}` },
    });
    expect(production.statusCode, production.body).toBe(200);
    const ids = (production.json() as { traces: { traceId: string }[] }).traces.map(
      (trace) => trace.traceId,
    );
    expect(ids).not.toContain(SIMULATION_WIRE_TRACE);
    expect(ids).not.toContain(landed.traceId);
  });
});

describe.skipIf(!storage.available)("a Pipecat bot's production traffic", () => {
  const definitionId = newId("grl");
  const projectGraderId = newId("grd");

  beforeAll(async () => {
    // One grader whose scope selects production voice traffic.
    const setup = await openSingleConnection(api.database.url);
    await setup.sql("begin");
    await setup.sql(
      `insert into grader_definition
         (id, name, description, scope_editable, current_definition_version)
       values ($1, 'Production voice fixture', 'Grades completed voice traces', true, 1)`,
      [definitionId],
    );
    await setup.sql(
      `insert into grader_definition_version
         (definition_id, version, type, prompt, parameter_contract, modalities)
       values ($1, 1, 'code', null, '[]'::jsonb, '["voice"]'::jsonb)`,
      [definitionId],
    );
    await setup.sql("commit");
    await setup.close();
    await api.database.sql(
      `insert into project_grader
         (id, organization_id, project_id, grader_definition_id, scope,
          parameter_values, pass_threshold)
       values ($1, $2, $3, $4,
               '{"simulations":[],"production":{"sample_percent":100}}'::jsonb,
               '{}'::jsonb, 0.7)`,
      [projectGraderId, lakeside.organizationId, lakeside.projectId, definitionId],
    );
  });

  /** The agent's name the production fixture's bot sends in `egma.agent_name`. */
  const FIXTURE_AGENT_NAME = "Lakeside production bot";

  /** A living LiveKit agent of this project and its guarded monitoring key, as the product mints one. */
  async function aLiveKitMonitoringKey(name: string): Promise<string> {
    const registered = await ask(api.app, "POST", "/v1/agents", lakesideKey, {
      agentPlatform: "livekit",
      name,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const minted = await api.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie: lakeside.cookie },
      payload: {
        monitoringAgentId: agentId,
        projectId: lakeside.projectId,
        name: `Egma monitoring ${agentId} — ${name}`,
      },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    return (minted.json() as { secret: string }).secret;
  }

  /**
   * The production flush under another trace id, so one file can post it more
   * than once, with the bot's `egma.agent_name` kept or taken away.
   */
  function productionFlushUnder(traceId: string, named: boolean): string {
    const flush = JSON.parse(PRODUCTION_FLUSH.replaceAll(PRODUCTION_WIRE_TRACE, traceId)) as {
      resourceSpans: { resource: { attributes: { key: string }[] } }[];
    };
    if (!named) {
      for (const resourceSpans of flush.resourceSpans) {
        resourceSpans.resource.attributes = resourceSpans.resource.attributes.filter(
          (attribute) => attribute.key !== "egma.agent_name",
        );
      }
    }
    return JSON.stringify(flush);
  }

  type ListedRow = {
    traceId: string;
    agentPlatform: string;
    agentId: string;
    platformAgentName: string;
    platformAgentId: string;
  };

  async function listedProduction(traceId: string): Promise<ListedRow | undefined> {
    const listed = await api.app.inject({
      method: "GET",
      url: `/v1/traces?from=${STARTED_AT.toISOString()}&to=${ENDED_AT.toISOString()}&source=production`,
      headers: { authorization: `Bearer ${lakesideKey}` },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    return (listed.json() as { traces: ListedRow[] }).traces.find(
      (trace) => trace.traceId === traceId,
    );
  }

  async function storedAgentOf(traceId: string): Promise<{ agent_id: string; platform_agent_name: string }[]> {
    return store().rows<{ agent_id: string; platform_agent_name: string }>(
      `select distinct agent_id, platform_agent_name from spans final where trace_id = '${traceId}'`,
    );
  }

  it("shows the name the bot sends in egma.agent_name, ends on the root, and is graded", async () => {
    const posted = await post(PRODUCTION_FLUSH, lakesideKey);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json()).toEqual({});
    await api.drainEvidence();

    const rows = await store().rows<{
      name: string;
      kind: string;
      agent_platform: string;
      source: string;
      provider_call_id: string;
      agent_id: string;
      platform_agent_name: string;
    }>(
      `select name, kind, agent_platform, source, provider_call_id, agent_id, platform_agent_name
         from spans final
        where trace_id = '${PRODUCTION_WIRE_TRACE}'
        order by started_at asc, span_id asc`,
    );
    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ["pipecat_session", "root"],
      ["user_turn", "turn:human"],
      ["user_speaking", "speaking"],
      ["agent_turn", "turn:agent"],
      ["agent_speaking", "speaking"],
    ]);
    expect(new Set(rows.map((row) => row.agent_platform))).toEqual(new Set(["pipecat"]));
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["production"]));
    expect(new Set(rows.map((row) => row.provider_call_id))).toEqual(new Set(["8a1f0c33-pcc-session"]));
    // A name, as LiveKit's lk.agent_name is: it labels the trace and binds no agent id.
    expect(new Set(rows.map((row) => row.agent_id))).toEqual(new Set([""]));
    expect(new Set(rows.map((row) => row.platform_agent_name))).toEqual(
      new Set([FIXTURE_AGENT_NAME]),
    );

    // Monitoring → Transcripts lists it with the name in its Agent column.
    expect(await listedProduction(PRODUCTION_WIRE_TRACE)).toMatchObject({
      agentPlatform: "pipecat",
      agentId: "",
      platformAgentName: FIXTURE_AGENT_NAME,
    });

    const auth = contextFor(lakeside, "admin");
    await expect(readProductionGradingPlan(auth, PRODUCTION_WIRE_TRACE)).resolves.toMatchObject({
      traceId: PRODUCTION_WIRE_TRACE,
      entries: [{ projectGraderId, graderDefinitionId: definitionId }],
    });
    await expect(getGradingJobForTrace(auth, PRODUCTION_WIRE_TRACE)).resolves.toMatchObject({
      source: "production",
      traceId: PRODUCTION_WIRE_TRACE,
      status: "pending",
    });
  });

  it("shows no agent name when the bot sends none, and is still graded", async () => {
    const traceId = "7d2c9a0e5b1f4c3aa8e6b0d4c2f19e58";
    const posted = await post(productionFlushUnder(traceId, false), lakesideKey);
    expect(posted.statusCode, posted.body).toBe(200);
    await api.drainEvidence();

    expect(await storedAgentOf(traceId)).toEqual([{ agent_id: "", platform_agent_name: "" }]);
    expect(await listedProduction(traceId)).toMatchObject({
      agentPlatform: "pipecat",
      agentId: "",
      platformAgentName: "",
    });
    await expect(
      getGradingJobForTrace(contextFor(lakeside, "admin"), traceId),
    ).resolves.toMatchObject({ source: "production", traceId });
  });

  it("takes no name from the key: a guarded monitoring key names no agent", async () => {
    const monitoringKey = await aLiveKitMonitoringKey("Lakeside LiveKit desk");
    const traceId = "7d2c9a0e5b1f4c3aa8e6b0d4c2f19e59";
    const posted = await post(productionFlushUnder(traceId, false), monitoringKey);
    expect(posted.statusCode, posted.body).toBe(200);
    await api.drainEvidence();

    expect(await storedAgentOf(traceId)).toEqual([{ agent_id: "", platform_agent_name: "" }]);
  });
});
