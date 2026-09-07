import {
  claimSimulations,
  cancelRun,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  getGradingJobForTrace,
  laneProducesAnAgentPov,
  listSimulations,
  resolveSimulationStanding,
  resolveRunStartReach,
  settleSimulationsPastTheAgentPovBound,
  startRun,
  startSimulation,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { reportPathFor } from "../src/routes/reports.ts";
import { pullRetellSimulationRecord } from "../src/retell-simulation-ingestion.ts";
import { fileSimulationEvidence } from "../src/ingestion/simulation-ingestion.ts";
import { normaliseRetellCall } from "../src/retell/normalise.ts";
import { decodeOtlpExport, type OtlpExport } from "../src/otlp/decode.ts";
import {
  PROVIDER_REFERENCE_ATTRIBUTE,
  WIRE_TRACE_ID_PAYLOAD_KEY,
} from "../src/otlp/normalise.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  appointmentExport,
  capturedRequests,
  APPOINTMENT_ROOM,
  APPOINTMENT_TRACE,
  FIXTURE_PROVIDER_CALL_ID,
  FIXTURE_TRACE,
} from "./support/fixture.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  contextFor,
  everySpan,
  projectKeyFor,
  signUp,
  NEUTRAL_PERSON,
  type Customer,
  type DetailSpan,
} from "./support/traces.ts";

/**
 * **The agent's own POV of a simulation, through the door a customer uses.**
 *
 * A simulation stores both POVs and shows the agent's (ADR-0024 §1). The
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

/** The other capture: the booking, with the three tool calls, as one export. */
let booking: OtlpExport | undefined;

/**
 * The Retell call this file's Retell simulation ran, as Retell's own document.
 *
 * At module scope because the deployment's Retell reach is settled when the one
 * instance is built, and this file has one instance: a second `createApi` finds
 * Postgres already connected.
 */
const RETELL_CALL_ID = "call_9f2b7a1c4e6d8b0a";
const RETELL_CALL = {
  call_id: RETELL_CALL_ID,
  agent_id: "agent_front_desk",
  agent_name: "Front desk",
  agent_version: 4,
  call_status: "ended",
  start_timestamp: new Date("2026-08-02T18:04:40.000Z").getTime(),
  end_timestamp: new Date("2026-08-02T18:05:54.000Z").getTime(),
  disconnection_reason: "agent_hangup",
  // What Retell measured about the conversation. It rides Retell's own root
  // span as the reported-measurements block, and it is the observable half of
  // the parentless-row ranking below.
  latency: {
    e2e: { values: [820, 910, 760] },
    llm: { values: [410, 460] },
  },
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

/** Every address Retell was asked for, so the pull can be seen happening. */
const askedOfRetell: string[] = [];
const extraRetellCalls = new Map<string, object>();

/** Retell, answering for that one call and for nothing else. */
const retellAnswering = (async (input: unknown) => {
  const asking = String(input);
  askedOfRetell.push(asking);
  const callId = asking.split("/v2/get-call/")[1];
  const call = callId === RETELL_CALL_ID ? RETELL_CALL : extraRetellCalls.get(callId ?? "");
  if (call !== undefined) {
    return new Response(JSON.stringify(call), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;

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

/**
 * The SDK's other copy of the same fact: on every span, not on the resource.
 *
 * A resource is fixed when a tracer provider is built, and the SDK does not
 * always build one — a worker already running its own OpenTelemetry hands it a
 * provider that exists. There the room name rides through the framework's
 * metadata seam instead, which stamps every span the provider starts. This is
 * what that exporter's bytes look like.
 */
function namingOnEverySpan(
  exported: OtlpExport,
  ...references: (string | undefined)[]
): string {
  let at = 0;
  return JSON.stringify({
    resourceSpans: (exported.resourceSpans ?? []).map((resourceSpans) => ({
      ...resourceSpans,
      scopeSpans: (resourceSpans.scopeSpans ?? []).map((scopeSpans) => ({
        ...scopeSpans,
        spans: (scopeSpans.spans ?? []).map((span) => {
          const reference = references[at % references.length];
          at += 1;
          return {
            ...span,
            attributes: [
              ...(span.attributes ?? []),
              ...(reference === undefined
                ? []
                : [
                    {
                      key: PROVIDER_REFERENCE_ATTRIBUTE,
                      value: { stringValue: reference },
                    },
                  ]),
            ],
          };
        }),
      })),
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

/**
 * egma's own POV of one simulation, at the service door its simulator posts to:
 * a root and one turn, filed under the trace the simulation's id spells.
 *
 * The persona's account, in other words — what egma said, heard and measured —
 * and the only account a lane that files no agent POV ever has.
 */
async function postOwnPov(landed: {
  simulationId: string;
  traceId: string;
}): Promise<void> {
  const at = (seconds: number): string =>
    String(
      BigInt(CONVERSATION_STARTED_AT.getTime() + seconds * 1000) * 1_000_000n,
    );
  const root = `${landed.traceId.slice(0, 14)}91`;
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
                  spanId: root,
                  parentSpanId: "",
                  name: "simulation",
                  kind: "SPAN_KIND_INTERNAL",
                  startTimeUnixNano: at(0),
                  endTimeUnixNano: at(60),
                  attributes: [],
                },
                {
                  traceId: landed.traceId,
                  spanId: `${landed.traceId.slice(0, 14)}92`,
                  parentSpanId: root,
                  name: "agent_turn",
                  kind: "SPAN_KIND_INTERNAL",
                  startTimeUnixNano: at(1),
                  endTimeUnixNano: at(3),
                  attributes: [
                    {
                      key: "egma.turn.text",
                      value: { stringValue: "I moved it to Tuesday." },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(posted.statusCode, posted.body).toBe(200);
  await api.drainEvidence();
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
  // The moments the row reports, which is what the v1 read's window is built
  // from — so a capture's own spans have to fall inside them.
  moments: { startedAt: Date; endedAt: Date } = {
    startedAt: CONVERSATION_STARTED_AT,
    endedAt: CONVERSATION_ENDED_AT,
  },
  // What this scenario answers for itself. The pinned version is where a
  // mocked mark is read from at display time, so a test about that mark says
  // here which tool the world covers.
  mockTools: readonly { readonly tool: string; readonly answer: unknown }[] = [],
  land = true,
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
    ...(mockTools.length === 0 ? {} : { mockTools }),
  });

  const started = await startRun(auth, {
    suiteId,
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
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
  if (land) await completeSimulation(auth, simulation.id, CONDUCTOR, {
    endingReason: "agent_ended",
    turnCount: 13,
    providerReference: reference,
    startedAt: moments.startedAt,
    endedAt: moments.endedAt,
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
    // One instance for the file: a second `createApi` would find Postgres
    // already connected. Retell answers here too, because the Retell lane's
    // own ingestion is a pull rather than an export and the same instance has
    // to be able to make it.
    retellReach: { fetchImpl: retellAnswering },
    // The waits between attempts at a thin record are the module's own bound,
    // and nothing in this file is a claim about them — the record it answers
    // with is whole, so the first attempt is the only one.
    simulationPullOptions: { retryWaitsMilliseconds: [] },
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");
  acmeKey = await projectKeyFor(api.app, acme);
  globexKey = await projectKeyFor(api.app, globex);

  captured = (await capturedRequests()).map((request) =>
    decodeOtlpExport("protobuf", request.body),
  );
  booking = JSON.parse(await appointmentExport()) as OtlpExport;
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

describe.skipIf(!storage.available)("LiveKit evidence while the call is running", () => {
  it("registers the room before SDK exports and preserves project isolation", async () => {
    const running = await aLandedSimulation(acme, "early livekit export", "", A_LIVEKIT_AGENT,
      undefined, [], false);
    const room = `egma-sim-${running.simulationId}`;
    const register = (claimant = CONDUCTOR, reference = room, token = api.config.simulatorServiceToken) =>
      api.app.inject({ method: "POST", url: `/v1/simulations/${running.simulationId}/provider-reference`,
        headers: { authorization: `Bearer ${token}` },
        payload: { claimant, provider_reference: reference } });
    const first = captured[0];
    if (first === undefined) throw new Error("the capture is empty");
    expect((await post(naming(first, room), acmeKey)).statusCode).toBe(400);
    expect((await register(CONDUCTOR, room, acmeKey)).statusCode).toBe(401);
    expect((await register("another-conductor")).statusCode).toBe(409);
    const registered = await register();
    expect(registered.statusCode, registered.body).toBe(200);
    expect((await register()).statusCode).toBe(200);
    expect((await register(CONDUCTOR, `${room}-different`)).statusCode).toBe(409);
    expect((await post(naming(first, room), globexKey)).statusCode).toBe(400);
    await exportTheCapture(acmeKey, room);
    expect(await agentRowsIn(running.traceId)).toBeGreaterThan(1);
    const page = await listSimulations(contextFor(acme, "member"), running.runId, { limit: 1 });
    expect(page?.items[0]).toMatchObject({ status: "running", providerReference: room });
    await completeSimulation(contextFor(acme, "member"), running.simulationId, CONDUCTOR,
      { endingReason: "agent_ended", providerReference: room });
    expect((await register()).statusCode).toBe(409);
  });

  it("does not treat partial agent spans as the final agent record", async () => {
    const room = "egma-sim-partial-agent-record";
    const landed = await aLandedSimulation(acme, "partial livekit export", room, A_LIVEKIT_AGENT);
    for (const exported of captured) {
      const partial: OtlpExport = { resourceSpans: exported.resourceSpans?.map(resource => ({ ...resource,
        scopeSpans: resource.scopeSpans?.map(scope => ({ ...scope,
          spans: scope.spans?.filter(span => span.name !== "agent_session") })) })) };
      expect((await post(naming(partial, room), acmeKey)).statusCode).toBe(200);
    }
    await api.drainEvidence();
    const read = () => api.app.inject({ method: "GET", url: `/v1/simulations/${landed.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` } });
    expect((await read()).json()).toMatchObject({ agentPovComplete: false, agentPovIncomplete: true });
    await exportTheCapture(acmeKey, room);
    expect((await read()).json()).toMatchObject({ agentPovComplete: true, agentPovIncomplete: false });
  });
});

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
      // tool. Before ADR-0024 an unmocked call ran unobserved and none of them
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

describe.skipIf(!storage.available)(
  "a project-key export naming its simulation on every span",
  () => {
    it("files it the same way, for the worker whose provider Egma did not build", () => {
      // The SDK stamps the resource where it builds the tracer provider and
      // every span where it does not — a worker already running its own
      // OpenTelemetry keeps its provider, resource and all. Both copies carry
      // the same string, so both must file the same way, or a customer with
      // Langfuse installed would find their simulations in Monitoring.
      return (async () => {
        const [first] = captured;
        if (first === undefined) throw new Error("the capture is empty");
        const landed = await aLandedSimulation(
          acme,
          "livekit-span-stamped",
          "room-stamped-on-spans",
          {
            ...A_LIVEKIT_AGENT,
            config: {
              url: "wss://acme.livekit.cloud",
              agentName: "front-desk-span-stamped",
            },
          },
        );

        const answered = await post(
          namingOnEverySpan(first, "room-stamped-on-spans"),
          acmeKey,
        );
        expect(answered.statusCode, answered.body).toBe(200);
        await api.drainEvidence();

        const rows = await store().rows<{
          emitter: string;
          source: string;
          n: number;
        }>(
          `select emitter, source, count() as n
           from spans final
           where trace_id = '${landed.traceId}'
           group by emitter, source`,
        );
        expect(rows.map(({ emitter, source }) => ({ emitter, source }))).toEqual([
          { emitter: "agent", source: "simulation" },
        ]);
        expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
      })();
    }, 120_000);

    it("files the spans that opened before the SDK's stamp existed too", () => {
      /*
       * The case every customer with their own OpenTelemetry produces.
       *
       * The framework's metadata processor stamps a span when the span
       * *starts*, and the SDK installs it partway through a job that has
       * already begun — so the job's own entrypoint span, and anything else
       * open at that moment, ends unstamped and rides the same export. There
       * is nothing ambiguous about it: nothing else in the resource names
       * another conversation. Refusing it would refuse the whole export, and
       * every such customer would lose the agent's POV of every simulation,
       * silently.
       */
      return (async () => {
        const [first] = captured;
        if (first === undefined) throw new Error("the capture is empty");
        const landed = await aLandedSimulation(
          acme,
          "livekit-reused-provider",
          "room-reused-provider",
          {
            ...A_LIVEKIT_AGENT,
            config: {
              url: "wss://acme.livekit.cloud",
              agentName: "front-desk-reused-provider",
            },
          },
        );

        // The first span opened before the stamp; every one after it carries
        // the room.
        const answered = await post(
          namingOnEverySpan(first, undefined, "room-reused-provider"),
          acmeKey,
        );
        expect(answered.statusCode, answered.body).toBe(200);
        await api.drainEvidence();

        // Every span of that resource, the unstamped one included, filed
        // under the simulation the rest of them named.
        const posted = (JSON.parse(
          namingOnEverySpan(first, undefined, "room-reused-provider"),
        ) as OtlpExport).resourceSpans?.flatMap(
          (one) => one.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
        );
        expect(
          await countOf(
            `select count() as n from spans final
             where trace_id = '${landed.traceId}' and emitter = 'agent'`,
          ),
        ).toBe(posted?.length ?? -1);
      })();
    }, 120_000);
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

  it("refuses a reference that is there and empty, rather than filing it as production", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // The attribute carried, with nothing in it: the sender said these spans
    // are a simulation's and left out which. Reading the value alone cannot
    // tell this from a resource that never carried the key, and treating the
    // two alike would file a misconfigured SDK's simulation under Monitoring.
    const answered = await post(naming(first, ""), globexKey);
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { message: string };
    expect(refusal.message).toContain("with no value");
    expect(refusal.message).toContain("Nothing from this request was stored");

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
      ),
    ).toBe(0);
  });

  it("refuses a resource whose spans do not agree on the conversation", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // One agent process runs one conversation, so spans under one resource
    // that name two rooms are a sender this door cannot file for — and
    // guessing either answer is how one customer's turns land on another's
    // record.
    const answered = await post(
      namingOnEverySpan(first, "room-lisbon", "room-oslo"),
      globexKey,
    );
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { message: string };
    expect(refusal.message).toContain("do not agree");
    expect(refusal.message).toContain("room-lisbon");
    expect(refusal.message).toContain("room-oslo");
    expect(refusal.message).toContain("Nothing from this request was stored");

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
      ),
    ).toBe(0);
  });

  it("refuses a resource whose stamped spans name two conversations by turns", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // Alternating, so no single span is the odd one out: whichever answer
    // this door picked, half the spans said the other.
    const answered = await post(
      namingOnEverySpan(first, "room-lisbon", "room-oslo", "room-lisbon"),
      globexKey,
    );
    expect(answered.statusCode).toBe(400);
    expect((answered.json() as { message: string }).message).toContain(
      "do not agree",
    );

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
      ),
    ).toBe(0);
  });

  it("refuses a span-stamped reference another project carries, in the same words", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // The tenancy rule on the span path, which the resource path already
    // proves: Globex's key, Acme's room. A reference is never a tenancy
    // claim, on either path — it is looked up inside the project the
    // credential resolved to, so a copied key learns nothing about the
    // rooms in an account it does not hold.
    const answered = await post(
      namingOnEverySpan(first, FIXTURE_PROVIDER_CALL_ID),
      globexKey,
    );
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { message: string };
    expect(refusal.message).toContain("no simulation in this project carries");
    expect(refusal.message).toContain(FIXTURE_PROVIDER_CALL_ID);

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
      ),
    ).toBe(0);
  });

  it("refuses an export naming more conversations than one process can run", async () => {
    const [first] = captured;
    if (first === undefined) throw new Error("the capture is empty");

    // Nine rooms in one export, each on its own resource. An agent process is
    // in one room, so this is a configuration mistake — and each distinct
    // reference would otherwise cost a store lookup before a byte is read.
    const many = JSON.stringify({
      resourceSpans: Array.from({ length: 9 }, (_, at) =>
        JSON.parse(naming(first, `room-${String(at)}`)).resourceSpans[0],
      ),
    });
    const answered = await post(many, globexKey);
    expect(answered.statusCode).toBe(400);
    const refusal = answered.json() as { message: string };
    expect(refusal.message).toContain("names 9 conversations");
    expect(refusal.message).toContain("Nothing from this request was stored");

    await api.drainEvidence();
    expect(
      await countOf(
        `select count() as n from spans final
         where project_id = '${globex.projectId}'`,
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

describe.skipIf(!storage.available)("the row caps, across an export naming two", () => {
  it("bounds the request rather than each simulation it names", async () => {
    // Two conversations of this project, and one export speaking for both.
    // Each simulation is normalised on its own — two must never be blended —
    // so before the budget was carried, each got the whole ten thousand and an
    // export naming N simulations bought N times the bound.
    const first = await aLandedSimulation(acme, "cap-one", "room-cap-1", {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-cap-1" },
    });
    const second = await aLandedSimulation(acme, "cap-two", "room-cap-2", {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-cap-2" },
    });

    const at = String(BigInt(CONVERSATION_STARTED_AT.getTime()) * 1_000_000n);
    const resourceOf = (reference: string, from: number, count: number) => ({
      resource: {
        attributes: [
          {
            key: PROVIDER_REFERENCE_ATTRIBUTE,
            value: { stringValue: reference },
          },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "livekit-agents", version: "1" },
          spans: Array.from({ length: count }, (_, index) => ({
            traceId: "cafe0000cafe0000cafe0000cafe0000",
            spanId: `cafe0000${(from + index).toString(16).padStart(8, "0")}`,
            parentSpanId: "",
            name: "llm_request",
            kind: "SPAN_KIND_INTERNAL",
            startTimeUnixNano: at,
            endTimeUnixNano: at,
            attributes: [],
          })),
        },
      ],
    });

    // Ten thousand and six spans, split across the two.
    const answered = await post(
      JSON.stringify({
        resourceSpans: [
          resourceOf("room-cap-1", 0, 5_003),
          resourceOf("room-cap-2", 5_003, 5_003),
        ],
      }),
      acmeKey,
    );
    expect(answered.statusCode, answered.body).toBe(200);
    const partial = answered.json() as {
      partialSuccess?: { rejectedSpans: string; errorMessage: string };
    };
    // Six over the one bound, reported once — not zero, which is what two
    // fresh budgets would have answered.
    expect(partial.partialSuccess?.rejectedSpans).toBe("6");
    expect(partial.partialSuccess?.errorMessage).toContain("10,000");
    await api.drainEvidence();

    // And what was stored is the bound, counted across both conversations.
    expect(
      await countOf(
        `select count() as n from spans final
         where trace_id in ('${first.traceId}', '${second.traceId}')`,
      ),
    ).toBe(10_000);
  }, 120_000);
});

/**
 * **When grading is asked for, and never before.**
 *
 * ADR-0024 §6: a simulation's evidence is ready when the row is complete *and*
 * the agent's own POV has been filed — or when 30 seconds have passed since
 * completion on a lane that produces one. Grading a conversation before the
 * account it will be judged on has arrived is grading the wrong evidence, and
 * the wait must end anyway, because a broken exporter cannot be allowed to hold
 * a simulation open forever.
 *
 * The three cases below are the whole rule: the wait, its end when the POV
 * lands, and its end when the bound expires. Each reads the queue through the
 * data-access seam the grading service claims from, because a job row is the
 * whole of what "grading was asked for" means.
 */
describe.skipIf(!storage.available)("when a simulation's grading is asked for", () => {
  /** What the v1 read says about the agent's account of one simulation. */
  async function agentPovIncompleteOf(simulationId: string): Promise<unknown> {
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    return (read.json() as { agentPovIncomplete: boolean }).agentPovIncomplete;
  }

  it("waits: a landing files no grading work while the agent's POV is still coming", async () => {
    const room = "egma-grading-waits-1";
    const landed = await aLandedSimulation(acme, "waits", room, {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-waits" },
    });

    const auth = contextFor(acme, "member");
    // The row is complete and its graders are planned, and still nothing is
    // queued: the agent has not said anything about this conversation yet.
    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();
    const [row] = (await listSimulations(auth, landed.runId, { limit: 1 }))
      ?.items ?? [];
    expect(row?.status).toBe("completed");
  }, 120_000);

  it("asks the moment the agent's POV lands, and says the record has it", async () => {
    const room = "egma-grading-lands-1";
    const landed = await aLandedSimulation(acme, "lands", room, {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-lands" },
    });
    const auth = contextFor(acme, "member");
    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();

    await exportTheCapture(acmeKey, room);

    const job = await getGradingJobForTrace(auth, landed.traceId);
    expect(job?.traceId).toBe(landed.traceId);
    expect(job?.source).toBe("simulation");
    // And the read says the record is whole, so a page showing the agent's POV
    // knows it is showing the conversation rather than a fragment of it.
    expect(await agentPovIncompleteOf(landed.simulationId)).toBe(false);
  }, 120_000);

  /**
   * The bound, and the record it leaves. Nothing is exported for this
   * conversation at all — the agent's exporter is broken, or its platform never
   * answered — so the wait can only end on a clock.
   *
   * The sweep is called directly rather than waited for: the loop that runs it
   * on an interval is the API's, and what is proved here is the seam's own
   * decision.
   */
  it("stops waiting at the bound, grades anyway, and says the POV is incomplete", async () => {
    const room = "egma-grading-bound-1";
    const landed = await aLandedSimulation(acme, "bound", room, {
      ...A_LIVEKIT_AGENT,
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk-bound" },
    });
    const auth = contextFor(acme, "member");
    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();

    const settled = await settleSimulationsPastTheAgentPovBound();
    expect(settled.map((one) => one.id)).toContain(landed.simulationId);
    expect(
      settled.find((one) => one.id === landed.simulationId)?.agentPovFiled,
    ).toBe(false);

    const job = await getGradingJobForTrace(auth, landed.traceId);
    expect(job?.traceId).toBe(landed.traceId);
    // **And the read says so**, which is the half a reader needs: a view that
    // shows the agent's POV would otherwise show whatever fragment arrived as
    // if it were the whole conversation.
    expect(await agentPovIncompleteOf(landed.simulationId)).toBe(true);

    // **And it settles nothing a second time.** The queue row is the record of
    // grading having been asked for, so a later tick reads it and passes the
    // row over — which is what keeps one conversation to one handoff however
    // many replicas are reading the clock.
    const again = await settleSimulationsPastTheAgentPovBound();
    expect(again.map((one) => one.id)).not.toContain(landed.simulationId);
  }, 120_000);

  /**
   * A landing whose clock is an hour behind egma's.
   *
   * `ended_at` comes off the report, so a simulator with a skewed clock writes
   * a moment egma never saw. The bound reads it — it is the conversation's own
   * moment and the one a person reads — but the window this sweep looks in
   * cannot, or a row would be stamped outside every window that could ever
   * settle it and wait for grading forever with nothing saying so. The window
   * reads egma's own landing stamp instead.
   */
  it("still settles a landing whose reported clock is far behind egma's", async () => {
    const room = "egma-grading-skewed-1";
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1_000);
    const landed = await aLandedSimulation(
      acme,
      "skewed",
      room,
      {
        ...A_LIVEKIT_AGENT,
        config: {
          url: "wss://acme.livekit.cloud",
          agentName: "front-desk-skewed",
        },
      },
      {
        startedAt: new Date(longAgo.getTime() - 60 * 1_000),
        endedAt: longAgo,
      },
    );
    const auth = contextFor(acme, "member");
    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();

    // The standing window, unwidened: six hours outside it by the report's own
    // clock, and inside it by the stamp egma wrote when the landing arrived.
    const settled = await settleSimulationsPastTheAgentPovBound();
    expect(settled.map((one) => one.id)).toContain(landed.simulationId);
    expect(
      (await getGradingJobForTrace(auth, landed.traceId))?.traceId,
    ).toBe(landed.traceId);
  }, 120_000);

  /**
   * A lane egma dials rather than joins produces no agent POV at all: nothing
   * of egma's runs on the far end of a phone call. There is no second account
   * coming, so there is nothing to wait for.
   */
  it("does not wait at all for a lane that produces no agent POV", async () => {
    const landed = await aLandedSimulation(acme, "phone", "", {
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+15551230000" },
    });

    const auth = contextFor(acme, "member");
    const [row] = (await listSimulations(auth, landed.runId, { limit: 1 }))
      ?.items ?? [];
    expect(row?.status).toBe("completed");
    // Nothing to warn a reader about: no account was ever owed.
    expect(await agentPovIncompleteOf(landed.simulationId)).toBe(false);
    const bounded = await settleSimulationsPastTheAgentPovBound();
    expect(bounded.map((one) => one.id)).not.toContain(landed.simulationId);
  }, 120_000);

  /**
   * **The two Retell lanes that could never deliver one either.**
   *
   * A chat-API conversation's reference is a chat id, and egma's pull asks for
   * a *call* record by call id — so a chat id would fetch nothing however long
   * anything waited. Text mode is the same answer for a different reason: egma
   * carries the whole exchange on its own requests and Retell hands back no
   * reference to fetch anything by at all.
   *
   * Naming either as producing an agent POV would make every simulation over it
   * wait out the whole bound and then be recorded as missing an account nobody
   * was ever going to send. So the drain of egma's own POV is the whole handoff
   * on both: grading is asked for as soon as that evidence is query-visible,
   * with no bound in between.
   *
   * The chat lane is conducted here end to end. Text mode is pinned by the list
   * itself rather than conducted, because a run over it is opened against a
   * named agent version and cannot be started without the platform read this
   * suite has no reason to stand up.
   */
  it("grades a chat-lane landing off egma's own POV, with no bound in between", async () => {
    const landed = await aLandedSimulation(
      acme,
      "chatlane",
      "chat_5d1f9a3b7c",
      {
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_chat_lane" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    );
    const auth = contextFor(acme, "member");
    expect(await getGradingJobForTrace(auth, landed.traceId)).toBeUndefined();

    await postOwnPov(landed);

    // No sweep, no bound: the one account this lane has arrived, and that is
    // the whole of what grading was waiting on.
    const job = await getGradingJobForTrace(auth, landed.traceId);
    expect(job?.traceId).toBe(landed.traceId);
    // And nothing is missing, because nothing was owed.
    expect(await agentPovIncompleteOf(landed.simulationId)).toBe(false);

    // The same decision about the lane beside it, and about the two that can.
    expect(laneProducesAnAgentPov("retell_text_mode")).toBe(false);
    expect(laneProducesAnAgentPov("retell_chat_api")).toBe(false);
    expect(laneProducesAnAgentPov("livekit_room")).toBe(true);
    expect(laneProducesAnAgentPov("retell_web_call")).toBe(true);
  }, 120_000);
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
    // **One conversation, counted once.** Both POVs are stored and both come
    // back in the tree, but the counts beside them are the agent's POV alone —
    // otherwise a reader would be told this conversation held one more step
    // than the agent ever took, and on a trace with two full POVs, twice as
    // many turns as anybody spoke.
    expect(body.transcript?.spanCount).toBe(FIXTURE_TRACE.spans);
    const roots = (body.transcript?.spans ?? []).filter(
      (span) => span.parentSpanId === "",
    );
    // Exactly two, and both named: egma's own, and LiveKit's session root.
    // Neither is hidden to make the tree look like it has one root, and
    // neither displaced the other.
    expect(roots).toHaveLength(2);
    expect(roots.map((root) => root.spanId)).toContain(own);
    const agentRoot = await store().rows<{ span_id: string }>(
      `select span_id from spans final
       where trace_id = '${landed.traceId}' and parent_span_id = ''
         and emitter = 'agent'`,
    );
    expect(roots.map((root) => root.spanId)).toContain(agentRoot[0]?.span_id);
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

/**
 * The booking, and the three tool calls that opened this effort.
 *
 * `fixtures/livekit-appointment-trace` is the export of the run that found the
 * hole: its agent called `list_providers`, `check_availability` and
 * `book_appointment`, and egma's record of the simulation showed one of them,
 * because a tool egma did not answer ran unobserved. Every one of the three is
 * on the transcript now, because the agent itself reported it.
 */
describe.skipIf(!storage.available)("the booking that opened this effort", () => {
  let landed: { simulationId: string; runId: string; traceId: string };

  beforeAll(async () => {
    landed = await aLandedSimulation(
      acme,
      "booking",
      APPOINTMENT_ROOM,
      {
        ...A_LIVEKIT_AGENT,
        config: {
          url: "wss://acme.livekit.cloud",
          agentName: "appointment-scheduling",
        },
      },
      {
        startedAt: new Date("2026-09-04T17:52:00.000Z"),
        endedAt: new Date("2026-09-04T17:55:00.000Z"),
      },
      // The one tool this test stood in front of. The other two ran for real
      // inside the agent's own process, which is exactly the case that used to
      // be invisible.
      [{ tool: "check_availability", answer: { slots: [] } }],
    );

    if (booking === undefined) throw new Error("the booking capture is missing");
    const answered = await post(naming(booking, APPOINTMENT_ROOM), acmeKey);
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({});
    await api.drainEvidence();
  }, 120_000);

  it("shows all three tool calls, with their arguments and their results", async () => {
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${landed.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as {
      transcript: {
        traceId: string;
        spanCount: number;
        toolSpanCount: number;
        turnCounts: { human: number; agent: number };
      } | null;
    };

    expect(body.transcript?.traceId).toBe(landed.traceId);
    expect(body.transcript?.spanCount).toBe(APPOINTMENT_TRACE.spans);
    expect(body.transcript?.toolSpanCount).toBe(APPOINTMENT_TRACE.toolSpans);
    expect(body.transcript?.turnCounts).toEqual({
      human: APPOINTMENT_TRACE.humanTurns,
      agent: APPOINTMENT_TRACE.agentTurns,
    });

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
    expect(tools.map((tool) => tool.tool_name)).toEqual([
      ...APPOINTMENT_TRACE.tools,
    ]);

    // Every one of them carries what it was handed back.
    expect(tools[0]?.tool_result).toContain("Doctor Alvarez");
    expect(tools[1]?.tool_result).toContain("Thursday");
    expect(tools[2]?.tool_result).toContain("Booked");

    // And the arguments the model emitted, on the two tools that take any.
    // `list_providers` takes none, so its span carries none — an absent fact
    // stays absent rather than becoming an empty object nobody wrote.
    expect(tools[0]?.tool_arguments).toBe("");
    expect(tools[1]?.tool_arguments).toContain("preferred_date");
    expect(tools[1]?.tool_arguments).toContain("Tuesday");
    expect(tools[2]?.tool_arguments).toContain("appointment_slot");
    expect(tools[2]?.tool_arguments).toContain("Doctor Alvarez");
  });

  /**
   * **The mocked mark, read by name and from nowhere else.**
   *
   * These spans are LiveKit's own: the agent's process wrote them and nothing
   * of egma's ever touched them, so there is no stamp on them to read. What
   * says `check_availability` was answered by a mock tool is the test version
   * this simulation pinned, matched by tool name — the authored world itself,
   * which cannot change under a result. The two calls that world does not
   * cover ran for real and carry no mark at all, which is the whole
   * distinction a developer opens this transcript for.
   */
  it("marks the one call a mock tool answered, by name, and no other", async () => {
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${landed.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as {
      transcript: {
        readonly turns: DetailSpan[];
        readonly spans: DetailSpan[];
      } | null;
    };
    const transcript = body.transcript;
    if (transcript === null) throw new Error("the simulation has no transcript");

    const all = everySpan([...transcript.turns, ...transcript.spans]);
    const tools = all.filter((span) => span.kind === "tool");
    expect(tools.map((span) => [span.toolName, span.toolProvenance])).toEqual([
      ["list_providers", undefined],
      ["check_availability", "mocked"],
      ["book_appointment", undefined],
    ]);

    // Every span of this transcript is the agent's own account of the
    // conversation, which is what the run view renders.
    expect([...new Set(all.map((span) => span.pov))]).toEqual(["agent"]);
  });

  it("files it under the simulation, as the agent's POV, and keeps LiveKit's id", async () => {
    const rows = await store().rows<{
      source: string;
      emitter: string;
      run_id: string;
      n: string;
    }>(
      `select source, emitter, run_id, count() as n from spans final
       where trace_id = '${landed.traceId}'
       group by source, emitter, run_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("simulation");
    expect(rows[0]?.emitter).toBe("agent");
    expect(rows[0]?.run_id).toBe(landed.runId);
    expect(Number(rows[0]?.n)).toBe(APPOINTMENT_TRACE.spans);

    expect(
      await countOf(
        `select count() as n from spans final
         where trace_id = '${landed.traceId}'
           and JSONExtractString(payload, '${WIRE_TRACE_ID_PAYLOAD_KEY}') = '${APPOINTMENT_TRACE.wireTraceId}'`,
      ),
    ).toBe(APPOINTMENT_TRACE.spans);
  });

  /**
   * **The number this whole effort is about**, on the conversation that opened
   * it, read back through the contract a customer reads.
   *
   * Five human turns, four of them answered. Each wait starts where the caller
   * stopped being audible — the end of that `user_turn`'s last `user_speaking`
   * child, which is the VAD's own detected end — and stops at the first
   * `agent_speaking` before the next human turn. Hand-computed once from the
   * export's raw nanosecond timestamps, held as the store keeps them: starts
   * truncated to the microsecond, durations exact.
   *
   *   1. caller stops being audible 1788544388880703312, agent speaks
   *      1788544392672227000 → 3791.523688 ms
   *   2. 1788544412831362936 → 1788544414353803000 → 1522.440064 ms
   *   3. 1788544429283150472 → 1788544431499003000 → 2215.852528 ms
   *   4. 1788544442631104016 → 1788544444538535000 → 1907.430984 ms
   *
   * From `user_turn`'s own end — the endpointing commit, which is where the
   * derivation stopped before catalog version 8 — the same four turns read
   * 3334.056376, 1108.662037, 1770.409112 and 1394.444331 ms. That difference,
   * about half a second a turn, is time the caller really waited.
   *
   * The fifth human turn is never answered: two agent turns follow it and
   * neither speaks, so it measures nothing rather than borrowing the next
   * conversation's silence.
   */
  it("measures the four answered waits from the caller's last audible sample", async () => {
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${landed.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const metrics = (
      read.json() as {
        metrics: {
          measure: string;
          pov: string;
          derived: boolean;
          samples: number[];
          otherPov?: unknown;
        }[];
      }
    ).metrics;

    const latency = metrics.find(
      (metric) => metric.measure === "turn_response_latency",
    );
    expect(latency?.samples).toEqual([
      3791.523688, 1522.440064, 2215.852528, 1907.430984,
    ]);
    // The agent's own POV, and it is the headline: egma timed nothing here, so
    // there is no second series beside it either.
    expect(latency?.pov).toBe("agent");
    expect(latency?.derived).toBe(true);
    expect(latency?.otherPov).toBeUndefined();

    // And the first answer, from the moment the conversation opened to the
    // agent's first word: `agent_session` at 1788544385416091000, first
    // `agent_speaking` at 1788544388880227000.
    const first = metrics.find(
      (metric) => metric.measure === "first_response_latency",
    );
    expect(first?.samples).toEqual([3464.136]);
    expect(first?.pov).toBe("agent");
  });
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
  it("pulls its call record and files it under the simulation", async () => {
    const auth = contextFor(acme, "member");
    const created = await createAgent(auth, {
      agentPlatform: "retell",
      name: "Front desk retell",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_front_desk" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    const personaId = (
      await createPersona(auth, {
        name: "Impatient Rita retell",
        ...NEUTRAL_PERSON,
      })
    ).id;
    const suiteId = (await createTestSuite(auth, { name: "Weather retell" })).id;
    await createTest(auth, {
      suiteId,
      name: "Asks about the weather retell",
      scenario: "They want today's weather before they go out.",
      expectedBehaviors: ["gives the weather that was asked about"],
      personaIds: [personaId],
    });
    const reach = await resolveRunStartReach(auth, created.id, created.connection?.id ?? "");
    if (reach === undefined) throw new Error("the Retell connection has no reach");
    const started = await startRun(auth, {
      agentVersion: RETELL_CALL.agent_version,
      conductedConnectionIdentity: reach.connectionIdentity,
      suiteId,
      agentId: created.id,
      connectionId: created.connection?.id ?? "",
    });
    const page = await listSimulations(auth, started.id, { limit: 1 });
    const simulation = page?.items[0];
    if (simulation === undefined) throw new Error("the run has no simulation");
    const traceId = traceIdOfSimulation(simulation.id) ?? "";

    const [claimed] = await claimSimulations({
      claimant: CONDUCTOR,
      capacity: 1,
    });
    expect(claimed?.id).toBe(simulation.id);
    await startSimulation(auth, simulation.id, CONDUCTOR);

    /*
     * The persona's POV, filed **before** the agent's and opening **earlier**
     * than it.
     *
     * This is what makes the parentless-row ranking observable through the
     * contract. Retell's own root is the row carrying the reported-measurements
     * block, and under the reader's old rule — the earliest parentless row wins
     * — this egma root would have taken its place and the block would have gone
     * missing from a conversation Retell had measured. The ranking asks whether
     * a row carries the block first, so it does not.
     */
    const own = `${traceId.slice(0, 14)}01`;
    const before = new Date(CONVERSATION_STARTED_AT.getTime() - 30_000);
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
                  value: { stringValue: simulation.id },
                },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "egma-simulator", version: "1" },
                spans: [
                  {
                    traceId,
                    spanId: own,
                    parentSpanId: "",
                    name: "simulation",
                    kind: "SPAN_KIND_INTERNAL",
                    startTimeUnixNano: String(
                      BigInt(before.getTime()) * 1_000_000n,
                    ),
                    endTimeUnixNano: String(
                      BigInt(before.getTime() + 1000) * 1_000_000n,
                    ),
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

    // And the landing itself, through the door the simulator reports at.
    const landed = await api.app.inject({
      method: "POST",
      url: reportPathFor(simulation.id),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
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
              provider_reference: RETELL_CALL_ID,
            },
          },
        ],
      },
    });
    expect(landed.statusCode, landed.body).toBe(200);
    await api.drainEvidence();

    // Retell was asked for that one call, with the connection's own key.
    expect(
      askedOfRetell.some((one) =>
        one.includes(`/v2/get-call/${RETELL_CALL_ID}`),
      ),
    ).toBe(true);

    const rows = await store().rows<{
      source: string;
      emitter: string;
      run_id: string;
      provider_call_id: string;
      n: string;
    }>(
      `select source, emitter, run_id, provider_call_id, count() as n
       from spans final
       where trace_id = '${traceId}' and emitter = 'agent'
       group by source, emitter, run_id, provider_call_id`,
    );
    expect(rows).toHaveLength(1);
    const [only] = rows;
    // Filed under the simulation, as the agent's POV, with the pins — and the
    // call id kept, because that is what the two records are joined on.
    expect(only?.source).toBe("simulation");
    expect(only?.emitter).toBe("agent");
    expect(only?.run_id).toBe(started.id);
    expect(only?.provider_call_id).toBe(RETELL_CALL_ID);
    expect(Number(only?.n)).toBeGreaterThan(1);

    const toolNames = await store().rows<{ tool_name: string }>(
      `select tool_name from spans final
       where trace_id = '${traceId}' and kind = 'tool'`,
    );
    expect(toolNames.map((one) => one.tool_name)).toEqual(["lookup_weather"]);

    // Both POVs are here, and there are two parentless rows to choose between.
    const roots = await store().rows<{ emitter: string; span_id: string }>(
      `select emitter, span_id from spans final
       where trace_id = '${traceId}' and parent_span_id = ''
       order by started_at asc`,
    );
    expect(roots.map((root) => root.emitter)).toEqual(["egma-runtime", "agent"]);
    expect(roots[0]?.span_id).toBe(own);

    /*
     * **And the ranking picked the right one.**
     *
     * `reportedBy` on a measure is present only where the read found the
     * reported-measurements block, and that block rides Retell's root — the
     * *later* of the two parentless rows. So this one field is the whole proof:
     * the reader ranked the row carrying the block above the row that merely
     * opened first, and Retell's own measurements are still on the simulation.
     */
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${simulation.id}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const metrics = (
      read.json() as {
        metrics: { measure: string; reportedBy?: string; samples: number[] }[];
      }
    ).metrics;
    const reported = metrics.find(
      (metric) => metric.measure === "turn_response_latency",
    );
    expect(reported?.reportedBy).toBe("retell");
    expect(reported?.samples).toEqual([820, 910, 760]);

    /*
     * And the resend an at-least-once reporter makes does not pull again.
     *
     * The duplicate is absorbed and answers `completed`, exactly as the
     * landing it repeats did — so a door reading the status alone would ask
     * Retell a second time, minutes later, and Retell fills a call document in
     * after the call ends. That second reading would land as *changed* content
     * under the same deterministic span ids, which is the integrity error
     * ADR-0014 names rather than an update.
     */
    const askedSoFar = askedOfRetell.length;
    const again = await api.app.inject({
      method: "POST",
      url: reportPathFor(simulation.id),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: {
        contract_version: 1,
        simulation_id: simulation.id,
        events: [
          {
            kind: "status",
            event_id: "evt-000002",
            at: CONVERSATION_ENDED_AT.toISOString(),
            status: "completed",
            reason: null,
            facts: {
              ending: "agent_ended",
              started_at: CONVERSATION_STARTED_AT.toISOString(),
              ended_at: CONVERSATION_ENDED_AT.toISOString(),
              turn_count: 3,
              audio: null,
              provider_reference: RETELL_CALL_ID,
            },
          },
        ],
      },
    });
    // Absorbed, not refused: the record already says what the document says.
    expect(again.statusCode, again.body).toBe(200);
    expect(askedOfRetell).toHaveLength(askedSoFar);
  }, 120_000);

  async function runningCall(label: string, webCall = true) {
    const auth = contextFor(acme, "member");
    const created = await createAgent(auth, {
      agentPlatform: "retell",
      name: `Retell terminal ${label}`,
      connection: {
        agentPlatform: "retell",
        connectionType: webCall ? "retell_web_call" : "retell_chat_api",
        accessVariant: webCall ? "retell_web_call.api_key" : "retell_chat_api.api_key",
        modality: webCall ? "voice" : "chat",
        config: { retellAgentId: "agent_front_desk" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    const personaId = (await createPersona(auth, {
      name: `Retell terminal caller ${label}`, ...NEUTRAL_PERSON,
    })).id;
    const suiteId = (await createTestSuite(auth, { name: `Retell terminal ${label}` })).id;
    await createTest(auth, {
      suiteId, name: `Retell terminal question ${label}`,
      scenario: "Ask for the weather.", expectedBehaviors: ["Answers the question"],
      personaIds: [personaId],
    });
    const connectionId = created.connection?.id ?? "";
    const reach = await resolveRunStartReach(auth, created.id, connectionId);
    const started = await startRun(auth, {
      suiteId, agentId: created.id, connectionId, idempotencyKey: newId("run"),
      ...(reach === undefined ? {} : {
        agentVersion: RETELL_CALL.agent_version,
        conductedConnectionIdentity: reach.connectionIdentity,
      }),
    });
    const [claimed] = await claimSimulations({ claimant: CONDUCTOR, capacity: 1 });
    if (claimed === undefined) throw new Error("the run had no simulation");
    await startSimulation(auth, claimed.id, CONDUCTOR);
    return { auth, agentId: created.id, connectionId, runId: started.id, simulationId: claimed.id,
      traceId: traceIdOfSimulation(claimed.id) ?? "" };
  }

  function terminalReport(simulationId: string, status: "completed" | "failed" | "canceled", reference: string | null) {
    return {
      contract_version: 1, simulation_id: simulationId,
      events: [{ kind: "status", event_id: "evt-terminal", at: CONVERSATION_ENDED_AT.toISOString(),
        status, reason: status === "failed" ? "The media connection closed" : null,
        facts: {
          ending: status === "completed" ? "agent_ended" : status === "failed" ? "error" : "canceled",
          started_at: CONVERSATION_STARTED_AT.toISOString(), ended_at: CONVERSATION_ENDED_AT.toISOString(),
          turn_count: 3, audio: null, provider_reference: reference,
        },
      }],
    };
  }

  const terminalStatuses = ["completed", "failed", "canceled"] as const;
  it.each(terminalStatuses)("imports a %s web call once without changing its execution result", async (status) => {
    const running = await runningCall(status);
    const callId = `call_${running.simulationId}`;
    extraRetellCalls.set(callId, { ...RETELL_CALL, call_id: callId });
    if (status === "canceled") await cancelRun(running.auth, running.runId);
    const request = {
      method: "POST" as const, url: reportPathFor(running.simulationId),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: terminalReport(running.simulationId, status, callId),
    };
    const asksBefore = askedOfRetell.length;
    const landed = await api.app.inject(request);
    expect(landed.statusCode, landed.body).toBe(200);
    await api.drainEvidence();
    expect(askedOfRetell.slice(asksBefore)).toEqual([expect.stringContaining(`/v2/get-call/${callId}`)]);
    expect(await agentRowsUnder(running.traceId)).toBeGreaterThan(1);
    const read = await api.app.inject({ method: "GET", url: `/v1/simulations/${running.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ status, agentPovIncomplete: false });
    expect(read.json().transcript.toolSpanCount).toBe(1);
    if (status !== "completed") {
      const job = await getGradingJobForTrace(running.auth, running.traceId);
      expect(job).toBeUndefined();
    }
    const duplicate = await api.app.inject(request);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(askedOfRetell).toHaveLength(asksBefore + 1);
  });

  it.each(terminalStatuses)("does not fetch a %s web call without a provider reference", async (status) => {
    const running = await runningCall(`no-id-${status}`);
    if (status === "canceled") await cancelRun(running.auth, running.runId);
    const asksBefore = askedOfRetell.length;
    const landed = await api.app.inject({ method: "POST", url: reportPathFor(running.simulationId),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: terminalReport(running.simulationId, status, null),
    });
    expect(landed.statusCode, landed.body).toBe(200);
    expect(askedOfRetell).toHaveLength(asksBefore);
  });

  it.each(terminalStatuses)("marks a %s web call incomplete when Retell has no record", async (status) => {
    const running = await runningCall(`missing-${status}`);
    if (status === "canceled") await cancelRun(running.auth, running.runId);
    const landed = await api.app.inject({ method: "POST", url: reportPathFor(running.simulationId),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: terminalReport(running.simulationId, status, `missing_${running.simulationId}`),
    });
    expect(landed.statusCode, landed.body).toBe(200);
    const read = await api.app.inject({ method: "GET", url: `/v1/simulations/${running.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ status, agentPovIncomplete: true });
  });

  it("does not send a Retell chat ID to the web call endpoint", async () => {
    const running = await runningCall("native-chat", false);
    const asksBefore = askedOfRetell.length;
    const landed = await api.app.inject({ method: "POST", url: reportPathFor(running.simulationId),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: terminalReport(running.simulationId, "completed", "chat_native_reference"),
    });
    expect(landed.statusCode, landed.body).toBe(200);
    expect(askedOfRetell).toHaveLength(asksBefore);
  });

  it("keeps an explicitly incomplete provider record marked incomplete after it arrives", async () => {
    const running = await runningCall("partial-provider-record");
    const callId = `missing_${running.simulationId}`;
    const landed = await api.app.inject({ method: "POST", url: reportPathFor(running.simulationId),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: terminalReport(running.simulationId, "failed", callId),
    });
    expect(landed.statusCode, landed.body).toBe(200);
    const standing = await resolveSimulationStanding(running.simulationId);
    if (standing === undefined) throw new Error("the simulation has no standing");
    // Replay the already-stored shape of a partially readable provider document.
    // The read must preserve its completeness flag even though agent spans exist.
    const partial = normaliseRetellCall({ ...RETELL_CALL, call_id: callId,
      transcript_with_tool_calls: [...RETELL_CALL.transcript_with_tool_calls, "unreadable event"],
    }, {
      projectId: running.auth.projectId ?? "", environment: null,
      platformAgentId: RETELL_CALL.agent_id, platformAgentName: RETELL_CALL.agent_name,
      platformAgentVersion: String(RETELL_CALL.agent_version),
    }, Date.now());
    expect(partial.degraded).toBe(true);
    await fileSimulationEvidence([{ standing, emitter: "agent", spans: partial.spans }]);
    await api.drainEvidence();
    expect(await agentRowsUnder(running.traceId)).toBeGreaterThan(1);
    const read = await api.app.inject({ method: "GET", url: `/v1/simulations/${running.simulationId}`,
      headers: { authorization: `Bearer ${acmeKey}` } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ status: "failed", agentPovIncomplete: true });
  });

  /**
   * **A blip on the first attempt is what the retries are for.**
   *
   * Retell answering "not yet" and the socket failing are two different
   * things, and only the first arrives as an answer — a refused connection, a
   * DNS wobble or a timeout arrives as a throw. Both mean the same to this
   * simulation: no agent POV yet. So a throw on the first attempt has to fall
   * into the same bounded retries a thin document does, because the door's
   * completion resend deliberately starts no second pull — this is the only
   * pull this conversation will ever get, and losing it loses the transcript
   * and every tool call Retell holds for good.
   */
  it("retries a first attempt that threw, and files what the retry answers", async () => {
    const auth = contextFor(acme, "member");
    const created = await createAgent(auth, {
      agentPlatform: "retell",
      name: "Front desk retell blip",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_front_desk" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    const personaId = (
      await createPersona(auth, {
        name: "Impatient Rita blip",
        ...NEUTRAL_PERSON,
      })
    ).id;
    const suiteId = (await createTestSuite(auth, { name: "Weather blip" })).id;
    await createTest(auth, {
      suiteId,
      name: "Asks about the weather after a blip",
      scenario: "They want today's weather before they go out.",
      expectedBehaviors: ["gives the weather that was asked about"],
      personaIds: [personaId],
    });
    const reach = await resolveRunStartReach(auth, created.id, created.connection?.id ?? "");
    if (reach === undefined) throw new Error("the Retell connection has no reach");
    const started = await startRun(auth, {
      agentVersion: RETELL_CALL.agent_version,
      conductedConnectionIdentity: reach.connectionIdentity,
      suiteId,
      agentId: created.id,
      connectionId: created.connection?.id ?? "",
    });
    const page = await listSimulations(auth, started.id, { limit: 1 });
    const simulation = page?.items[0];
    if (simulation === undefined) throw new Error("the run has no simulation");
    const traceId = traceIdOfSimulation(simulation.id) ?? "";

    const [claimed] = await claimSimulations({
      claimant: CONDUCTOR,
      capacity: 1,
    });
    expect(claimed?.id).toBe(simulation.id);
    await startSimulation(auth, simulation.id, CONDUCTOR);

    // The landing names a call this deployment's own reach does not answer
    // for, so the door's pull files nothing and the whole of the agent's POV
    // is still owed when the retry below is the one asking.
    const blipCallId = "call_1a2b3c4d5e6f7a8b";
    const landed = await api.app.inject({
      method: "POST",
      url: reportPathFor(simulation.id),
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
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
              provider_reference: blipCallId,
            },
          },
        ],
      },
    });
    expect(landed.statusCode, landed.body).toBe(200);
    await api.drainEvidence();
    expect(await agentRowsUnder(traceId)).toBe(0);

    // The first ask throws the way a refused socket does; the second answers
    // the whole document.
    let asks = 0;
    const blippedReach = {
      fetchImpl: (async (input: unknown) => {
        asks += 1;
        if (asks === 1) throw new Error("connection refused");
        return new Response(
          JSON.stringify({ ...RETELL_CALL, call_id: blipCallId }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    };

    // The conducting context the report door holds when it starts a pull. A
    // connection's credential is unsealed for egma's own simulator and for
    // nothing else, so a member's session cannot ask for this.
    const standing = await resolveSimulationStanding(simulation.id);
    if (standing === undefined) throw new Error("the simulation has no standing");

    await pullRetellSimulationRecord(
      standing.auth,
      simulation.id,
      blippedReach,
      api.app.log,
      { retryWaitsMilliseconds: [1], sleep: async () => {} },
    );

    // The retry runs after the door has answered, so the record arrives a
    // moment later — but arrive it does, which before this it never did.
    const filed = await untilAgentRowsLand(traceId);
    expect(asks).toBe(2);
    expect(filed).toBeGreaterThan(1);

    const toolNames = await store().rows<{ tool_name: string }>(
      `select tool_name from spans final
       where trace_id = '${traceId}' and kind = 'tool'`,
    );
    expect(toolNames.map((one) => one.tool_name)).toEqual(["lookup_weather"]);
  }, 120_000);
});

/**
 * **The mark says isolated, so a lane that isolates nothing must not carry it.**
 *
 * A mocked mark is read at display time from the pinned test version by tool
 * name — and by the lane, which is the half the claim has always applied:
 * a simulation is mocked when its own test named a tool *and* the lane can
 * serve one. The phone lane deliberately serves none: the real carrier leg,
 * the real band, the real tools. So a test that pins `book_appointment` and
 * then runs over a phone number had that call answered by the customer's own
 * backend, and marking it `mocked` would tell a developer a real booking was
 * a rehearsal.
 *
 * Reachable because the filing step never inspects a simulation's lane: an
 * export naming this row's provider reference with a project key is filed
 * under it, whatever the standing or the lane.
 */
describe.skipIf(!storage.available)("a tool call on a lane that mocks nothing", () => {
  it("carries no mocked mark, though the pinned test names that tool", async () => {
    const auth = contextFor(acme, "member");
    const created = await createAgent(auth, {
      agentPlatform: "retell",
      name: "Reception line phone",
      connection: {
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
      } as never,
    });
    const personaId = (
      await createPersona(auth, { name: "Impatient Rita phone", ...NEUTRAL_PERSON })
    ).id;
    const suiteId = (await createTestSuite(auth, { name: "Booking phone" })).id;
    await createTest(auth, {
      suiteId,
      name: "Asks to book, over the phone",
      scenario: "They want an appointment on Tuesday.",
      expectedBehaviors: ["books the appointment that was asked for"],
      personaIds: [personaId],
      // The world the test author wrote down. The phone lane cannot serve it,
      // and that is exactly the disagreement this case is about.
      mockTools: [{ tool: "book_appointment", answer: { booked: true } }],
    });
    const started = await startRun(auth, {
      suiteId,
      agentId: created.id,
      connectionId: created.connection?.id ?? "",
    });
    const page = await listSimulations(auth, started.id, { limit: 1 });
    const simulation = page?.items[0];
    if (simulation === undefined) throw new Error("the run has no simulation");
    const traceId = traceIdOfSimulation(simulation.id) ?? "";

    const [claimed] = await claimSimulations({
      claimant: CONDUCTOR,
      capacity: 1,
    });
    expect(claimed?.id).toBe(simulation.id);
    await startSimulation(auth, simulation.id, CONDUCTOR);
    const reference = "phone-call-1a2b3c";
    await completeSimulation(auth, simulation.id, CONDUCTOR, {
      endingReason: "agent_ended",
      turnCount: 3,
      providerReference: reference,
      startedAt: CONVERSATION_STARTED_AT,
      endedAt: CONVERSATION_ENDED_AT,
    });

    // An agent POV naming this row, with the project's own key: one session
    // root and the one tool call the pinned world names.
    const at = (seconds: number): string =>
      String(
        BigInt(CONVERSATION_STARTED_AT.getTime() + seconds * 1000) * 1_000_000n,
      );
    const root = `${traceId.slice(0, 14)}a1`;
    const posted = await post(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: PROVIDER_REFERENCE_ATTRIBUTE,
                  value: { stringValue: reference },
                },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "livekit-agents", version: "1" },
                spans: [
                  {
                    traceId: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
                    spanId: root,
                    parentSpanId: "",
                    name: "agent_session",
                    kind: "SPAN_KIND_INTERNAL",
                    startTimeUnixNano: at(0),
                    endTimeUnixNano: at(60),
                    attributes: [],
                  },
                  {
                    traceId: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
                    spanId: `${traceId.slice(0, 14)}a2`,
                    parentSpanId: root,
                    name: "function_tool",
                    kind: "SPAN_KIND_INTERNAL",
                    startTimeUnixNano: at(2),
                    endTimeUnixNano: at(3),
                    attributes: [
                      {
                        key: "lk.function_tool.name",
                        value: { stringValue: "book_appointment" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      acmeKey,
    );
    expect(posted.statusCode, posted.body).toBe(200);
    await api.drainEvidence();

    const read = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${simulation.id}`,
      headers: { authorization: `Bearer ${acmeKey}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as {
      transcript: {
        readonly turns: DetailSpan[];
        readonly spans: DetailSpan[];
      } | null;
    };
    const transcript = body.transcript;
    if (transcript === null) throw new Error("the simulation has no transcript");

    const tools = everySpan([
      ...transcript.turns,
      ...transcript.spans,
    ]).filter((span) => span.kind === "tool");
    expect(tools.map((span) => [span.toolName, span.toolProvenance])).toEqual([
      ["book_appointment", undefined],
    ]);
  }, 120_000);
});

/** How many rows of the agent's own POV this trace holds. */
async function agentRowsUnder(traceId: string): Promise<number> {
  return countOf(
    `select count() as n from spans final
     where trace_id = '${traceId}' and emitter = 'agent'`,
  );
}

/**
 * Wait for a filing that happens after the call that started it returned.
 *
 * The pull answers on its first attempt and leaves the retries running behind
 * it, deliberately — the report door is not held open for Retell. So a test
 * about what a retry lands has to read the store until it is there, bounded so
 * a filing that never comes fails rather than hangs.
 */
async function untilAgentRowsLand(traceId: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await api.drainEvidence();
    const rows = await agentRowsUnder(traceId);
    if (rows > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 0;
}
