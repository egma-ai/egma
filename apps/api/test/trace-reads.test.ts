import {
  appendSpans,
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  reportedMeasurementsPayload,
  type NewSpan,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { FIXTURE_PROVIDER_CALL_ID, FIXTURE_TRACE } from "./support/fixture.ts";
import {
  contextFor,
  everySpan,
  listTracesOverHttp,
  readTraceOverHttp,
  replayFixture,
  signUp,
  type Customer,
  type DetailMeasure,
  type DetailSpan,
  type ListedPage,
  type TraceDetailBody,
} from "./support/traces.ts";

/**
 * The spine, end to end: a real LiveKit agent's telemetry goes in at the door,
 * and the trace comes back out of the two v1 endpoints as a transcript.
 *
 * One test path exercises the credential, the protobuf decoding, the
 * normalisation, the tenancy stamp, the append, the turn-grain view and both
 * read contracts — because every one of those is a place the path can be right
 * on its own and wrong end to end. Nothing here is a fixture of what egma
 * believes telemetry looks like: the fourteen bodies are the ones an exporter
 * really sent, replayed byte for byte.
 *
 * What is asserted is the exchange that was actually had — five things the
 * human said, eight the agent said, two weather lookups, one model timing out
 * and recovering — rather than the shape of the code that returns it.
 */

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
  api = await createApi("trace_reads", { traceStore: true });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  await replayFixture(api.app, acme.secret);
});

afterAll(async () => {
  await api?.close();
});

async function listed(): Promise<ListedPage> {
  const response = await listTracesOverHttp(api.app, acme.secret, WINDOW);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ListedPage;
}

async function transcript(): Promise<TraceDetailBody> {
  const page = await listed();
  const traceId = page.traces[0]?.trace_id;
  if (traceId === undefined) throw new Error("the list found no trace");

  const response = await readTraceOverHttp(api.app, acme.secret, traceId, WINDOW);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as TraceDetailBody;
}

describe("the captured trace, found in a list", () => {
  it("is one trace inside a window containing it, and the last page of one", async () => {
    const page = await listed();
    expect(page.traces).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
    // Echoed to the microsecond, which is the precision the window was read at
    // and the precision every other instant in the answer comes back at.
    expect(page.window).toEqual({
      from: "2026-08-02T18:00:00.000000Z",
      to: "2026-08-02T19:00:00.000000Z",
    });
  });

  it("counts every span that arrived, and the turns inside them", async () => {
    const [trace] = (await listed()).traces;
    expect(trace?.span_count).toBe(FIXTURE_TRACE.spans);
    expect(trace?.turn_counts).toEqual({
      human: FIXTURE_TRACE.humanTurns,
      agent: FIXTURE_TRACE.agentTurns,
    });
    expect(trace?.tool_span_count).toBe(FIXTURE_TRACE.toolSpans);
    expect(trace?.errored_span_count).toBe(FIXTURE_TRACE.erroredSpans);
  });

  /**
   * The trace started when its first span was stamped, to the microsecond the
   * writer wrote — not to the millisecond a JavaScript date would have rounded
   * it to. The extent is the whole trace's, which for this capture is the root
   * span's own duration, because the root is the span everything else happened
   * inside.
   */
  it("says when the trace happened and how long it ran", async () => {
    const [trace] = (await listed()).traces;
    expect(trace?.started_at).toBe("2026-08-02T18:04:40.281989Z");
    expect(trace?.duration_ns).toBe("73494876403");
    expect(trace?.ended_at).toBe("2026-08-02T18:05:53.776865Z");
  });

  it("says where it came from and what it was reached over", async () => {
    const [trace] = (await listed()).traces;
    expect(trace?.source).toBe("production");
    expect(trace?.emitter).toBe("agent");
    expect(trace?.environment).toBe("default");
    expect(trace?.connection_type).toBe("livekit");
    expect(trace?.provider_call_id).toBe(FIXTURE_PROVIDER_CALL_ID);
    // Nothing started this one, so there is no run and no agent pinned to it.
    expect(trace?.run_id).toBe("");
    expect(trace?.agent_id).toBe("");
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
   * The window is read to the microsecond it named, and the exclusive end is
   * exclusive to the microsecond too.
   *
   * This capture is where that can be asked sharply: its first span opens at
   * `…40.281989Z`, so a `to` one microsecond later holds exactly that span and a
   * `to` at the instant itself holds none of it. A bound rounded down to the
   * millisecond a `Date` carries would land at `…40.281000Z` on both, before
   * anything of the trace, and the customer would be told a trace they were
   * looking straight at was not there.
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
    expect(inside[0]?.started_at).toBe(opened);
    // One microsecond of window, and one span of the trace in it.
    expect(inside[0]?.span_count).toBe(1);

    // And at the instant itself, nothing: the end of a window is open.
    const excluded = await listTracesOverHttp(api.app, acme.secret, {
      from: WINDOW.from,
      to: opened,
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect((excluded.json() as ListedPage).traces).toEqual([]);
  });
});

describe("the captured trace, read as a transcript", () => {
  it("is thirteen turns in the order they were taken", async () => {
    const detail = await transcript();

    expect(detail.turns).toHaveLength(
      FIXTURE_TRACE.humanTurns + FIXTURE_TRACE.agentTurns,
    );
    expect(detail.turns.filter((turn) => turn.kind === "turn:human")).toHaveLength(
      FIXTURE_TRACE.humanTurns,
    );
    expect(detail.turns.filter((turn) => turn.kind === "turn:agent")).toHaveLength(
      FIXTURE_TRACE.agentTurns,
    );

    const times = detail.turns.map((turn) => turn.started_at);
    expect([...times].sort()).toEqual(times);
  });

  /**
   * The exchange that was actually had, written out — which is the only
   * assertion that can tell a transcript from a list of rows in the right order.
   *
   * The four agent turns with no text are real and not a loss: they are the
   * turns where the agent did not speak, two of them because they only called
   * the weather tool. Recognition rides the human's turn as attributes rather
   * than as a span of its own, which is why every human turn has its line.
   */
  it("carries what each speaker actually said, in the order they said it", async () => {
    const detail = await transcript();

    expect(
      detail.turns.map((turn) => [turn.kind, turn.text] as const),
    ).toEqual([
      ["turn:agent", "Hello! How can I assist you today?"],
      ["turn:human", "Hi Kelly, my name is Sam."],
      ["turn:agent", ""],
      ["turn:human", "Can you tell me what the weather is like in Lisbon today?"],
      ["turn:agent", ""],
      [
        "turn:agent",
        "The weather in Lisbon today is sunny with a temperature of 70 degrees. Do you need any more information?",
      ],
      ["turn:human", "Thanks, and how about Oslo? Is it colder there right now?"],
      ["turn:agent", ""],
      [
        "turn:agent",
        "Oslo is also sunny, but it has the same temperature of 70 degrees. Would you like to know anything else?",
      ],
      ["turn:human", "Great, that is all I needed."],
      ["turn:agent", ""],
      ["turn:human", "Have a good day, and goodbye."],
      ["turn:agent", "Thank you, Sam! Have a great day, and goodbye!"],
    ]);
  });

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
      "model,tts",
      "end-of-turn",
      "model,tool",
      "model,tts,speaking",
      "speaking,speaking,speaking,end-of-turn",
      "model,tool",
      "model,tts,speaking",
      "speaking,speaking,end-of-turn",
      "model,tts",
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
   * The two weather lookups are not loose spans at the top of the trace: each
   * one happened inside the agent turn that made it, and finding it means
   * opening that turn. A transcript where a tool call floated free would be one
   * where nobody could tell which answer it was for.
   */
  it("keeps each tool call inside the agent turn that made it", async () => {
    const detail = await transcript();

    const turnsWithTools = detail.turns.filter((turn) =>
      everySpan(turn.spans).some((span) => span.kind === "tool"),
    );
    expect(turnsWithTools.map((turn) => turn.kind)).toEqual([
      "turn:agent",
      "turn:agent",
    ]);

    const tools = turnsWithTools.flatMap((turn) =>
      everySpan(turn.spans).filter((span) => span.kind === "tool"),
    );
    expect(tools).toHaveLength(FIXTURE_TRACE.toolSpans);
    expect(tools.map((tool) => tool.tool_name)).toEqual([
      "lookup_weather",
      "lookup_weather",
    ]);
    expect(tools[0]?.tool_arguments).toBe('{"location": "Lisbon"}');
    expect(tools[0]?.tool_result).toBe(
      "sunny with a temperature of 70 degrees.",
    );

    // And nowhere else: no tool call sits at the top of the trace.
    expect(everySpan(detail.spans).filter((span) => span.kind === "tool")).toEqual(
      [],
    );
  });

  /**
   * The capture deliberately keeps a real failure — a model timing out, the
   * fallback giving up, and the turn succeeding on the retry. A transcript that
   * showed only the successful attempt would make the trace look
   * healthier than it was.
   */
  it("shows the spans that failed, with the status that says so", async () => {
    const detail = await transcript();

    const everything = [
      ...everySpan(detail.turns),
      ...everySpan(detail.spans),
    ];
    const failed = everything.filter((span) => span.status === "error");

    expect(failed).toHaveLength(FIXTURE_TRACE.erroredSpans);
    expect(failed.map((span) => span.name).sort()).toEqual([
      "llm_request",
      "llm_request_run",
      "llm_request_run",
    ]);
    // Inside a turn, which is where a person looking for what went wrong looks.
    for (const span of failed) {
      expect(everySpan(detail.turns).map((each) => each.span_id)).toContain(
        span.span_id,
      );
    }
  });

  /**
   * There is no speech-to-text span because this framework emits none:
   * recognition arrives as attributes on the human's turn. A kind for a span
   * nobody sends would be invented structure, and a transcript that showed one
   * would be showing a step that never happened.
   */
  it("has no speech-to-text step under any turn, because none was ever sent", async () => {
    const detail = await transcript();
    const everything = [
      ...everySpan(detail.turns),
      ...everySpan(detail.spans),
    ];

    expect(everything.filter((span) => span.kind === "stt")).toEqual([]);
    expect([...new Set(everything.map((span) => span.kind))].sort()).toEqual([
      "end-of-turn",
      "model",
      "other",
      "root",
      "speaking",
      "tool",
      "tts",
      "turn:agent",
      "turn:human",
    ]);
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
    expect(detail.spans[0]?.parent_span_id).toBe("");

    const beneathTheRoot = everySpan(detail.spans[0]?.spans ?? []);
    expect(beneathTheRoot.filter((span) => span.kind.startsWith("turn:"))).toEqual(
      [],
    );

    const ids = [...everySpan(detail.turns), ...everySpan(detail.spans)].map(
      (span) => span.span_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(FIXTURE_TRACE.spans);
  });

  /**
   * This capture came off a customer's own agent, so egma conducted nothing
   * here — and the answer says so by naming no simulation.
   *
   * The two identifiers are the same 128 bits written two ways, so *any* trace
   * id converts to a well-formed simulation id, including this one. Sending it
   * would be claiming a simulation exists, and the surface that reads this
   * field would then go asking for a recording of a conversation egma never
   * had. Which trace is a simulation is a fact the row carries — `source` — and
   * it is read here rather than guessed by the reader.
   */
  it("names no simulation, because a customer's own agent had this exchange", async () => {
    const detail = await transcript();

    expect(detail.trace.source).toBe("production");
    expect(detail.simulation_id).toBeNull();
  });

  it("reports the trace's own facts beside the transcript, and no payload with them", async () => {
    const detail = await transcript();

    expect(detail.trace.span_count).toBe(FIXTURE_TRACE.spans);
    expect(detail.trace.turn_counts).toEqual({
      human: FIXTURE_TRACE.humanTurns,
      agent: FIXTURE_TRACE.agentTurns,
    });
    expect(detail.trace.started_at).toBe("2026-08-02T18:04:40.281989Z");
    expect(detail.spans_truncated).toBe(false);

    // The verbatim payload is the largest column on the row and is deliberately
    // not in this response. It is not lost — it is on the span — and reaching it
    // is a per-span request nothing needs yet.
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("telemetry.sdk.version");
    expect(serialised).not.toContain("payload");
    const everything: DetailSpan[] = [
      ...everySpan(detail.turns),
      ...everySpan(detail.spans),
    ];
    for (const span of everything) {
      expect(Object.keys(span).sort()).toEqual([
        "audio_url",
        "duration_ns",
        "kind",
        "name",
        "parent_span_id",
        "span_id",
        "spans",
        "started_at",
        "status",
        "text",
        "tool_arguments",
        "tool_name",
        "tool_result",
      ]);
    }
  });

  /**
   * **What this exchange measured — the metrics display's read path.**
   *
   * The numbers are not on any row and are not stored: they are computed from
   * the spans this answer already carries, by the same shared measure module the
   * latency grader is judged through. So the figure a page shows and the figure a
   * verdict rests on are one arithmetic, and no page can be the reason somebody
   * distrusts a judgment.
   *
   * The captured exchange emits no timing span of egma's own, and it is
   * measured anyway: the three latencies are **derived** from the shapes the
   * framework itself timed, and each says so. That is the answer to what this
   * read used to return — an empty list, and a latency grader `skipped` on every
   * production conversation a stock agent ever had.
   *
   * The numbers themselves are asserted in
   * `apps/api/test/otlp-derived-measures.test.ts`, against figures hand-computed
   * from the capture's raw timestamps. What is asked here is the read's shape:
   * which measures come back, and that the answer is a present list either way.
   */
  it("answers what the exchange measured, derived from the framework's own timings", async () => {
    const detail = await transcript();

    expect(detail.measures?.map((one) => one.measure)).toEqual([
      "first_response_latency",
      "turn_response_latency",
      "agent_speech_duration",
    ]);
    // Present rather than absent, so a client can tell "nothing was measured"
    // from "this response is an older shape that never said".
    expect(Array.isArray(detail.measures)).toBe(true);
  });
});

/**
 * **What one measure looks like on the wire, field by field.**
 *
 * The acceptance criterion this pins is "simulation traffic is byte-for-byte
 * unchanged", and it is a claim about the serialized object rather than about
 * the arithmetic behind it — so it is asked here, over HTTP, by pinning the
 * keys themselves. A field that appeared on every measure would be a wire
 * change on traffic nothing new happened to, and no assertion about numbers
 * would have noticed.
 *
 * **Its own day, deliberately.** These two traces are written straight into the
 * store, and putting them in the capture's own window would make every other
 * case in this file depend on the order the describes happen to run in.
 */
describe("what one measure looks like on the wire", () => {
  const SIMULATED = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
  const REPORTED = "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b";

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
      connectionType: "livekit",
      runId: "",
      agentId: "",
      agentVersionId: "",
      testVersionId: "",
      personaVersionId: "",
      payload: "{}",
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
    const only = body.measures[0];
    if (only === undefined) throw new Error("the read measured nothing");
    return only;
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
  });

  it("carries no platform field at all on a simulation's own measure", async () => {
    const only = await measureOf(SIMULATED);

    // The exact shape, pinned: a client integrated against this answer sees
    // precisely the fields it always saw.
    expect(Object.keys(only).sort()).toEqual([
      "derived",
      "measure",
      "partial",
      "samples",
      "span_ids",
      "unit",
      "worst",
    ]);
    expect(only.derived).toBe(false);
    // Absent, not empty and not null — there is nothing on the wire to have to
    // interpret.
    expect("reported_by" in only).toBe(false);
  });

  it("adds the platform's name, and only there, on a measure it reported", async () => {
    const only = await measureOf(REPORTED);

    expect(Object.keys(only).sort()).toEqual([
      "derived",
      "measure",
      "partial",
      "reported_by",
      "samples",
      "span_ids",
      "unit",
      "worst",
    ]);
    // `derived` says what it has always said — egma did not time this — and the
    // new field says which of the two untimed sources it was.
    expect(only.derived).toBe(true);
    expect(only.reported_by).toBe("retell");
    expect(only.samples).toEqual([517, 2145]);
    expect(only.worst).toEqual({ value: 2145, span_id: "5200000000000001" });
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
