import {
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  listSimulations,
  startRun,
  startSimulation,
} from "@egma/db";
import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { reportPathFor } from "../src/routes/reports.ts";
import { decodeOtlpExport, type OtlpExport } from "../src/otlp/decode.ts";
import {
  PROVIDER_REFERENCE_ATTRIBUTE,
  WIRE_TRACE_ID_PAYLOAD_KEY,
} from "../src/otlp/normalise.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  capturedRequests,
  FIXTURE_PROVIDER_CALL_ID,
  FIXTURE_TRACE,
} from "./support/fixture.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  contextFor,
  projectKeyFor,
  signUp,
  NEUTRAL_PERSON,
  type Customer,
} from "./support/traces.ts";

/**
 * **The agent's own POV of a simulation, through the door a customer uses.**
 *
 * A simulation stores both POVs and shows the agent's (ADR-0015 §1). The
 * persona's POV is what egma's simulator said, heard and measured; the agent's
 * is what the agent's own process reported — its turns, its tool calls with the
 * arguments the model emitted and the results it received, its per-turn model
 * and voice timings. That second account arrives by **simulation ingestion**:
 * pushed here by the egma SDK over OTLP with the customer's own project key,
 * naming its conversation by the **provider reference** the platform gave it.
 *
 * What this file drives is the whole of that path, end to end and through no
 * seam that is not a customer's: the real captured LiveKit export goes in at
 * `POST /v1/traces` with a project key, and the simulation comes back out of
 * the v1 read a customer integrates against. Nothing here calls the filing step
 * or the normaliser directly — a test that did would prove the functions and
 * none of the contract.
 *
 * **The export is the real one.** `fixtures/livekit-otlp-trace` is fourteen
 * request bodies as an OTLP exporter actually sent them, byte for byte, from
 * one real conversation with a LiveKit voice agent: 133 spans, five human turns,
 * eight agent turns, two tool calls and three errored spans. The bytes on disk
 * are never edited. What this file adds before posting is the one thing the SDK
 * adds and the capture predates — the `egma.provider_reference` resource
 * attribute holding the room the conversation ran in — so the export posted is
 * the captured one plus exactly the fact that makes it a simulation's.
 *
 * The door answers on object-store durability and writes no row, so every post
 * is followed by a drain wherever the claim is about what a reader sees.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-agent-pov");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the agent-POV ingest suite — ${storage.why}\n\n`,
  );
}

/** Who conducted, as a simulator names itself. */
const CONDUCTOR = "simulator-agent-pov-1";

/** The moments the capture's own spans fall between, as the row reports them. */
const CONVERSATION_STARTED_AT = new Date("2026-08-02T18:04:40.000Z");
const CONVERSATION_ENDED_AT = new Date("2026-08-02T18:05:54.000Z");

let api: TestApi;
let acme: Customer;
let globex: Customer;
let acmeKey: string;
let globexKey: string;

/** Every captured request, already decoded, so a resource can be stamped. */
let captured: OtlpExport[] = [];

function store(): NonNullable<TestApi["traceStore"]> {
  const traceStore = api.traceStore;
  if (traceStore === undefined) throw new Error("this API has no trace store");
  return traceStore;
}

async function countOf(query: string): Promise<number> {
  const [row] = await store().rows<{ n: string }>(query);
  return Number(row?.n ?? -1);
}

/**
 * One decoded export with the SDK's own resource attribute on every resource.
 *
 * The capture was taken before the attribute existed, and the bytes are
 * evidence and are never rewritten — so the fact the SDK stamps is added here,
 * on the decoded form, and the export is posted as the JSON encoding of the
 * same message. Both encodings are one wire contract and the door reads them
 * through one decoder, so what this posts is what a stamped exporter sends.
 */
function naming(exported: OtlpExport, reference: string): string {
  return JSON.stringify({
    resourceSpans: (exported.resourceSpans ?? []).map((resourceSpans) => ({
      ...resourceSpans,
      resource: {
        ...resourceSpans.resource,
        attributes: [
          ...(resourceSpans.resource?.attributes ?? []),
          {
            key: PROVIDER_REFERENCE_ATTRIBUTE,
            value: { stringValue: reference },
          },
        ],
      },
    })),
  });
}

async function post(body: string, key: string) {
  return api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    payload: body,
  });
}

/** The whole capture, posted as the agent's POV of one simulation. */
async function exportTheCapture(
  key: string,
  reference: string,
): Promise<void> {
  for (const exported of captured) {
    const answered = await post(naming(exported, reference), key);
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({});
  }
  await api.drainEvidence();
}

/**
 * One conversation of one run, conducted and landed the way a simulator lands
 * one, reporting the room it ran in as its provider reference.
 *
 * Only the movement is at the data-access seam: no simulator runs in this
 * suite, and what lands on the row is what a real report lands. Everything the
 * reference then does — matching the export to this row, filing under its
 * trace, stamping its pins — happens at the door, over HTTP.
 */
async function aLandedSimulation(
  person: Customer,
  label: string,
  reference: string,
  connection: Record<string, unknown>,
): Promise<{ simulationId: string; runId: string; traceId: string }> {
  const auth = contextFor(person, "member");
  const created = await createAgent(auth, {
    agentPlatform: connection["agentPlatform"] as "livekit" | "retell",
    name: `Front desk ${label}`,
    connection: connection as never,
  });
  const personaId = (
    await createPersona(auth, { name: `Impatient Rita ${label}`, ...NEUTRAL_PERSON })
  ).id;
  const suiteId = (await createTestSuite(auth, { name: `Weather ${label}` })).id;
  await createTest(auth, {
    suiteId,
    name: `Asks about the weather ${label}`,
    scenario: "They want today's weather in two cities before they go out.",
    expectedBehaviors: ["gives the weather for every city that was asked about"],
    personaIds: [personaId],
  });

  const started = await startRun(auth, {
    suiteId,
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    idempotencyKey: newId("run"),
  });
  const page = await listSimulations(auth, started.id, { limit: 1 });
  const simulation = page?.items[0];
  if (simulation === undefined) throw new Error("the run has no simulation");

  const [claimed] = await claimSimulations({
    claimant: CONDUCTOR,
    capacity: 1,
  });
  expect(claimed?.id, "this run's conversation was the one to claim").toBe(
    simulation.id,
  );
  await startSimulation(auth, simulation.id, CONDUCTOR);
  await completeSimulation(auth, simulation.id, CONDUCTOR, {
    endingReason: "agent_ended",
    turnCount: 13,
    providerReference: reference,
    startedAt: CONVERSATION_STARTED_AT,
    endedAt: CONVERSATION_ENDED_AT,
  });

  return {
    simulationId: simulation.id,
    runId: started.id,
    traceId: traceIdOfSimulation(simulation.id) ?? "",
  };
}

const A_LIVEKIT_AGENT = {
  agentPlatform: "livekit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-weather" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

beforeAll(async () => {
  if (!storage.available) return;
  api = await createApi("otlp_agent_pov", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");
  acmeKey = await projectKeyFor(api.app, acme);
  globexKey = await projectKeyFor(api.app, globex);

  captured = (await capturedRequests()).map((request) =>
    decodeOtlpExport("protobuf", request.body),
  );
}, 120_000);

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

/** The wire's own trace id, off the capture itself rather than written out. */
function wireTraceIdOfCapture(): string {
  for (const exported of captured) {
    for (const resourceSpans of exported.resourceSpans ?? []) {
      for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
        const [span] = scopeSpans.spans ?? [];
        if (span?.traceId !== undefined) return span.traceId.toLowerCase();
      }
    }
  }
  throw new Error("the capture carries no trace id");
}

describe.skipIf(!storage.available)(
  "a project-key export naming its simulation",
  () => {
    let landed: { simulationId: string; runId: string; traceId: string };

    beforeAll(async () => {
      landed = await aLandedSimulation(
        acme,
        "livekit",
        FIXTURE_PROVIDER_CALL_ID,
        A_LIVEKIT_AGENT,
      );
      await exportTheCapture(acmeKey, FIXTURE_PROVIDER_CALL_ID);
    }, 120_000);

    it("files every span under the simulation's own trace, not the framework's", async () => {
      expect(landed.traceId).not.toBe("");
      expect(
        await countOf(
          `select count() as n from spans final where trace_id = '${landed.traceId}'`,
        ),
      ).toBe(FIXTURE_TRACE.spans);
      // And nothing was left behind under the id the exporter filed them
      // under: one conversation is one trace, so the wire id is a payload fact
      // and never a second address.
      expect(
        await countOf(
          `select count() as n from spans final where trace_id = '${wireTraceIdOfCapture()}'`,
        ),
      ).toBe(0);
    });

    it("stamps the agent's POV and the run and version pins off egma's own row", async () => {
      const rows = await store().rows<{
        source: string;
        emitter: string;
        run_id: string;
        agent_id: string;
        test_version_id: string;
        persona_version_id: string;
        n: string;
      }>(
        `select source, emitter, run_id, agent_id, test_version_id,
                persona_version_id, count() as n
         from spans final
         where trace_id = '${landed.traceId}'
         group by source, emitter, run_id, agent_id, test_version_id,
                  persona_version_id`,
      );

      // One stamp for the whole export, because attribution is a fact about
      // where the spans came from rather than about any one of them.
      expect(rows).toHaveLength(1);
      const [only] = rows;
      expect(only?.source).toBe("simulation");
      expect(only?.emitter).toBe("agent");
      expect(only?.run_id).toBe(landed.runId);
      expect(only?.agent_id).not.toBe("");
      expect(only?.test_version_id).not.toBe("");
      expect(only?.persona_version_id).not.toBe("");
      expect(Number(only?.n)).toBe(FIXTURE_TRACE.spans);
    });

    it("keeps the framework's trace id on the payload and leaves span ids alone", async () => {
      const wire = wireTraceIdOfCapture();
      expect(
        await countOf(
          `select count() as n from spans final
           where trace_id = '${landed.traceId}'
             and JSONExtractString(payload, '${WIRE_TRACE_ID_PAYLOAD_KEY}') = '${wire}'`,
        ),
      ).toBe(FIXTURE_TRACE.spans);

      // The span's own document is still under the payload beside it: the key
      // is added, and nothing that arrived is rewritten to make room for it.
      expect(
        await countOf(
          `select count() as n from spans final
           where trace_id = '${landed.traceId}'
             and JSONExtractString(payload, 'span', 'traceId') = '${wire}'`,
        ),
      ).toBe(FIXTURE_TRACE.spans);

      // Span ids are the emitter's to mint and are adopted, never re-derived:
      // every one of them is still the id the exporter sent.
      const distinct = await countOf(
        `select uniqExact(span_id) as n from spans final
         where trace_id = '${landed.traceId}'`,
      );
      expect(distinct).toBe(FIXTURE_TRACE.spans);
    });

    it("shows every tool call on the transcript, with its arguments and its result", async () => {
      const read = await api.app.inject({
        method: "GET",
        url: `/v1/simulations/${landed.simulationId}`,
        headers: { authorization: `Bearer ${acmeKey}` },
      });
      expect(read.statusCode, read.body).toBe(200);

      const body = read.json() as {
        providerReference: string;
        transcript: {
          traceId: string;
          spanCount: number;
          toolSpanCount: number;
          turnCounts: { human: number; agent: number };
        } | null;
      };

      expect(body.providerReference).toBe(FIXTURE_PROVIDER_CALL_ID);
      expect(body.transcript?.traceId).toBe(landed.traceId);
      expect(body.transcript?.spanCount).toBe(FIXTURE_TRACE.spans);
      expect(body.transcript?.turnCounts).toEqual({
        human: FIXTURE_TRACE.humanTurns,
        agent: FIXTURE_TRACE.agentTurns,
      });
      // The capture's own two calls, both of the example's `lookup_weather`
      // tool. Before ADR-0015 an unmocked call ran unobserved and none of them
      // would be here at all.
      expect(body.transcript?.toolSpanCount).toBe(FIXTURE_TRACE.toolSpans);

      const tools = await store().rows<{
        tool_name: string;
        tool_arguments: string;
        tool_result: string;
      }>(
        `select tool_name, tool_arguments, tool_result
         from spans final
         where trace_id = '${landed.traceId}' and kind = 'tool'
         order by started_at asc, span_id asc`,
      );
      expect(tools).toHaveLength(FIXTURE_TRACE.toolSpans);
      for (const tool of tools) {
        expect(tool.tool_name).toBe("lookup_weather");
        expect(tool.tool_arguments).not.toBe("");
        expect(tool.tool_result).not.toBe("");
      }
      // The arguments are the model's own, and the results are what it was
      // handed back: the two cities of the exchange, and an answer each.
      const said = tools
        .map((tool) => `${tool.tool_arguments} ${tool.tool_result}`)
        .join(" ")
        .toLowerCase();
      expect(said).toContain("lisbon");
      expect(said).toContain("oslo");
    });
  },
);

describe.skipIf(!storage.available)("a reference that names no simulation", () => {
  it("refuses the whole export and stores nothing", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    const answered = await post(naming(first, "a-room-nobody-ran-in"), acmeKey);
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { code: number; message: string };
    expect(refusal.message).toContain("a-room-nobody-ran-in");
    expect(refusal.message).toContain("Nothing from this request was stored");

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where JSONExtractString(payload, 'span', 'traceId') = '${wireTraceIdOfCapture()}'
           and source = 'production'`,
      ),
    ).toBe(0);
  });

  it("refuses a reference another project carries, in the same words", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // Globex's key, Acme's room. The reference exists — Acme's conversation
    // reported it — and it is answered exactly as one nobody carries is, so a
    // copied key cannot learn which rooms exist in an account it does not hold.
    const answered = await post(
      naming(first, FIXTURE_PROVIDER_CALL_ID),
      globexKey,
    );
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { message: string };
    expect(refusal.message).toContain("no simulation in this project carries");
    expect(refusal.message).toContain(FIXTURE_PROVIDER_CALL_ID);

    await api.drainEvidence();
    // Globex holds nothing at all: not the spans, and not a trace of its own.
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
      ),
    ).toBe(0);
  });
});

describe.skipIf(!storage.available)("a project-key export naming nothing", () => {
  it("is production, exactly as it was before the branch existed", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    const answered = await post(JSON.stringify(first), globexKey);
    expect(answered.statusCode, answered.body).toBe(200);
    await api.drainEvidence();

    const rows = await store().rows<{
      source: string;
      emitter: string;
      run_id: string;
      trace_id: string;
    }>(
      `select source, emitter, run_id, trace_id
       from spans final
       where project_id = '${globex.projectId}'
       limit 1`,
    );
    const [only] = rows;
    expect(only?.source).toBe("production");
    expect(only?.emitter).toBe("agent");
    // A trace arriving on a customer key was not started by egma, so it pins
    // nothing — and it stays filed under the id its own exporter chose.
    expect(only?.run_id).toBe("");
    expect(only?.trace_id).toBe(wireTraceIdOfCapture());
  });
});

describe.skipIf(!storage.available)("both POVs under one trace", () => {
  it("reads back with two parentless roots, and egma's is the one kept", async () => {
    const room = "egma-both-povs-1";
    const landed = await aLandedSimulation(acme, "both", room, {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-both" },
    });

    // The persona's POV, at the service door, where egma's own simulator posts
    // it: a root and two turns, filed under the trace the simulation spells.
    const at = (seconds: number): string =>
      String(
        BigInt(CONVERSATION_STARTED_AT.getTime() + seconds * 1000) * 1_000_000n,
      );
    const own = `${landed.traceId.slice(0, 14)}01`;
    const posted = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${api.config.simulatorServiceToken}`,
      },
      payload: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "egma-simulator" } },
                {
                  key: "egma.simulation_id",
                  value: { stringValue: landed.simulationId },
                },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "egma-simulator", version: "1" },
                spans: [
                  {
                    traceId: landed.traceId,
                    spanId: own,
                    parentSpanId: "",
                    name: "simulation",
                    kind: "SPAN_KIND_INTERNAL",
                    // Deliberately later than the agent's own session root, so
                    // that "whichever opened first" would pick the wrong row.
                    startTimeUnixNano: at(10),
                    endTimeUnixNano: at(60),
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(posted.statusCode, posted.body).toBe(200);

    // And the agent's POV of the same conversation, at the customer door.
    await exportTheCapture(acmeKey, room);

    const povs = await store().rows<{ emitter: string; n: string }>(
      `select emitter, count() as n from spans final
       where trace_id = '${landed.traceId}' group by emitter order by emitter`,
    );
    expect(povs.map((pov) => pov.emitter)).toEqual(["agent", "egma-runtime"]);
    expect(povs.map((pov) => Number(pov.n))).toEqual([FIXTURE_TRACE.spans, 1]);

    // Two parentless rows in one trace is ordinary now, and the read holds
    // both: every span that was filed comes back, and neither root is hidden
    // to make the tree look like it has one.
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${landed.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as {
      transcript: {
        spanCount: number;
        spans: { spanId: string; parentSpanId: string }[];
      } | null;
    };
    expect(body.transcript?.spanCount).toBe(FIXTURE_TRACE.spans + 1);
    const roots = (body.transcript?.spans ?? []).filter(
      (span) => span.parentSpanId === "",
    );
    expect(roots.map((root) => root.spanId)).toContain(own);
    expect(roots.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

/**
 * The Retell lane, where nothing exports and egma pulls instead.
 *
 * Retell runs no egma SDK, so the agent's POV of a Retell simulation is fetched
 * by egma the moment the conversation ends, with the connection's own stored
 * credential, and filed through the same step the push goes through. What
 * drives it here is the real report door: a landing arrives, and the record is
 * in the store afterwards.
 */
describe.skipIf(!storage.available)("a Retell simulation that ends", () => {
  const CALL_ID = "call_9f2b7a1c4e6d8b0a";
  let retellApi: TestApi;
  let asked: string[] = [];

  const RETELL_CALL = {
    call_id: CALL_ID,
    agent_id: "agent_front_desk",
    agent_name: "Front desk",
    agent_version: 4,
    call_status: "ended",
    start_timestamp: CONVERSATION_STARTED_AT.getTime(),
    end_timestamp: CONVERSATION_ENDED_AT.getTime(),
    disconnection_reason: "agent_hangup",
    transcript_with_tool_calls: [
      { role: "agent", content: "Hello, how can I help?" },
      { role: "user", content: "What is the weather in Lisbon?" },
      {
        role: "tool_call_invocation",
        tool_call_id: "tool_1",
        name: "lookup_weather",
        arguments: '{"city":"Lisbon"}',
      },
      {
        role: "tool_call_result",
        tool_call_id: "tool_1",
        content: '{"temperature":70,"sky":"sunny"}',
      },
      { role: "agent", content: "It is sunny and seventy degrees." },
    ],
  } as const;

  beforeAll(async () => {
    if (!storage.available) throw new Error("this suite has no object store");
    retellApi = await createApi("retell_agent_pov", {
      traceStore: true,
      ingestStore: storage.ingestStore,
      retellReach: {
        fetchImpl: (async (input: unknown) => {
          const asking = String(input);
          asked.push(asking);
          if (asking.includes(`/v2/get-call/${CALL_ID}`)) {
            return new Response(JSON.stringify(RETELL_CALL), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("", { status: 404 });
        }) as typeof fetch,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await retellApi?.close();
  });

  it("pulls its call record and files it under the simulation", async () => {
    const held = api;
    // The seeding helpers drive the API this file holds, and this case runs
    // against its own instance because only that one has Retell answering.
    api = retellApi;
    let landedSimulationId = "";
    let landedTraceId = "";
    try {
      const person = await signUp(api.app, "ada@acme.example", "Acme");
      const auth = contextFor(person, "member");
      const created = await createAgent(auth, {
        agentPlatform: "retell",
        name: "Front desk",
        connection: {
          agentPlatform: "retell",
          connectionType: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          config: { retellAgentId: "agent_front_desk" },
          credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
        },
      });
      const personaId = (
        await createPersona(auth, { name: "Impatient Rita", ...NEUTRAL_PERSON })
      ).id;
      const suiteId = (await createTestSuite(auth, { name: "Weather" })).id;
      await createTest(auth, {
        suiteId,
        name: "Asks about the weather",
        scenario: "They want today's weather before they go out.",
        expectedBehaviors: ["gives the weather that was asked about"],
        personaIds: [personaId],
      });
      const started = await startRun(auth, {
        suiteId,
        agentId: created.id,
        connectionId: created.connection?.id ?? "",
        idempotencyKey: newId("run"),
      });
      const page = await listSimulations(auth, started.id, { limit: 1 });
      const simulation = page?.items[0];
      if (simulation === undefined) throw new Error("the run has no simulation");
      landedSimulationId = simulation.id;
      landedTraceId = traceIdOfSimulation(simulation.id) ?? "";

      const [claimed] = await claimSimulations({
        claimant: CONDUCTOR,
        capacity: 1,
      });
      expect(claimed?.id).toBe(simulation.id);
      await startSimulation(auth, simulation.id, CONDUCTOR);

      // And the landing itself, through the door the simulator reports at.
      const landed = await api.app.inject({
        method: "POST",
        url: reportPathFor(simulation.id),
        headers: {
          authorization: `Bearer ${api.config.simulatorServiceToken}`,
        },
        payload: {
          contract_version: 1,
          simulation_id: simulation.id,
          events: [
            {
              kind: "status",
              event_id: "evt-000001",
              at: CONVERSATION_ENDED_AT.toISOString(),
              status: "completed",
              reason: null,
              facts: {
                ending: "agent_ended",
                started_at: CONVERSATION_STARTED_AT.toISOString(),
                ended_at: CONVERSATION_ENDED_AT.toISOString(),
                turn_count: 3,
                audio: null,
                provider_reference: CALL_ID,
              },
            },
          ],
        },
      });
      expect(landed.statusCode, landed.body).toBe(200);
      await api.drainEvidence();
    } finally {
      api = held;
    }

    // Retell was asked for that one call, with the connection's own key.
    expect(asked.some((one) => one.includes(`/v2/get-call/${CALL_ID}`))).toBe(
      true,
    );

    const traceStore = retellApi.traceStore;
    if (traceStore === undefined) throw new Error("no trace store");
    const rows = await traceStore.rows<{
      source: string;
      emitter: string;
      run_id: string;
      provider_call_id: string;
      n: string;
    }>(
      `select source, emitter, run_id, provider_call_id, count() as n
       from spans final
       where trace_id = '${landedTraceId}'
       group by source, emitter, run_id, provider_call_id`,
    );
    expect(rows).toHaveLength(1);
    const [only] = rows;
    // Filed under the simulation, as the agent's POV, with the pins — and the
    // call id kept, because that is what the two records are joined on.
    expect(only?.source).toBe("simulation");
    expect(only?.emitter).toBe("agent");
    expect(only?.run_id).not.toBe("");
    expect(only?.provider_call_id).toBe(CALL_ID);
    expect(Number(only?.n)).toBeGreaterThan(1);

    const toolNames = await traceStore.rows<{ tool_name: string }>(
      `select tool_name from spans final
       where trace_id = '${landedTraceId}' and kind = 'tool'`,
    );
    expect(toolNames.map((one) => one.tool_name)).toEqual(["lookup_weather"]);
    expect(landedSimulationId).not.toBe("");
  }, 120_000);
});
