import {
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  reportedMeasurementsPayload,
} from "@egma/metrics";
import {
  appendSpans,
  connectClickHouse,
  disconnectClickHouse,
  MAXIMUM_SPANS_PER_TRACE,
  readProductionGradingPlan,
  type NewSpan,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { pendingSegments } from "./support/ingestion.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { FIXTURE_TRACE } from "./support/fixture.ts";
import {
  contextFor,
  everySpan,
  listTracesOverHttp,
  mintKey,
  readTraceOverHttp,
  replayFixture,
  signUp,
  syntheticExport,
  type Customer,
  type DetailMeasure,
  type DetailSpan,
  type ListedPage,
  type TraceDetailBody,
} from "./support/traces.ts";

/**
 * Replay captured LiveKit exports through ingestion and read both public trace
 * endpoints. Check the captured turns, tool calls, and model errors across
 * authentication, decoding, attribution, storage, and transcript assembly.
 */

const storage: ObjectStorage = await startObjectStorage("trace-reads");

if (!storage.available) {
  process.stderr.write(`\nskipping the trace-reads suite — ${storage.why}\n\n`);
}

/** The ingestion bucket this instance accepts into, for reading it back. */
function ingestStore() {
  if (!storage.available) throw new Error("this suite has no object store");
  return storage.ingestStore;
}

let api: TestApi;
let acme: Customer;

/** Every root-to-leaf path of names under one span, for asking about nesting. */
function namePaths(span: DetailSpan): string[][] {
  if (span.spans.length === 0) return [[span.name]];
  return span.spans.flatMap((child) =>
    namePaths(child).map((path) => [span.name, ...path]),
  );
}

/** A window comfortably containing the capture, which happened inside a minute. */
const WINDOW = {
  from: "2026-08-02T18:00:00Z",
  to: "2026-08-02T19:00:00Z",
} as const;

beforeAll(async () => {
  if (!storage.available) return;
  api = await createApi("trace_reads", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  const telemetrySecret = await mintKey(
    api.app,
    acme.cookie,
    "Acme production telemetry",
    acme.projectId,
  );
  await replayFixture(api, telemetrySecret);
});

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

async function listed(): Promise<ListedPage> {
  const response = await listTracesOverHttp(api.app, acme.secret, WINDOW);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ListedPage;
}

async function transcript(): Promise<TraceDetailBody> {
  const page = await listed();
  const traceId = page.traces[0]?.traceId;
  if (traceId === undefined) throw new Error("the list found no trace");

  const response = await readTraceOverHttp(api.app, acme.secret, traceId, WINDOW);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as TraceDetailBody;
}

/**
 * Accept evidence during a ClickHouse outage, then drain after recovery.
 * Check list, transcript, and measures without requiring a sender retry;
 * complete durable handoffs before deleting the pending object.
 */
describe.skipIf(!storage.available)(
  "a conversation accepted while the trace store was down",
  () => {
    const traceId = "7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c";
    const WHILE_DOWN = {
      from: "2026-08-09T09:00:00Z",
      to: "2026-08-09T10:00:00Z",
    } as const;

    it("appears whole in every read once the store is back, and only then is the object gone", async () => {
      const store = api.traceStore;
      if (store === undefined) throw new Error("this API has no trace store");
      const secret = await mintKey(
        api.app,
        acme.cookie,
        "an agent talking through an outage",
        acme.projectId,
      );

      await disconnectClickHouse();
      let accepted;
      try {
        accepted = await api.app.inject({
          method: "POST",
          url: OTLP_TRACES_PATH,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
          },
          payload: syntheticExport({
            traceId,
            startedAt: new Date("2026-08-09T09:30:00Z"),
            humanSaid: "Can you still hear me?",
          }),
        });
      } finally {
        connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });
      }
      // Accepted, because the object store took it. The sender owes nothing.
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(await pendingSegments(ingestStore())).toHaveLength(1);

      await api.drainEvidence();

      const page = (
        await listTracesOverHttp(api.app, secret, WHILE_DOWN)
      ).json() as ListedPage;
      expect(page.traces.map((trace) => trace.traceId)).toEqual([traceId]);
      expect(page.traces[0]?.turnCounts).toEqual({ human: 1, agent: 1 });

      const detail = (
        await readTraceOverHttp(api.app, secret, traceId, WHILE_DOWN)
      ).json() as TraceDetailBody;
      expect(
        everySpan(detail.turns).map((span) => span.text).filter((text) => text !== ""),
      ).toContain("Can you still hear me?");
      expect(detail.metrics.length).toBeGreaterThan(0);

      // The supported end froze the empty production selection before the
      // object was deleted. Expected behaviors grades simulations only, so no
      // temporary worker job is invented for this production trace.
      await expect(
        readProductionGradingPlan(contextFor(acme, "admin"), traceId),
      ).resolves.toMatchObject({ traceId, entries: [] });
      const { rows } = await api.database.sql<{ count: string }>(
        "select count(*) as count from grading_job where trace_id = $1",
        [traceId],
      );
      expect(rows[0]?.count).toBe("0");
      expect(await pendingSegments(ingestStore())).toHaveLength(0);
    });
  },
);

describe.skipIf(!storage.available)("the captured trace, found in a list", () => {
  it("counts every span that arrived, and the turns inside them", async () => {
    const [trace] = (await listed()).traces;
    expect(trace?.spanCount).toBe(FIXTURE_TRACE.spans);
    expect(trace?.turnCounts).toEqual({
      human: FIXTURE_TRACE.humanTurns,
      agent: FIXTURE_TRACE.agentTurns,
    });
    expect(trace?.toolSpanCount).toBe(FIXTURE_TRACE.toolSpans);
    expect(trace?.erroredSpanCount).toBe(FIXTURE_TRACE.erroredSpans);
  });

  /**
   * From the turn-grain view, which is what its truncated text column is for.
   * The first thing the *human* said, and not the transcript's opening line —
   * this agent greets first, so the opening line is the agent's, and a list
   * previewing it would show the same greeting on every row.
   */
  it("previews the first thing the human said", async () => {
    const [trace] = (await listed()).traces;
    expect(trace?.preview).toBe("Hi Kelly, my name is Sam.");
    // The line the trace actually opens with, which is the agent's.
    expect(trace?.preview).not.toBe("Hello! How can I assist you today?");
  });

  /**
   * Check the exclusive end bound at microsecond precision: a bound at the
   * first span start excludes it, while one microsecond later includes it.
   * Millisecond truncation would incorrectly exclude both.
   */
  it("reads a window to the microsecond, at an exclusive end", async () => {
    const opened = "2026-08-02T18:04:40.281989Z";

    const barely = await listTracesOverHttp(api.app, acme.secret, {
      from: WINDOW.from,
      to: "2026-08-02T18:04:40.281990Z",
    });
    expect(barely.statusCode, barely.body).toBe(200);
    const inside = (barely.json() as ListedPage).traces;
    expect(inside).toHaveLength(1);
    expect(inside[0]?.startedAt).toBe(opened);
    // One microsecond of window, and one span of the trace in it.
    expect(inside[0]?.spanCount).toBe(1);

    // And at the instant itself, nothing: the end of a window is open.
    const excluded = await listTracesOverHttp(api.app, acme.secret, {
      from: WINDOW.from,
      to: opened,
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect((excluded.json() as ListedPage).traces).toEqual([]);
  });
});

describe.skipIf(!storage.available)("the captured trace, read as a transcript", () => {
  /**
   * Each turn expands into the steps that happened inside it, which is the
   * detail page's whole reason for existing: the human's turn holds the audio it
   * ran over and the end-of-turn detection that closed it, and the agent's holds
   * the model call, the synthesis and the speaking.
   */
  it("opens each turn onto the timed steps inside it", async () => {
    const detail = await transcript();

    expect(
      detail.turns.map((turn) => turn.spans.map((span) => span.kind).join(",")),
    ).toEqual([
      "model,tts,speaking",
      "speaking,speaking,speaking,end-of-turn",
      "end-of-turn",
      "model,tts,speaking",
      "speaking,speaking,speaking,end-of-turn",
      "model,tts,speaking",
      "speaking,speaking,end-of-turn",
      "speaking,end-of-turn",
      "model,tts,speaking",
    ]);

    // And the model calls keep their own nesting: LiveKit's adapters go four
    // deep and only the innermost names the real model, so flattening would
    // throw away the one structure that says which attempt was the retry.
    const paths = detail.turns
      .flatMap((turn) => turn.spans.flatMap(namePaths))
      .map((path) => path.join(" > "));
    expect(
      paths.some((path) =>
        path.startsWith(
          "llm_node > llm_fallback_adapter > llm_request_run > llm_request",
        ),
      ),
      "the four-deep model call kept its shape",
    ).toBe(true);
  });

  /**
   * The two weather lookups remain nested under their native agent records.
   * Those records are raw trace containers because they have no spoken reply;
   * the tools do not become blank conversation turns or float to the top.
   */
  it("keeps each tool call inside the native agent record that made it", async () => {
    const detail = await transcript();

    const recordsWithTools = everySpan(detail.spans).filter((span) =>
      span.name === "agent_turn" &&
      span.kind === "other" &&
      everySpan(span.spans).some((child) => child.kind === "tool"),
    );
    expect(recordsWithTools).toHaveLength(2);

    const tools = recordsWithTools.flatMap((record) =>
      everySpan(record.spans).filter((span) => span.kind === "tool"),
    );
    expect(tools).toHaveLength(FIXTURE_TRACE.toolSpans);
    expect(tools.map((tool) => tool.toolName)).toEqual([
      "lookup_weather",
      "lookup_weather",
    ]);
    expect(tools[0]?.toolArguments).toBe('{"location": "Lisbon"}');
    expect(tools[0]?.toolResult).toBe(
      "sunny with a temperature of 70 degrees.",
    );

    // And nowhere else: no tool call sits at the top of the trace.
    expect(detail.spans.filter((span) => span.kind === "tool")).toEqual(
      [],
    );
  });

  /**
   * The root span is the one everything happened inside, and it is available
   * without being part of the transcript. Its children in the response are its
   * bookkeeping, never the turns — those were lifted out, and appear exactly
   * once each.
   */
  it("keeps the root span out of the transcript and reachable beside it", async () => {
    const detail = await transcript();

    expect(detail.spans.map((span) => span.name)).toEqual(["agent_session"]);
    expect(detail.spans[0]?.kind).toBe("root");
    expect(detail.spans[0]?.parentSpanId).toBe("");

    const beneathTheRoot = everySpan(detail.spans[0]?.spans ?? []);
    expect(beneathTheRoot.filter((span) => span.kind.startsWith("turn:"))).toEqual(
      [],
    );

    const ids = [...everySpan(detail.turns), ...everySpan(detail.spans)].map(
      (span) => span.spanId,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(FIXTURE_TRACE.spans);
  });
});

/**
 * Assert serialized measure keys to detect unintended contract changes.
 * Use a separate date for these synthetic traces so they do not alter capture
 * queries in other cases.
 */
describe.skipIf(!storage.available)("what one measure looks like on the wire", () => {
  const SIMULATED = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
  const REPORTED = "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b";
  const TRUNCATED = "1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c";

  /** A day of its own, holding nothing the rest of this file reads. */
  const THE_NEXT_DAY = {
    from: "2026-08-03T00:00:00Z",
    to: "2026-08-04T00:00:00Z",
  } as const;
  const AT = BigInt(Date.parse("2026-08-03T09:00:00Z")) * 1_000n;

  /** Every column stated, so a case says only what it is about. */
  function span(over: Partial<NewSpan>): NewSpan {
    return {
      traceId: "",
      spanId: "",
      parentSpanId: "",
      source: "production",
      emitter: "agent",
      environment: "default",
      startedAtMicroseconds: AT,
      durationNanoseconds: 1_000_000_000n,
      name: "agent_session",
      kind: "root",
      status: "unset",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      providerCallId: "room-wire",
      agentPlatform: "livekit",
      platformAgentId: "",
      platformAgentName: "",
      platformAgentVersion: "",
      connectionType: "livekit",
      runId: "",
      agentId: "",
      agentVersionId: "",
      testVersionId: "",
      personaVersionId: "",
      payload: "{}",
      endsTrace: false,
      ...over,
    };
  }

  async function measureOf(traceId: string): Promise<DetailMeasure> {
    const response = await readTraceOverHttp(
      api.app,
      acme.secret,
      traceId,
      THE_NEXT_DAY,
    );
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as TraceDetailBody;
    const only = body.metrics[0];
    if (only === undefined) throw new Error("the read measured nothing");
    return only;
  }

  async function summaries() {
    const response = await listTracesOverHttp(
      api.app,
      acme.secret,
      THE_NEXT_DAY,
    );
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as ListedPage).traces;
  }

  beforeAll(async () => {
    const auth = contextFor(acme, "admin");

    // A simulation, timing its own turn the way egma's simulator does.
    await appendSpans(auth, [
      span({
        traceId: SIMULATED,
        spanId: "5100000000000001",
        source: "simulation",
        emitter: "egma-runtime",
        connectionType: "",
        runId: "run_01JQZ0000000000000000000AA",
        agentId: "agt_01JQZ0000000000000000000AA",
      }),
      span({
        traceId: SIMULATED,
        spanId: "5100000000000002",
        parentSpanId: "5100000000000001",
        source: "simulation",
        emitter: "egma-runtime",
        connectionType: "",
        runId: "run_01JQZ0000000000000000000AA",
        agentId: "agt_01JQZ0000000000000000000AA",
        name: "turn_response_latency",
        kind: "timing",
        startedAtMicroseconds: AT + 1_000_000n,
        durationNanoseconds: 1_100_000_000n,
      }),
    ]);

    // And a managed platform's conversation: no turns, no timings, and the
    // block on the root — written through the contract's own writer, so this
    // spells it exactly as a normalizer does.
    await appendSpans(auth, [
      span({
        traceId: REPORTED,
        spanId: "5200000000000001",
        name: "retell_call",
        kind: "conversation",
        connectionType: "retell",
        providerCallId: "call_wire",
        payload: JSON.stringify({
          call_id: "call_wire",
          egma_normalised: {
            degraded: false,
            [REPORTED_MEASUREMENTS_PAYLOAD_KEY]: reportedMeasurementsPayload(
              "retell",
              [
                {
                  measure: "turn_response_latency",
                  unit: "milliseconds",
                  values: [517, 2145],
                },
              ],
            ),
          },
        }),
      }),
    ]);

    // The list computes a metric from the same bounded prefix as detail. Keep a
    // usable timing inside that prefix and one extra span beyond it so the HTTP
    // contract must say that the otherwise real P90 is partial.
    const oversized = Array.from(
      { length: MAXIMUM_SPANS_PER_TRACE + 1 },
      (_, index) =>
        span({
          traceId: TRUNCATED,
          spanId: (0x5300000000000000n + BigInt(index)).toString(16),
          parentSpanId: index === 0 ? "" : "5300000000000000",
          name:
            index === 0
              ? "agent_session"
              : index === 1
                ? "turn_response_latency"
                : "tts_request",
          kind: index === 0 ? "root" : index === 1 ? "timing" : "tts",
          startedAtMicroseconds: AT + BigInt(index),
          durationNanoseconds:
            index === 1 ? 4_780_000_000n : 1_000_000_000n,
        }),
    );
    const half = Math.ceil(oversized.length / 2);
    await appendSpans(auth, oversized.slice(0, half));
    await appendSpans(auth, oversized.slice(half));
  });

  it("marks only a P90 computed from a truncated trace as partial", async () => {
    const byId = new Map((await summaries()).map((trace) => [trace.traceId, trace]));

    expect(byId.get(SIMULATED)?.turnResponseLatencyP90Partial).toBe(false);
    expect(byId.get(REPORTED)?.turnResponseLatencyP90Partial).toBe(false);
    expect(byId.get(TRUNCATED)?.turnResponseLatencyP90Milliseconds).toBe(4780);
    expect(byId.get(TRUNCATED)?.turnResponseLatencyP90Partial).toBe(true);
  });

  it("adds the platform's name, and only there, on a measure it reported", async () => {
    const only = await measureOf(REPORTED);

    expect(Object.keys(only).sort()).toEqual([
      "derived",
      "mean",
      "measure",
      "p50",
      "p90",
      "partial",
      "pov",
      "reportedBy",
      "samples",
      "spanIds",
      "unit",
    ]);
    // The platform's account of its own agent is the agent's POV, however it
    // reached egma.
    expect(only.pov).toBe("agent");
    // `derived` says what it has always said — egma did not time this — and the
    // new field says which of the two untimed sources it was.
    expect(only.derived).toBe(true);
    expect(only.reportedBy).toBe("retell");
    expect(only.samples).toEqual([517, 2145]);
    // The mean of the two reported waits, rounded once in the module.
    expect(only.mean).toBe(1331);
    // Nearest-rank over [517, 2145]: the median is the first, the p90 the second.
    expect(only.p50).toBe(517);
    expect(only.p90).toBe(2145);
  });

  /**
   * **A block is never a prefix.** `partial` says the figure was reduced over
   * the first part of a conversation the read had to stop somewhere in. A
   * platform's block is one row's account of the whole conversation, so there
   * is no cut its worst measurement could be past — and saying otherwise would
   * have a page disclaim a number that needs no disclaimer.
   */
  it("never calls a reported measure partial", async () => {
    expect((await measureOf(REPORTED)).partial).toBe(false);
  });
});

describe.skipIf(!storage.available)(
  "two speakers projected from one native LiveKit chat span",
  () => {
    const TRACE = "1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e";
    const WHEN = {
      from: "2026-08-04T00:00:00Z",
      to: "2026-08-05T00:00:00Z",
    } as const;
    const AT = BigInt(Date.parse("2026-08-04T09:00:00Z")) * 1_000n;

    function turn(over: Partial<NewSpan>): NewSpan {
      return {
        traceId: TRACE,
        spanId: "",
        parentSpanId: "",
        source: "simulation",
        emitter: "agent",
        environment: "default",
        startedAtMicroseconds: AT,
        durationNanoseconds: 1_000_000_000n,
        name: "agent_turn",
        kind: "other",
        status: "ok",
        text: "",
        audioUrl: "",
        toolName: "",
        toolArguments: "",
        toolResult: "",
        providerCallId: "room-chat-order",
        agentPlatform: "livekit",
        platformAgentId: "",
        platformAgentName: "",
        platformAgentVersion: "",
        connectionType: "livekit_room",
        runId: "run_01JQZ0000000000000000000CC",
        agentId: "agt_01JQZ0000000000000000000CC",
        agentVersionId: "",
        testVersionId: "",
        personaVersionId: "",
        payload: "{}",
        endsTrace: false,
        ...over,
      };
    }

    beforeAll(async () => {
      await appendSpans(contextFor(acme, "admin"), [
        turn({
          spanId: "ee00000000000001",
          kind: "turn:human",
          text: "Please book Tuesday.",
          payload:
            '{"egma.projection":{"source":"lk.pii.user_input"}}',
        }),
        // This ID sorts before the projection ID. Public conversation order
        // must follow speaker role for the shared native timestamp.
        turn({
          spanId: "1100000000000001",
          kind: "turn:agent",
          text: "Tuesday is booked.",
        }),
        // The same tie rule keeps a voice interruption readable too.
        turn({
          spanId: "ff00000000000001",
          kind: "turn:human",
          text: "Wait.",
          startedAtMicroseconds: AT + 2_000_000n,
        }),
        turn({
          spanId: "0100000000000001",
          kind: "turn:agent",
          text: "I stopped.",
          startedAtMicroseconds: AT + 2_000_000n,
        }),
      ]);
    });

    it("returns caller then agent through the public trace endpoint", async () => {
      const response = await readTraceOverHttp(
        api.app,
        acme.secret,
        TRACE,
        WHEN,
      );
      expect(response.statusCode, response.body).toBe(200);
      const detail = response.json() as TraceDetailBody;

      expect(detail.turns.map(({ kind, text }) => [kind, text])).toEqual([
        ["turn:human", "Please book Tuesday."],
        ["turn:agent", "Tuesday is booked."],
        ["turn:human", "Wait."],
        ["turn:agent", "I stopped."],
      ]);
    });
  },
);

/**
 * Generic trace reads return tool facts without mock marks. Mock coverage is
 * derived by the simulation read from its pinned test and connection type.
 */
describe.skipIf(!storage.available)("what a tool call brings back", () => {
  const MIXED = "1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d";
  const WHEN = {
    from: "2026-08-05T00:00:00Z",
    to: "2026-08-06T00:00:00Z",
  } as const;
  const AT = BigInt(Date.parse("2026-08-05T09:00:00Z")) * 1_000n;

  /** Every column stated, so a case says only what it is about. */
  function span(over: Partial<NewSpan>): NewSpan {
    return {
      traceId: MIXED,
      spanId: "",
      parentSpanId: "",
      source: "simulation",
      emitter: "egma-runtime",
      environment: "default",
      startedAtMicroseconds: AT,
      durationNanoseconds: 1_000_000_000n,
      name: "agent_session",
      kind: "root",
      status: "ok",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      providerCallId: "",
      agentPlatform: "retell",
      platformAgentId: "",
      platformAgentName: "",
      platformAgentVersion: "",
      connectionType: "",
      runId: "run_01JQZ0000000000000000000BB",
      agentId: "agt_01JQZ0000000000000000000BB",
      agentVersionId: "",
      testVersionId: "",
      personaVersionId: "",
      payload: "{}",
      endsTrace: false,
      ...over,
    };
  }

  beforeAll(async () => {
    await appendSpans(contextFor(acme, "admin"), [
      span({ spanId: "5400000000000001" }),
      // One written exactly as the mock endpoint writes it, stamp and all —
      // rows like this exist in the store and the read must simply pass over
      // the stamp rather than promote it into an answer.
      span({
        spanId: "5400000000000002",
        parentSpanId: "5400000000000001",
        name: "tool_call",
        kind: "tool",
        toolName: "get_availability",
        toolArguments: '{"day":"Tuesday"}',
        toolResult: '{"slots":[]}',
        startedAtMicroseconds: AT + 1_000_000n,
        payload: JSON.stringify({
          "egma.tool.name": "get_availability",
          "egma.tool.arguments": '{"day":"Tuesday"}',
          "egma.tool.result": '{"slots":[]}',
          "egma.tool.provenance": "mocked",
          "egma.tool.mock_tool": "get_availability",
        }),
      }),
      // And one the test never named, which reached the real backend.
      span({
        spanId: "5400000000000003",
        parentSpanId: "5400000000000001",
        name: "tool_call",
        kind: "tool",
        toolName: "send_receipt",
        toolArguments: "{}",
        toolResult: "ok",
        startedAtMicroseconds: AT + 2_000_000n,
      }),
    ]);
  });

  it("returns both calls whole, and marks neither", async () => {
    const response = await readTraceOverHttp(api.app, acme.secret, MIXED, WHEN);
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json() as TraceDetailBody;

    const tools = [
      ...everySpan(detail.turns),
      ...everySpan(detail.spans),
    ].filter((one) => one.kind === "tool");
    const byName = new Map(tools.map((one) => [one.toolName, one]));

    // What the calls were and what they were given, on both of them.
    expect(byName.get("get_availability")?.toolArguments).toBe(
      '{"day":"Tuesday"}',
    );
    expect(byName.get("get_availability")?.toolResult).toBe('{"slots":[]}');
    expect(byName.get("send_receipt")?.toolResult).toBe("ok");

    // And no mark on either, including the one carrying the old payload
    // stamp. A production read has no pinned test version to read a mocked
    // mark from, so it makes no claim about who answered.
    for (const tool of tools) {
      expect("toolProvenance" in tool, tool.toolName).toBe(false);
    }

    // What the read does say is whose POV each row is — the storage column,
    // read as the product word. These rows were filed by egma's own simulator,
    // so they read as the persona's.
    for (const tool of tools) expect(tool.pov, tool.toolName).toBe("persona");
  });
});
