import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimSimulations,
  completeSimulation,
  connectClickHouse,
  createAgent,
  createPersona,
  createTest,
  disconnectClickHouse,
  startRun,
  startSimulation,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import {
  EXPORT_TRACE_SERVICE_REQUEST,
  EXPORT_TRACE_SERVICE_RESPONSE,
} from "../src/otlp/schema.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  mintKey,
  readTraceOverHttp,
  signUp,
  NEUTRAL_TRAITS,
  type Customer,
  type TraceDetailBody,
} from "./support/traces.ts";

/**
 * The simulator's spans, at the same door a customer's agent posts to.
 *
 * The service token opens the second path through the OTLP ingest: no customer
 * context at all, each resource naming the simulation its spans are evidence
 * of, and the door resolving the organization, the project and the run from
 * the simulation row — never from anything the payload claims. What is posted
 * here is the contract's own golden fixtures, byte for byte, because those
 * files are the meeting point with the emitter: if the door mis-files what
 * they carry, it would mis-file the simulator.
 *
 * The seeded simulations are real rows made by `startRun`, then renamed by raw
 * SQL to the ids the fixtures pin — the one edit no exported function offers,
 * made before anything references the row, so the golden bytes can post
 * unchanged against a database whose every other fact is genuine.
 */

const contractRoot = fileURLToPath(
  new URL("../../../packages/simulation-contract", import.meta.url),
);

async function fixture(expectation: string, name: string): Promise<string> {
  return readFile(
    path.join(contractRoot, "fixtures", "spans", expectation, name),
    "utf8",
  );
}

/** The ids the fixtures pin, and the trace each one derives. */
const CHAT_SIMULATION = "sim_01K3XQ7M4E8YB2FVN0H9TZQWER";
const CHAT_TRACE = "0198fb73d08e479627eea08a75fbf1d8";
const VOICE_SIMULATION = "sim_01K3XSW9GJ2Q4RD8VXH0MEKAFP";
const VOICE_TRACE = "0198fb9e261215c986a37d8828e9a9f6";
const MOCKED_SIMULATION = "sim_01K3XV2D6H9E4TBQZ7MKR0NFAC";
const MOCKED_TRACE = "0198fbb134d14b89a5dfe7a4f00abd4c";

/** What the test API's configuration holds, and the simulator would be started with. */
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

let api: TestApi;
let acme: Customer;
let globex: Customer;
let chatRunId: string;
let voiceRunId: string;
let acmeSeed: { agentId: string; testVersionId: string; personaVersionId: string };

function store(): NonNullable<TestApi["traceStore"]> {
  const traceStore = api.traceStore;
  if (traceStore === undefined) throw new Error("this API has no trace store");
  return traceStore;
}

async function countOf(query: string): Promise<number> {
  const [row] = await store().rows<{ n: string }>(query);
  return Number(row?.n ?? -1);
}

async function post(
  body: string | Buffer,
  token: string | null = SERVICE_TOKEN,
  contentType = "application/json",
) {
  return api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": contentType,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: body,
  });
}

/**
 * One conversation queued for a customer, its simulation renamed to the id a
 * fixture pins. The rename happens straight after the run starts, while no
 * other row references the simulation, so every foreign key keeps holding.
 */
async function seedSimulationNamed(
  person: Customer,
  label: string,
  fixtureId: string,
): Promise<{
  runId: string;
  agentId: string;
  testVersionId: string;
  personaVersionId: string;
}> {
  const auth = contextFor(person, "member");
  const created = await createAgent(auth, {
    name: `Front desk ${label}`,
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      traits: NEUTRAL_TRAITS,
    })
  ).id;
  const testVersionId = (
    await createTest(auth, {
      name: `Reschedules ${label}`,
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [personaId],
    })
  ).versionId;

  const started = await startRun(auth, {
    connectionId: created.connection?.id ?? "",
    testVersionIds: [testVersionId],
  });
  const simulation = started.simulations[0];
  if (simulation === undefined) throw new Error("the run has no simulation");

  await api.database.sql("update simulation set id = $1 where id = $2", [
    fixtureId,
    simulation.id,
  ]);

  return {
    runId: started.id,
    agentId: created.id,
    testVersionId,
    personaVersionId: simulation.personaVersionId,
  };
}

beforeAll(async () => {
  api = await createApi("otlp_simulation", { traceStore: true });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");

  const chat = await seedSimulationNamed(acme, "chat", CHAT_SIMULATION);
  chatRunId = chat.runId;
  acmeSeed = chat;
  const voice = await seedSimulationNamed(globex, "voice", VOICE_SIMULATION);
  voiceRunId = voice.runId;
  await seedSimulationNamed(acme, "mocked", MOCKED_SIMULATION);
});

afterAll(async () => {
  await api?.close();
});

describe("the contract's golden flushes, posted with the service token", () => {
  it("land under the simulation's own customer and run, marked as simulation traffic from egma's runtime", async () => {
    const flush = await post(await fixture("valid", "chat-flush-1-turns.json"));
    expect(flush.statusCode, flush.body).toBe(200);
    expect(flush.json()).toEqual({});

    const rows = await store().rows<{
      organization_id: string;
      project_id: string;
      source: string;
      emitter: string;
      run_id: string;
      agent_id: string;
      test_version_id: string;
      persona_version_id: string;
      environment: string;
    }>(
      "select distinct organization_id, project_id, source, emitter, run_id, " +
        "agent_id, test_version_id, persona_version_id, environment " +
        `from spans where trace_id = '${CHAT_TRACE}'`,
    );

    expect(rows).toEqual([
      {
        organization_id: acme.organizationId,
        project_id: acme.projectId,
        source: "simulation",
        emitter: "egma-runtime",
        run_id: chatRunId,
        agent_id: acmeSeed.agentId,
        test_version_id: acmeSeed.testVersionId,
        persona_version_id: acmeSeed.personaVersionId,
        environment: "default",
      },
    ]);
  });

  it("read as the conversation they carry: turns with their text, and the measure spans' durations being the measurements", async () => {
    const rows = await store().rows<{
      name: string;
      kind: string;
      text: string;
      duration_ns: number;
    }>(
      "select name, kind, text, duration_ns from spans " +
        `where trace_id = '${CHAT_TRACE}' order by started_at, name`,
    );

    expect(rows).toEqual([
      // The first-response measure brackets the quiet before the greeting, so
      // its duration is the measurement: 1214 milliseconds, in nanoseconds.
      {
        name: "first_response_latency",
        kind: "timing",
        text: "",
        duration_ns: 1_214_000_000,
      },
      {
        name: "agent_turn",
        kind: "turn:agent",
        text: "Thanks for reaching Lakeside Dental, how can I help today?",
        duration_ns: 0,
      },
      {
        name: "human_turn",
        kind: "turn:human",
        text: "Oh, hello — I'm so sorry, I need to move my cleaning. It's on Tuesday, I think? Could we do Thursday instead?",
        duration_ns: 0,
      },
    ]);

    // And the turn view already reads them, because the kinds are the store's
    // own turn vocabulary.
    expect(
      await countOf(
        `select count() as n from turns where trace_id = '${CHAT_TRACE}'`,
      ),
    ).toBe(2);
  });

  /**
   * Whatever its status. The chat simulation lands terminal here, and the
   * remaining flushes — the tool calls, the closing turn, the root — are still
   * accepted: with the ordered sender, spans trail the terminal document only
   * when something was retrying, and refusing them would punch the exact hole
   * in the record the retry existed to close.
   */
  it("keep landing after the simulation lands terminal", async () => {
    const claimant = "simulator-otlp-1";
    const claims = await claimSimulations({ claimant, capacity: 50 });
    const ours = claims.find((claim) => claim.id === CHAT_SIMULATION);
    if (ours === undefined) throw new Error("the claim missed the simulation");
    await startSimulation(ours.auth, CHAT_SIMULATION, claimant);
    await completeSimulation(ours.auth, CHAT_SIMULATION, claimant, {
      endingReason: "persona_concluded",
    });

    for (const name of ["chat-flush-2-tools.json", "chat-flush-3-root.json"]) {
      const landed = await post(await fixture("valid", name));
      expect(landed.statusCode, name).toBe(200);
    }

    const tools = await store().rows<{ tool_name: string; tool_arguments: string }>(
      "select tool_name, tool_arguments from spans " +
        `where trace_id = '${CHAT_TRACE}' and kind = 'tool' order by started_at`,
    );
    expect(tools).toEqual([
      {
        tool_name: "reschedule_appointment",
        tool_arguments:
          '{"appointment_id":"apt-88213","from":"2026-08-11T15:00:00Z","to":"2026-08-13T15:00:00Z"}',
      },
      // The platform reported the invocation and not its arguments, and an
      // absent fact stays absent.
      { tool_name: "send_confirmation_sms", tool_arguments: "" },
    ]);

    const [root] = await store().rows<{ kind: string; parent_span_id: string }>(
      `select kind, parent_span_id from spans where trace_id = '${CHAT_TRACE}' ` +
        "and name = 'simulation'",
    );
    expect(root).toEqual({ kind: "root", parent_span_id: "" });

    expect(
      await countOf(`select count() as n from spans where trace_id = '${CHAT_TRACE}'`),
    ).toBe(8);
  });

  /**
   * **The metrics display, end to end, from the emitter's own bytes.**
   *
   * The golden flushes go in at the door and come back out of the read endpoint
   * as numbers — computed by the one shared measure module, from exactly the
   * spans this trace holds, with nothing stored in between. That is the whole of
   * the claim the module exists for: the figure a page shows and the figure a
   * `latency` verdict rests on are one arithmetic, so the two can never
   * disagree about how fast the agent answered.
   *
   * Read with an ordinary customer key, at the endpoint the dashboard reads —
   * not through the module directly — because what is being asserted is that the
   * numbers reach a reader, not that a function returns them.
   */
  it("read back as the conversation's measures, at the endpoint a page reads", async () => {
    const key = await mintKey(api.app, acme.cookie, "reading the measures");

    // The day the golden flushes are stamped with — the store is filed by time,
    // so a read names the window the conversation happened in.
    const answer = await readTraceOverHttp(api.app, key, CHAT_TRACE, {
      from: "2026-08-05T00:00:00Z",
      to: "2026-08-06T00:00:00Z",
    });
    expect(answer.statusCode, answer.body).toBe(200);

    const detail = answer.json() as TraceDetailBody;

    // Two measures on this conversation, in the catalog's own order, each
    // sample a timing span's own duration in milliseconds — including the
    // 862.5, which a whole-number division would have floored away.
    expect(
      detail.measures.map(({ measure, unit, samples }) => ({
        measure,
        unit,
        samples,
      })),
    ).toEqual([
      {
        measure: "first_response_latency",
        unit: "milliseconds",
        samples: [1_214],
      },
      {
        measure: "turn_response_latency",
        unit: "milliseconds",
        samples: [862.5],
      },
    ]);

    // And each sample names the span it came off, so a reader can open the one
    // measurement a judgment was about.
    for (const measured of detail.measures) {
      expect(measured.span_ids).toHaveLength(measured.samples.length);
      for (const spanId of measured.span_ids) expect(spanId).not.toBe("");
    }
  });

  /**
   * The dedup round trip at the door: the simulator's sender resends a flush
   * byte-identically until acknowledged, and an acknowledgement it never heard
   * makes the resend ordinary. Each flush is one insert bearing a token
   * derived from its writer-minted ids, so the replay lands nothing.
   */
  it("land nothing twice when every flush is sent again", async () => {
    const before = await countOf(
      `select count() as n from spans where trace_id = '${CHAT_TRACE}'`,
    );
    const turnsBefore = await countOf(
      `select count() as n from turns where trace_id = '${CHAT_TRACE}'`,
    );
    expect(before).toBe(8);

    for (const name of [
      "chat-flush-1-turns.json",
      "chat-flush-2-tools.json",
      "chat-flush-3-root.json",
    ]) {
      const again = await post(await fixture("valid", name));
      expect(again.statusCode, name).toBe(200);
    }

    expect(
      await countOf(`select count() as n from spans where trace_id = '${CHAT_TRACE}'`),
    ).toBe(before);
    expect(
      await countOf(`select count() as n from turns where trace_id = '${CHAT_TRACE}'`),
    ).toBe(turnsBefore);
  });

  it("file another customer's simulation under that customer, resolved through the same tokenless asking", async () => {
    const landed = await post(await fixture("valid", "voice-overlapping-turns.json"));
    expect(landed.statusCode, landed.body).toBe(200);

    const rows = await store().rows<{
      organization_id: string;
      project_id: string;
      run_id: string;
      n: number;
    }>(
      "select organization_id, project_id, run_id, toUInt32(count()) as n " +
        `from spans where trace_id = '${VOICE_TRACE}' ` +
        "group by organization_id, project_id, run_id",
    );
    expect(rows).toEqual([
      {
        organization_id: globex.organizationId,
        project_id: globex.projectId,
        run_id: voiceRunId,
        n: 4,
      },
    ]);

    // The two turns genuinely overlap — the shape the vocabulary promises the
    // full-duplex persona — and both are stored as they were measured.
    const [overlap] = await store().rows<{ n: string }>(
      "select count() as n from spans as human, spans as agent " +
        `where human.trace_id = '${VOICE_TRACE}' and agent.trace_id = '${VOICE_TRACE}' ` +
        "and human.kind = 'turn:human' and agent.kind = 'turn:agent' " +
        "and human.started_at < agent.started_at + intDivOrZero(agent.duration_ns, 1000) / 1000000 " +
        "and agent.started_at < human.started_at + intDivOrZero(human.duration_ns, 1000) / 1000000",
    );
    expect(Number(overlap?.n)).toBe(1);
  });

  /**
   * The answer egma served, kept as an answer. The simulator authors it from
   * inside the exchange it conducted, so unlike the return values of a call
   * egma only watched go past, there is nothing invented in writing it down —
   * and the vocabulary only lets it be written beside the stamp saying where
   * it came from. The stamp, the mock tool that answered and the late-attached
   * flag have no columns of their own and are not given one: they ride the
   * payload whole, which is what makes lifting the queried fields out lose
   * nothing.
   */
  it("keep the answer a mock tool served, and everything that says where it came from", async () => {
    const landed = await post(await fixture("valid", "voice-mocked-tool-calls.json"));
    expect(landed.statusCode, landed.body).toBe(200);

    const rows = await store().rows<{
      tool_name: string;
      tool_arguments: string;
      tool_result: string;
      payload: string;
    }>(
      "select tool_name, tool_arguments, tool_result, payload from spans " +
        `where trace_id = '${MOCKED_TRACE}' and kind = 'tool' order by started_at`,
    );

    expect(
      rows.map((row) => [row.tool_name, row.tool_arguments, row.tool_result]),
    ).toEqual([
      [
        "check_calendar",
        '{"date":"2026-08-13","duration_minutes":30}',
        '{"slots":[]}',
      ],
      // A call served for a tool the agent had not reported having. Its
      // arguments never arrived, and an absent fact stays absent.
      ["send_confirmation_sms", "", '{"delivered":true}'],
      // A call egma would not answer: the arguments are what the agent tried
      // to do, and there is no result because nothing served it.
      ["charge_card", '{"amount_cents":4200}', ""],
    ]);

    expect(rows[0]?.payload).toContain('"egma.tool.provenance"');
    expect(rows[0]?.payload).toContain('"mocked"');
    expect(rows[1]?.payload).toContain('"egma.tool.late_attached"');
    expect(rows[1]?.payload).toContain('"boolValue":true');
    // The refusal's own stamp survives the door whole. Without it the row
    // would read exactly like a call egma was never in the path of, which is
    // the opposite fact about whether the agent's backend ran.
    expect(rows[2]?.payload).toContain('"refused"');
  });
});

/**
 * The fixture's spans as the protobuf encoding carries them: identical in
 * every field, with the three ids as the bytes the hex spells — which is the
 * one place the two encodings disagree, and exactly what the door's decoder
 * settles back to hex.
 */
function protobufBodyOf(fixtureJson: string): Buffer {
  const parsed = JSON.parse(fixtureJson) as {
    resourceSpans: {
      scopeSpans: {
        spans: {
          traceId?: string;
          spanId?: string;
          parentSpanId?: string;
        }[];
      }[];
    }[];
  };
  for (const resource of parsed.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      scope.spans = scope.spans.map((span) => ({
        ...span,
        traceId: Buffer.from(span.traceId ?? "", "hex"),
        spanId: Buffer.from(span.spanId ?? "", "hex"),
        ...(span.parentSpanId === undefined
          ? {}
          : { parentSpanId: Buffer.from(span.parentSpanId, "hex") }),
      })) as never;
    }
  }
  return Buffer.from(
    EXPORT_TRACE_SERVICE_REQUEST.encode(
      EXPORT_TRACE_SERVICE_REQUEST.fromObject(parsed),
    ).finish(),
  );
}

describe("the same path in the other encoding", () => {
  /**
   * The strongest form of the dedup question: the voice flush already landed
   * as JSON, and here it is again as protobuf — different bytes on the wire,
   * different payload column had it landed, the same writer-minted ids. The
   * token is derived from the ids, so the cross-encoding resend lands
   * nothing, which no content hash could have promised.
   */
  it("dedups a protobuf resend of a flush that landed as JSON, because identity is the ids", async () => {
    const before = await countOf(
      `select count() as n from spans where trace_id = '${VOICE_TRACE}'`,
    );
    expect(before).toBe(4);

    const resent = await post(
      protobufBodyOf(await fixture("valid", "voice-overlapping-turns.json")),
      SERVICE_TOKEN,
      "application/x-protobuf",
    );
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.headers["content-type"]).toContain("application/x-protobuf");
    expect(
      EXPORT_TRACE_SERVICE_RESPONSE.toObject(
        EXPORT_TRACE_SERVICE_RESPONSE.decode(resent.rawPayload),
        { defaults: false },
      ),
    ).toEqual({});

    expect(
      await countOf(
        `select count() as n from spans where trace_id = '${VOICE_TRACE}'`,
      ),
    ).toBe(before);
  });

  it("lands a genuinely new protobuf flush, attributed exactly as the JSON ones", async () => {
    const late = JSON.parse(
      await fixture("valid", "voice-overlapping-turns.json"),
    ) as {
      resourceSpans: {
        scopeSpans: { spans: Record<string, unknown>[] }[];
      }[];
    };
    const scope = late.resourceSpans[0]?.scopeSpans[0];
    if (scope === undefined) throw new Error("the fixture is empty");
    scope.spans = [
      {
        traceId: VOICE_TRACE,
        spanId: "bb20000000000006",
        parentSpanId: "bb20000000000001",
        name: "time_to_first_word",
        kind: "SPAN_KIND_INTERNAL",
        startTimeUnixNano: "1785924902100000000",
        endTimeUnixNano: "1785924902950000000",
      },
    ];

    const landed = await post(
      protobufBodyOf(JSON.stringify(late)),
      SERVICE_TOKEN,
      "application/x-protobuf",
    );
    expect(landed.statusCode).toBe(200);

    const rows = await store().rows<{
      kind: string;
      duration_ns: number;
      run_id: string;
      source: string;
    }>(
      "select kind, duration_ns, run_id, source from spans " +
        `where trace_id = '${VOICE_TRACE}' and span_id = 'bb20000000000006'`,
    );
    expect(rows).toEqual([
      {
        kind: "timing",
        duration_ns: 850_000_000,
        run_id: voiceRunId,
        source: "simulation",
      },
    ]);
  });
});

describe("a resource that names no simulation, or one egma never conducted", () => {
  it("is refused whole, with a body saying what to send", async () => {
    const before = await countOf("select count() as n from spans");

    const unnamed = await post(
      await fixture("invalid", "resource-naming-no-simulation.json"),
    );
    expect(unnamed.statusCode).toBe(400);
    const refusal = unnamed.json() as { code: number; message: string };
    expect(refusal.message).toContain("egma.simulation_id");

    expect(await countOf("select count() as n from spans")).toBe(before);
  });

  it("is refused by name when the simulation never existed, and stores nothing", async () => {
    const invented = newId("sim");
    const body = (
      await fixture("valid", "chat-flush-1-turns.json")
    ).replaceAll(CHAT_SIMULATION, invented);

    const before = await countOf("select count() as n from spans");
    const refused = await post(body);
    expect(refused.statusCode).toBe(400);
    const refusal = refused.json() as { code: number; message: string };
    expect(refusal.message).toContain(invented);

    expect(await countOf("select count() as n from spans")).toBe(before);
  });

  /**
   * A resource naming one simulation while filing its spans under another
   * simulation's trace.
   *
   * **This is the check that stops a transcript playing the wrong
   * conversation's audio.** The two identifiers are the same 128 bits written
   * two ways, and both directions are read: a reader opening a transcript
   * converts the trace id back into a simulation id to find that conversation's
   * verdicts and its recording. So spans filed under somebody else's trace put
   * one conversation's turns on screen beside another's audio — inside one
   * organization, with nothing anywhere saying the two disagree.
   *
   * Nothing egma ships can produce it: the simulator derives the trace from the
   * id it was handed. Which is why it is asserted rather than assumed — the
   * emitter taking a trace id from a provider instead would be a small change
   * over there and a wrong recording over here.
   */
  it("is refused whole when its spans are filed under another simulation's trace", async () => {
    const body = (
      await fixture("valid", "chat-flush-1-turns.json")
    ).replaceAll(CHAT_TRACE, VOICE_TRACE);

    const before = await countOf("select count() as n from spans");
    const refused = await post(body);

    expect(refused.statusCode, refused.body).toBe(400);
    const refusal = refused.json() as { code: number; message: string };
    expect(refusal.message).toContain(CHAT_SIMULATION);
    expect(refusal.message).toContain(VOICE_TRACE);
    expect(refusal.message).toContain(CHAT_TRACE);

    expect(await countOf("select count() as n from spans")).toBe(before);
  });
});

describe("a payload that claims a tenant on the service path", () => {
  it("is stored verbatim and decides nothing: the customer comes from the simulation row", async () => {
    const claimed = JSON.parse(
      await fixture("valid", "chat-flush-1-turns.json"),
    ) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: unknown }[] };
        scopeSpans: { spans: Record<string, unknown>[] }[];
      }[];
    };
    const resource = claimed.resourceSpans[0];
    if (resource === undefined) throw new Error("the fixture is empty");
    resource.resource.attributes.push(
      { key: "organization_id", value: { stringValue: globex.organizationId } },
      { key: "egma.organization_id", value: { stringValue: globex.organizationId } },
      { key: "project_id", value: { stringValue: globex.projectId } },
    );
    // Its own span ids, so this lands beside the golden flush instead of
    // being dropped as its resend.
    const spans = resource.scopeSpans[0]?.spans ?? [];
    for (const [index, span] of spans.entries()) {
      span.spanId = `dd4000000000000${index}`;
    }

    const landed = await post(JSON.stringify(claimed));
    expect(landed.statusCode).toBe(200);

    const rows = await store().rows<{
      organization_id: string;
      project_id: string;
      payload: string;
    }>(
      "select organization_id, project_id, payload from spans " +
        `where trace_id = '${CHAT_TRACE}' and span_id = 'dd40000000000000'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(acme.organizationId);
    expect(rows[0]?.project_id).toBe(acme.projectId);
    // Not obeyed, and not thrown away either: it is somebody's data.
    expect(rows[0]?.payload).toContain(globex.organizationId);
  });
});

describe("a batch carrying two customers' evidence when the store refuses one of them", () => {
  /** One turn for each simulation, on span ids nothing else in this file mints. */
  function twoTenantBatch(): string {
    const turn = (
      simulationId: string,
      traceId: string,
      spanId: string,
    ): Record<string, unknown> => ({
      resource: {
        attributes: [
          { key: "egma.simulation_id", value: { stringValue: simulationId } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "egma-simulator", version: "1" },
          spans: [
            {
              traceId,
              spanId,
              name: "agent_turn",
              startTimeUnixNano: "1785920401214000000",
              endTimeUnixNano: "1785920401214000000",
              attributes: [
                {
                  key: "egma.turn.text",
                  value: { stringValue: "Said while the store was fussy." },
                },
              ],
            },
          ],
        },
      ],
    });

    // The refusing tenant deliberately first: a door that stopped at the first
    // refusal would never reach the second tenant at all, and this batch is
    // shaped to catch exactly that.
    return JSON.stringify({
      resourceSpans: [
        turn(VOICE_SIMULATION, VOICE_TRACE, "ff60000000000001"),
        turn(CHAT_SIMULATION, CHAT_TRACE, "ff60000000000002"),
      ],
    });
  }

  /**
   * One customer's refused rows cost exactly that customer's spans — the
   * other group still lands, and the answer counts as rejected only what was
   * genuinely not stored. Nothing that landed is reported rejected: the
   * sender's write-ahead log believes this count, and a landed span reported
   * rejected would be evidence the sender stops owing.
   */
  it("lands the other customer's group, and counts only the refused one rejected", async () => {
    await store().command(
      "alter table spans add constraint refuses_globex check " +
        `organization_id != '${globex.organizationId}'`,
    );

    try {
      const response = await post(twoTenantBatch());

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        partialSuccess: {
          rejectedSpans: "1",
          errorMessage: expect.stringContaining("the trace store refused"),
        },
      });
    } finally {
      await store().command("alter table spans drop constraint refuses_globex");
    }

    // The tenant the store refused lost its span, and only it.
    expect(
      await countOf(
        "select count() as n from spans where span_id = 'ff60000000000001'",
      ),
    ).toBe(0);
    const landed = await store().rows<{ organization_id: string; text: string }>(
      "select organization_id, text from spans where span_id = 'ff60000000000002'",
    );
    expect(landed).toEqual([
      {
        organization_id: acme.organizationId,
        text: "Said while the store was fussy.",
      },
    ]);
  });

  /**
   * The other kind of store trouble stays the error it is: rows a minute of
   * patience would land must reach the sender as a retry, never as a
   * rejection its write-ahead log would believe forever. The resend is safe
   * on the groups that landed before the fault — identical flushes carry
   * identical dedup tokens.
   */
  it("still answers a store that merely failed as an error the sender will retry", async () => {
    await disconnectClickHouse();
    try {
      const response = await post(twoTenantBatch());
      expect(response.statusCode).toBe(500);
    } finally {
      connectClickHouse({ clickhouseUrl: store().url, maxOpenConnections: 4 });
    }

    // And the same document goes through whole once the store is back.
    const retried = await post(twoTenantBatch());
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual({});
    expect(
      await countOf(
        "select count() as n from spans where span_id in " +
          "('ff60000000000001', 'ff60000000000002')",
      ),
    ).toBe(2);
  });
});

describe("the customer-key path, beside it", () => {
  /**
   * The naming attribute belongs to the service path alone. A customer's
   * exporter is free to send it — nothing about a customer request is refused
   * for it — and it decides nothing: tenancy still comes from the key, the
   * rows are still production traffic, and no run is pinned.
   */
  it("ignores egma.simulation_id: the key names the customer, and the rows stay production", async () => {
    const traceId = "eeee5555eeee5555eeee5555eeee5555";
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "egma.simulation_id",
                value: { stringValue: CHAT_SIMULATION },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "egma-simulator", version: "1" },
              spans: [
                {
                  traceId,
                  spanId: "ee50000000000001",
                  name: "agent_turn",
                  startTimeUnixNano: "1785920401214000000",
                  endTimeUnixNano: "1785920401214000000",
                  attributes: [
                    {
                      key: "egma.turn.text",
                      value: { stringValue: "Said over a customer's key." },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const landed = await post(body, globex.secret);
    expect(landed.statusCode, landed.body).toBe(200);

    const rows = await store().rows<{
      organization_id: string;
      project_id: string;
      source: string;
      emitter: string;
      run_id: string;
      kind: string;
      payload: string;
    }>(
      "select organization_id, project_id, source, emitter, run_id, kind, " +
        `payload from spans where trace_id = '${traceId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Globex's key, so Globex's rows — not the Acme simulation the payload
      // names, and not simulation traffic.
      organization_id: globex.organizationId,
      project_id: "default",
      source: "production",
      emitter: "agent",
      run_id: "",
      // The scope still gates the vocabulary, whoever posts it: the span
      // reads as a turn either way.
      kind: "turn:agent",
    });
    expect(rows[0]?.payload).toContain("egma.simulation_id");
  });

  it("refuses a stale service secret in the service's own vocabulary, not with advice about signing in", async () => {
    const wrongSecret = await post(
      await fixture("valid", "chat-flush-1-turns.json"),
      "egma_st_not-the-configured-value-at-all",
    );
    expect(wrongSecret.statusCode).toBe(401);
    const refusal = wrongSecret.json() as { error: string; message: string };
    expect(refusal.error).toBe("not_authenticated");
    // The reader is a simulator's log, and the fix is the token — the prefix
    // already says this was never a customer key.
    expect(refusal.message).toContain("EGMA_SIMULATOR_SERVICE_TOKEN");
  });
});

describe("what the service path leaves alone", () => {
  /**
   * A simulation's grading work is minted by the transaction that lands it
   * terminal, so the door writes no queue row for simulation spans — one had
   * already been minted when the chat simulation completed, and a second
   * would be the double-judging the landing guards against.
   */
  it("mints no grading work from a simulation's spans", async () => {
    const jobs = await api.database.sql<{ n: string }>(
      "select count(*) as n from grading_job where trace_id = $1",
      [CHAT_TRACE],
    );
    expect(Number(jobs.rows[0]?.n)).toBe(0);
  });
});
