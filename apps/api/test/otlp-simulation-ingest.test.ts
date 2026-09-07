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
  createTestSuite,
  disconnectClickHouse,
  listSimulations,
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
import { pendingObjectStore } from "../src/ingestion/object-store.ts";
import { pendingSegments } from "./support/ingestion.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  contextFor,
  mintKey,
  readTraceOverHttp,
  signUp,
  NEUTRAL_PERSON,
  type Customer,
  type TraceDetailBody,
} from "./support/traces.ts";

/**
 * Post simulation-contract fixtures with the service token and derive tenancy
 * from stored simulation rows. Seed with startRun, then assign fixture IDs
 * through SQL before adding references. Drain before query assertions; inspect
 * pending objects directly for multi-project acceptance boundaries.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-simulation");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the simulation ingest suite — ${storage.why}\n\n`,
  );
}

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
const USAGE_SIMULATION = "sim_01M1X7VHHXE2AA4P7F7JEWPK8Z";
const USAGE_TRACE = "01a07a7dc63d7094a258ef3c9dcb4d1f";

/** What the test API's configuration holds, and the simulator would be started with. */
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

let api: TestApi;
let acme: Customer;
let globex: Customer;
let chatRunId: string;
let voiceRunId: string;
let usageRunId: string;
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
  const response = await stage(body, token, contentType);
  await api.drainEvidence();
  return response;
}

/** The same post, stopping where the door does: durable and not yet drained. */
async function stage(
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

/** The ingestion bucket this instance accepts into, for reading it back. */
function ingestStore() {
  if (!storage.available) throw new Error("this suite has no object store");
  return storage.ingestStore;
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
    agentPlatform: "retell",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      ...NEUTRAL_PERSON,
    })
  ).id;
  const suiteId = (
    await createTestSuite(auth, { name: `Regression ${label}` })
  ).id;
  const testVersionId = (
    await createTest(auth, {
      suiteId,
      name: `Reschedules ${label}`,
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [personaId],
    })
  ).versionId;

  const started = await startRun(auth, {
    suiteId,
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
  });
  const page = await listSimulations(auth, started.id, { limit: 1 });
  const simulation = page?.items[0];
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
  if (!storage.available) return;
  api = await createApi("otlp_simulation", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");

  const chat = await seedSimulationNamed(acme, "chat", CHAT_SIMULATION);
  chatRunId = chat.runId;
  acmeSeed = chat;
  const voice = await seedSimulationNamed(globex, "voice", VOICE_SIMULATION);
  voiceRunId = voice.runId;
  usageRunId = (
    await seedSimulationNamed(globex, "usage", USAGE_SIMULATION)
  ).runId;
});

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("the contract's golden flushes, posted with the service token", () => {
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
        `from spans final where trace_id = '${CHAT_TRACE}'`,
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
      "select name, kind, text, duration_ns from spans final " +
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
        `select count() as n from turns final where trace_id = '${CHAT_TRACE}'`,
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

    // The calls the platform reported, as the lane that serves egma's answers
    // itself puts them on the record. There is no stamp saying who answered:
    // whether a mock tool did is read at display time, by name, from the
    // pinned test version's mock tools.
    const tools = await store().rows<{
      tool_name: string;
      tool_arguments: string;
      tool_result: string;
    }>(
      "select tool_name, tool_arguments, tool_result from spans final " +
        `where trace_id = '${CHAT_TRACE}' and kind = 'tool' order by started_at`,
    );
    expect(tools).toEqual([
      {
        tool_name: "reschedule_appointment",
        tool_arguments:
          '{"appointment_id":"apt-88213","from":"2026-08-11T15:00:00Z","to":"2026-08-13T15:00:00Z"}',
        // A tool this simulation covers, so egma authored the answer.
        tool_result: '{"moved":true}',
      },
      // The platform reported the invocation and not its arguments, and a
      // tool nothing covers has no answer of egma's to record.
      { tool_name: "send_confirmation_sms", tool_arguments: "", tool_result: "" },
    ]);

    const [root] = await store().rows<{ kind: string; parent_span_id: string }>(
      `select kind, parent_span_id from spans final where trace_id = '${CHAT_TRACE}' ` +
        "and name = 'simulation'",
    );
    expect(root).toEqual({ kind: "root", parent_span_id: "" });

    expect(
      await countOf(`select count() as n from spans final where trace_id = '${CHAT_TRACE}'`),
    ).toBe(8);
  });

  /**
   * Read shared measures through the public endpoint after ingesting golden
   * simulation exports, to verify that derived values reach API consumers.
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
      detail.metrics.map(({ measure, unit, samples }) => ({
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

    /**
     * **And the reduction rides with them.** The average the pages lead with
     * is worked out by the platform, rounded once, beside the series it came
     * from, so that no reader has to reduce anything: a client averaging the
     * samples for itself would be a second implementation of exactly the
     * figure the pages lead with, right until the rounding changed under one
     * of them.
     */
    for (const measured of detail.metrics) {
      expect(measured.spanIds).toHaveLength(measured.samples.length);
      for (const spanId of measured.spanIds) expect(spanId).not.toBe("");

      expect(measured.mean).toBe(
        Math.round(
          measured.samples.reduce((sum, one) => sum + one, 0) /
            measured.samples.length,
        ),
      );
      // A whole reading, so the figure is the exchange's rather than a prefix's.
      expect(measured.partial).toBe(false);
    }
  });

  /**
   * The dedup round trip at the door: the simulator's sender resends a flush
   * byte-identically until acknowledged, and an acknowledgement it never heard
   * makes the resend ordinary. Deterministic block construction gives
   * ClickHouse the same recent block again, so this exact replay lands nothing.
   */
  it("land nothing twice when every flush is sent again", async () => {
    const before = await countOf(
      `select count() as n from spans final where trace_id = '${CHAT_TRACE}'`,
    );
    const turnsBefore = await countOf(
      `select count() as n from turns final where trace_id = '${CHAT_TRACE}'`,
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
      await countOf(`select count() as n from spans final where trace_id = '${CHAT_TRACE}'`),
    ).toBe(before);
    expect(
      await countOf(`select count() as n from turns final where trace_id = '${CHAT_TRACE}'`),
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
        `from spans final where trace_id = '${VOICE_TRACE}' ` +
        "group by organization_id, project_id, run_id",
    );
    expect(rows).toEqual([
      {
        organization_id: globex.organizationId,
        project_id: globex.projectId,
        run_id: voiceRunId,
        // Two turns and the agent's speech duration beside them. The persona's
        // own speech duration left the catalog with version 8, and the golden
        // fixture with it.
        n: 3,
      },
    ]);

    // The two turns genuinely overlap — the shape the vocabulary promises the
    // full-duplex persona — and both are stored as they were measured.
    const [overlap] = await store().rows<{ n: string }>(
      "select count() as n from spans as human final, spans as agent final " +
        `where human.trace_id = '${VOICE_TRACE}' and agent.trace_id = '${VOICE_TRACE}' ` +
        "and human.kind = 'turn:human' and agent.kind = 'turn:agent' " +
        "and human.started_at < agent.started_at + intDivOrZero(agent.duration_ns, 1000) / 1000000 " +
        "and agent.started_at < human.started_at + intDivOrZero(human.duration_ns, 1000) / 1000000",
    );
    expect(Number(overlap?.n)).toBe(1);
  });
});

/**
 * The fixture's spans as the protobuf encoding carries them: identical in
 * every field, with identity fields as the bytes their hex spells — which is
 * the one place the two encodings disagree, and exactly what the door's decoder
 * settles back to hex for spans and links.
 */
function protobufBodyOf(fixtureJson: string): Buffer {
  const parsed = JSON.parse(fixtureJson) as {
    resourceSpans: {
      scopeSpans: {
        spans: {
          traceId?: string;
          spanId?: string;
          parentSpanId?: string;
          links?: { traceId?: string; spanId?: string }[];
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
        ...(span.links === undefined
          ? {}
          : {
              links: span.links.map((link) => ({
                ...link,
                traceId: Buffer.from(link.traceId ?? "", "hex"),
                spanId: Buffer.from(link.spanId ?? "", "hex"),
              })),
            }),
      })) as never;
    }
  }
  return Buffer.from(
    EXPORT_TRACE_SERVICE_REQUEST.encode(
      EXPORT_TRACE_SERVICE_REQUEST.fromObject(parsed),
    ).finish(),
  );
}

describe.skipIf(!storage.available)("the same path in the other encoding", () => {
  /**
   * The object the conflict case leaves behind. Retention is the point, so it
   * is removed the way an operator removes one — deliberately, and only once
   * what it proves has been proved.
   */
  let conflicting = "";

  afterAll(async () => {
    if (storage.available && conflicting !== "") {
      await pendingObjectStore(ingestStore()).delete(conflicting);
    }
  });

  /**
   * Accept conflicting evidence durably, then refuse the conflicting write during
   * drain. Preserve both the original stored span and the pending object so the
   * conflict does not silently replace or discard evidence.
   */
  it("keeps the stored account and retains the object when protobuf evidence reuses span ids", async () => {
    const before = await countOf(
      `select count() as n from spans final where trace_id = '${VOICE_TRACE}'`,
    );
    const turnsBefore = await countOf(
      `select count() as n from turns final where trace_id = '${VOICE_TRACE}'`,
    );
    expect(before).toBe(3);
    expect(turnsBefore).toBe(2);

    const changed = JSON.parse(
      await fixture("valid", "voice-overlapping-turns.json"),
    ) as {
      resourceSpans: {
        scopeSpans: {
          spans: ({ attributes?: unknown[] } & Record<string, unknown>)[];
        }[];
      }[];
    };
    const richSpan = changed.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    if (richSpan === undefined) throw new Error("the fixture is empty");
    richSpan.attributes?.push({
      key: "pipecat.changed",
      value: { stringValue: "retained" },
    });

    const resent = await stage(
      protobufBodyOf(JSON.stringify(changed)),
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

    // The drain writes nothing for this object and leaves it where it is.
    expect(await api.drainEvidence()).toBe(0);
    const retained = await pendingSegments(ingestStore());
    expect(retained).toHaveLength(1);
    conflicting = retained[0]?.key ?? "";
    expect(conflicting).not.toBe("");

    expect(
      await countOf(
        `select count() as n from spans final where trace_id = '${VOICE_TRACE}'`,
      ),
    ).toBe(before);
    // And the derived view holds one turn per identity too — a materialized
    // view may process one replay more than once, and a reader must not see
    // that.
    expect(
      await countOf(
        `select count() as n from turns final where trace_id = '${VOICE_TRACE}'`,
      ),
    ).toBe(turnsBefore);
    expect(
      await countOf(
        "select count() as n from turns final " +
          `where trace_id = '${VOICE_TRACE}' and span_id = 'bb20000000000002'`,
      ),
    ).toBe(1);

    // The stored account is untouched: the attribute the resend added is
    // nowhere in it.
    const [stored] = await store().rows<{ payload: string }>(
      "select payload from spans final " +
        `where trace_id = '${VOICE_TRACE}' and span_id = 'bb20000000000002'`,
    );
    expect(stored?.payload).not.toContain("pipecat.changed");
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
        name: "turn_response_latency",
        kind: "SPAN_KIND_INTERNAL",
        startTimeUnixNano: "1785924902100000000",
        endTimeUnixNano: "1785924902950000000",
        status: {
          code: "STATUS_CODE_ERROR",
          message: "native status",
        },
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
      status: string;
      payload: string;
    }>(
      "select kind, duration_ns, run_id, source, status, payload from spans final " +
        `where trace_id = '${VOICE_TRACE}' and span_id = 'bb20000000000006'`,
    );
    const [row] = rows;
    expect(row).toMatchObject({
      kind: "timing",
      duration_ns: 850_000_000,
      run_id: voiceRunId,
      source: "simulation",
      status: "error",
    });
    const raw = JSON.parse(row?.payload ?? "{}") as {
      span?: Record<string, unknown>;
    };
    expect(raw.span?.status).toEqual({
      code: "STATUS_CODE_ERROR",
      message: "native status",
    });
  });
});

describe.skipIf(!storage.available)("a resource that names no simulation, or one egma never conducted", () => {
  it("is refused whole, with a body saying what to send", async () => {
    const before = await countOf("select count() as n from spans final");

    const unnamed = await post(
      await fixture("invalid", "resource-naming-no-simulation.json"),
    );
    expect(unnamed.statusCode).toBe(400);
    const refusal = unnamed.json() as { code: number; message: string };
    expect(refusal.message).toContain("egma.simulation_id");

    expect(await countOf("select count() as n from spans final")).toBe(before);
  });

  it("is refused by name when the simulation never existed, and stores nothing", async () => {
    const invented = newId("sim");
    const body = (
      await fixture("valid", "chat-flush-1-turns.json")
    ).replaceAll(CHAT_SIMULATION, invented);

    const before = await countOf("select count() as n from spans final");
    const refused = await post(body);
    expect(refused.statusCode).toBe(400);
    const refusal = refused.json() as { code: number; message: string };
    expect(refusal.message).toContain(invented);

    expect(await countOf("select count() as n from spans final")).toBe(before);
  });

  /**
   * Reject a resource whose valid trace ID belongs to a different simulation.
   * The trace/simulation mapping also resolves grades and recordings.
   */
  it("is refused whole when its spans are filed under another simulation's trace", async () => {
    const body = (
      await fixture("valid", "chat-flush-1-turns.json")
    ).replaceAll(CHAT_TRACE, VOICE_TRACE);

    const before = await countOf("select count() as n from spans final");
    const refused = await post(body);

    expect(refused.statusCode, refused.body).toBe(400);
    const refusal = refused.json() as { code: number; message: string };
    expect(refusal.message).toContain(CHAT_SIMULATION);
    expect(refusal.message).toContain(VOICE_TRACE);
    expect(refusal.message).toContain(CHAT_TRACE);

    expect(await countOf("select count() as n from spans final")).toBe(before);
  });
});

describe.skipIf(!storage.available)("a payload that claims a tenant on the service path", () => {
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
      "select organization_id, project_id, payload from spans final " +
        `where trace_id = '${CHAT_TRACE}' and span_id = 'dd40000000000000'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(acme.organizationId);
    expect(rows[0]?.project_id).toBe(acme.projectId);
    // Not obeyed, and not thrown away either: it is somebody's data.
    expect(rows[0]?.payload).toContain(globex.organizationId);
  });
});

describe.skipIf(!storage.available)("a batch carrying two customers' evidence", () => {
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

    // Globex's resource first, so that a door which stopped grouping at the
    // first project would never reach Acme's at all.
    return JSON.stringify({
      resourceSpans: [
        turn(VOICE_SIMULATION, VOICE_TRACE, "ff60000000000001"),
        turn(CHAT_SIMULATION, CHAT_TRACE, "ff60000000000002"),
      ],
    });
  }

  /**
   * A service-token export spanning projects must create separate segments and
   * wait for all uploads before success. Build this case explicitly because the
   * simulator normally sends one trace per reporter.
   */
  it("seals one segment for each project and answers only when both are durable", async () => {
    const response = await stage(twoTenantBatch());
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({});

    // The request has been answered, so both projects' evidence is durable —
    // in two objects, each naming one project and holding only its records.
    const pending = await pendingSegments(ingestStore());
    expect(pending).toHaveLength(2);

    const byProject = new Map(
      pending.map((segment) => [segment.header.project_id, segment]),
    );
    expect([...byProject.keys()].sort()).toEqual(
      [acme.projectId, globex.projectId].sort(),
    );

    const acmeSegment = byProject.get(acme.projectId);
    expect(acmeSegment?.header.organization_id).toBe(acme.organizationId);
    expect(acmeSegment?.records.map((record) => record.span_id)).toEqual([
      "ff60000000000002",
    ]);

    const globexSegment = byProject.get(globex.projectId);
    expect(globexSegment?.header.organization_id).toBe(globex.organizationId);
    expect(globexSegment?.records.map((record) => record.span_id)).toEqual([
      "ff60000000000001",
    ]);

    expect(await api.drainEvidence()).toBe(2);
    const landed = await store().rows<{
      organization_id: string;
      span_id: string;
      text: string;
    }>(
      "select organization_id, span_id, text from spans final " +
        "where span_id in ('ff60000000000001', 'ff60000000000002') " +
        "order by span_id",
    );
    expect(landed).toEqual([
      {
        organization_id: globex.organizationId,
        span_id: "ff60000000000001",
        text: "Said while the store was fussy.",
      },
      {
        organization_id: acme.organizationId,
        span_id: "ff60000000000002",
        text: "Said while the store was fussy.",
      },
    ]);
  });

  /**
   * **A trace store that is down is not an ingestion failure any more.**
   *
   * The acceptance boundary is the object store, so a ClickHouse outage costs
   * query visibility and nothing else: the request is accepted, the evidence is
   * durable, and the rows appear when the store comes back and the object is
   * drained. A 5xx here would send an exporter into a retry loop over evidence
   * Egma already holds.
   */
  it("accepts evidence while the trace store is unreachable, and lands it on recovery", async () => {
    await disconnectClickHouse();
    let accepted;
    try {
      accepted = await stage(twoTenantBatch());
    } finally {
      connectClickHouse({ clickhouseUrl: store().url, maxOpenConnections: 4 });
    }
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await pendingSegments(ingestStore())).toHaveLength(2);

    expect(await api.drainEvidence()).toBe(2);
    expect(
      await countOf(
        "select count() as n from spans final where span_id in " +
          "('ff60000000000001', 'ff60000000000002')",
      ),
    ).toBe(2);
  });
});

describe.skipIf(!storage.available)("the customer-key path, beside it", () => {
  /**
   * The naming attribute belongs to the service path alone. A customer's
   * exporter is free to send it — nothing about a customer request is refused
   * for it — and it decides nothing: tenancy still comes from the key, the
   * rows are still production traffic, and no run is pinned.
   */
  it("ignores egma.simulation_id: the project key owns the rows, which stay production", async () => {
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

    const projectKey = await mintKey(
      api.app,
      globex.cookie,
      "Globex production telemetry",
      globex.projectId,
    );
    const landed = await post(body, projectKey);
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
        `payload from spans final where trace_id = '${traceId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Globex's project key owns these rows — not the Acme simulation the
      // payload names, and not simulation traffic.
      organization_id: globex.organizationId,
      project_id: globex.projectId,
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

describe.skipIf(!storage.available)("the simulation grading handoff", () => {
  /**
   * Completion and evidence readiness can arrive in either order. The drainer
   * requests grading only after ClickHouse can return the evidence, and the
   * per-trace request is replay safe across later segments.
   *
   * A chat-API conversation has one account of itself — egma's — so nothing is
   * waited for beyond it becoming query-visible.
   */
  it("mints exactly one job after the completed simulation is queryable", async () => {
    const jobs = await api.database.sql<{ n: string }>(
      "select count(*) as n from grading_job where trace_id = $1",
      [CHAT_TRACE],
    );
    expect(Number(jobs.rows[0]?.n)).toBe(1);
  });
});

/**
 * The bill, at the same door as the evidence.
 *
 * A `provider_usage` span is the simulator saying what one provider request
 * consumed. The door turns it into a priced usage record in Postgres — priced
 * here rather than in a worker, so a price change never needs a simulator
 * release — while the span itself is filed like every other span.
 *
 * The three claims are the three ways this can go wrong: a bill that is never
 * priced, a resend that charges twice, and a price change that reaches
 * backwards into work already paid for.
 */
describe.skipIf(!storage.available)("a provider_usage span", () => {
  type UsageRow = {
    organization_id: string;
    project_id: string;
    run_id: string;
    work_kind: string;
    simulation_id: string;
    provider: string;
    model: string;
    operation: string;
    unit: string;
    quantities: Record<string, number>;
    measurement: string;
    provider_ref: string | null;
    payment_source: string;
    raw_usage: Record<string, unknown>;
    amount_micros: string;
    priced_by: Record<string, string>;
    span_id: string;
  };

  async function usageOf(simulationId: string): Promise<UsageRow[]> {
    const { rows } = await api.database.sql<UsageRow>(
      "select * from usage_record where simulation_id = $1 order by span_id",
      [simulationId],
    );
    return rows;
  }

  it("becomes one priced record per request, under the simulation's own customer and run", async () => {
    const flush = await post(await fixture("valid", "voice-provider-usage.json"));
    expect(flush.statusCode, flush.body).toBe(200);
    expect(flush.json()).toEqual({});

    const rows = await usageOf(USAGE_SIMULATION);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // The tenancy is the simulation row's, never the payload's — Globex owns
      // this conversation, and the span said nothing about whose it was.
      expect(row.organization_id).toBe(globex.organizationId);
      expect(row.project_id).toBe(globex.projectId);
      expect(row.run_id).toBe(usageRunId);
      expect(row.work_kind).toBe("simulation");
      // Nothing on the wire decides who paid. Every request Egma makes today is
      // made with the deployment's own key.
      expect(row.payment_source).toBe("platform");
    }

    const llm = rows.find((row) => row.model === "gpt-4o-mini");
    expect(llm).toBeDefined();
    expect(llm?.operation).toBe("openai_chat_completions");
    expect(llm?.unit).toBe("tokens");
    expect(llm?.measurement).toBe("provider_reported");
    expect(llm?.provider_ref).toBe("chatcmpl-9f2b1c");
    expect(llm?.quantities).toEqual({
      input_tokens: 1_000,
      cached_input_tokens: 400,
      output_tokens: 100,
    });
    // 1,000 uncached at $0.15/1M, 400 cached at $0.075/1M, 100 out at $0.60/1M.
    expect(Number(llm?.amount_micros)).toBe(240);
    // The provider's own object is kept whole, so a wrong normalisation can be
    // re-rated later rather than re-measured.
    expect(llm?.raw_usage).toMatchObject({ total_tokens: 1_500 });

    const stt = rows.find((row) => row.model === "gpt-live-transcribe");
    expect(stt?.unit).toBe("seconds");
    // 7.3 seconds at $0.017 a minute is 2,068.33 micros, rounded to the micro.
    expect(Number(stt?.amount_micros)).toBe(2_068);

    const tts = rows.find((row) => row.model === "sonic-3.5");
    expect(tts?.unit).toBe("characters");
    expect(tts?.measurement).toBe("client_measured");
    // Cartesia returns no usage object at all, so the record keeps none.
    expect(tts?.raw_usage).toEqual({});
    // 42 characters at $50 per 1M credits, one credit a character.
    expect(Number(tts?.amount_micros)).toBe(2_100);
  });

  it("is stored once however many times the flush is sent", async () => {
    const again = await post(await fixture("valid", "voice-provider-usage.json"));
    expect(again.statusCode, again.body).toBe(200);

    // The write-ahead log replays the same bytes, span ids included, so the
    // second delivery collapses onto the first and nothing is charged twice.
    expect(await usageOf(USAGE_SIMULATION)).toHaveLength(3);
  });

  it("files the span itself under its own kind, like every other span", async () => {
    const kinds = await store().rows<{ kind: string; n: string }>(
      "select kind, count(*) as n from spans final " +
        `where trace_id = '${USAGE_TRACE}' and kind = 'usage' group by kind`,
    );
    expect(Number(kinds[0]?.n)).toBe(3);
  });

  it("is not read off a scope that is not Egma's own simulator", async () => {
    const before = (await usageOf(USAGE_SIMULATION)).length;
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "egma.simulation_id",
                value: { stringValue: USAGE_SIMULATION },
              },
            ],
          },
          scopeSpans: [
            {
              // A framework's own scope, carrying a span that calls itself by
              // Egma's name. It is stored like any other span and it is not a
              // bill: a door that read one as spend would let an emitter write
              // rows into a customer's cost by naming a span.
              scope: { name: "pipecat", version: "1.7.0" },
              spans: [
                {
                  traceId: USAGE_TRACE,
                  spanId: "cc10000000000099",
                  parentSpanId: "cc10000000000001",
                  name: "provider_usage",
                  startTimeUnixNano: "1788862447900000000",
                  endTimeUnixNano: "1788862447900000000",
                  attributes: [
                    {
                      key: "egma.usage.provider",
                      value: { stringValue: "openai" },
                    },
                    {
                      key: "egma.usage.model",
                      value: { stringValue: "gpt-4o-mini" },
                    },
                    {
                      key: "egma.usage.operation",
                      value: { stringValue: "openai_chat_completions" },
                    },
                    {
                      key: "egma.usage.measurement",
                      value: { stringValue: "provider_reported" },
                    },
                    {
                      key: "egma.usage.quantities",
                      value: { stringValue: '{"input_tokens":9999999}' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const posted = await post(body);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(await usageOf(USAGE_SIMULATION)).toHaveLength(before);
  });

  it("costs the flush nothing when Egma cannot read it: the spans still land whole", async () => {
    const before = (await usageOf(USAGE_SIMULATION)).length;
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "egma.simulation_id",
                value: { stringValue: USAGE_SIMULATION },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "egma-simulator", version: "1" },
              spans: [
                {
                  traceId: USAGE_TRACE,
                  spanId: "cc10000000000021",
                  parentSpanId: "cc10000000000001",
                  name: "provider_usage",
                  startTimeUnixNano: "1788862455000000000",
                  endTimeUnixNano: "1788862455000000000",
                  attributes: [
                    {
                      key: "egma.usage.provider",
                      value: { stringValue: "openai" },
                    },
                    {
                      key: "egma.usage.model",
                      value: { stringValue: "gpt-4o-mini" },
                    },
                    {
                      key: "egma.usage.operation",
                      value: { stringValue: "openai_batch" },
                    },
                    {
                      key: "egma.usage.measurement",
                      value: { stringValue: "provider_reported" },
                    },
                    {
                      key: "egma.usage.quantities",
                      value: { stringValue: '{"gpu_hours":3}' },
                    },
                  ],
                },
                {
                  traceId: USAGE_TRACE,
                  spanId: "cc10000000000022",
                  parentSpanId: "cc10000000000001",
                  name: "human_turn",
                  startTimeUnixNano: "1788862455100000000",
                  endTimeUnixNano: "1788862455100000000",
                  attributes: [
                    {
                      key: "egma.turn.text",
                      value: { stringValue: "Can we move it to Friday?" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const posted = await post(body);
    expect(posted.statusCode, posted.body).toBe(200);

    /*
     * **Nothing in the partial-success field, and that is the whole claim.**
     * OTLP's rejected count means "this data was not stored, do not send it
     * again", and this simulator's own sender raises on a non-zero one — after
     * which the reporter abandons the simulation and its terminal report never
     * leaves. A cost Egma could not read is an emitter defect for this
     * deployment's log; losing the conversation over it would be a far worse
     * answer than not knowing what one request cost.
     */
    expect(posted.json()).toEqual({});

    // The turn beside it landed, and so did the unreadable bill's own span:
    // the evidence is kept whole either way.
    const landed = await store().rows<{ span_id: string; kind: string }>(
      `select span_id, kind from spans final where trace_id = '${USAGE_TRACE}' ` +
        "and span_id in ('cc10000000000021', 'cc10000000000022') order by span_id",
    );
    expect(landed.map((row) => row.kind)).toEqual(["usage", "turn:human"]);

    // And no record was priced from it, because nothing about it could be.
    expect(await usageOf(USAGE_SIMULATION)).toHaveLength(before);
  });

  it("is priced at the rate that was in force when the provider answered", async () => {
    // A price change lands with its own effective date, after the flush above.
    await api.database.sql(
      "insert into rate_card (id, provider, model, usage_type, unit, " +
        "usd_per_million, effective_from, source, read_at) values " +
        "($1, 'openai', 'gpt-4o-mini', 'input_tokens', 'tokens', '1.50', " +
        "$2, 'https://developers.openai.com/api/docs/pricing', '2027-01-01')",
      [`rat_${"0".repeat(26)}`, new Date("2027-01-01T00:00:00.000Z")],
    );

    // The record already stored keeps the price it was written at: a stored
    // cost never moves.
    const before = await usageOf(USAGE_SIMULATION);
    expect(
      Number(before.find((row) => row.model === "gpt-4o-mini")?.amount_micros),
    ).toBe(240);

    // And a request made after that date is priced at the new row. The same
    // fixture with new span ids and a later instant is a different request.
    const later = JSON.parse(
      (await fixture("valid", "voice-provider-usage.json"))
        .replaceAll("cc1000000000001", "cc1000000000009")
        .replaceAll("1788862447900000000", "1803896047900000000"),
    ) as Record<string, unknown>;
    const priced = await post(JSON.stringify(later));
    expect(priced.statusCode, priced.body).toBe(200);

    const rows = await usageOf(USAGE_SIMULATION);
    const now = rows.filter((row) => row.span_id.startsWith("cc1000000000009"));
    expect(now).toHaveLength(3);
    // $1.50 per 1M on the thousand uncached tokens, and the cached and output
    // halves still at the prices that did not change.
    expect(
      Number(now.find((row) => row.model === "gpt-4o-mini")?.amount_micros),
    ).toBe(1_500 + 30 + 60);
  });
});
