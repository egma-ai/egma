import { REPORTED_MEASUREMENTS_VERSION } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  normaliseRetellCall,
  traceIdFor,
  type RetellCall,
} from "../src/retell/normalise.ts";

/**
 * The normalizer, from captured payloads and nothing else.
 *
 * No stores, no keys, no network: one Retell call object in, the settled span
 * shape out. A replay after a crash re-normalises the payload on the claim, and
 * it has to keep the same rows and block boundaries so ClickHouse sees a
 * byte-identical recent block.
 */

const FILED_INTO = {
  connectionId: "con_01K3XQ7M4E8YB2FVN0H9TZQWER",
  connectionType: "retell",
  agentId: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER",
  environment: "production",
} as const;

/**
 * A Retell call object as their documentation shapes one, trimmed to the
 * fields egma reads plus a few it does not — because the ones it does not read
 * are exactly what "kept verbatim" has to be checked against.
 */
export function capturedCall(overrides: Partial<RetellCall> = {}): RetellCall {
  return {
    call_id: "call_a1b2c3d4e5f6",
    call_type: "phone_call",
    agent_id: "agent_in_retell_1",
    call_status: "ended",
    start_timestamp: 1_786_000_000_000,
    end_timestamp: 1_786_000_074_000,
    disconnection_reason: "agent_hangup",
    recording_url: "https://recordings.retellai.com/call_a1b2c3d4e5f6.wav",
    transcript: "Agent: Hello. User: I would like to reschedule.",
    transcript_object: [
      { role: "agent", content: "Hello, front desk.", words: [] },
      { role: "user", content: "I would like to reschedule Tuesday.", words: [] },
      {
        role: "agent",
        content: "Let me check the calendar.",
        words: [],
        tool_calls: [
          {
            id: "tool_1",
            function: {
              name: "check_calendar",
              arguments: '{"day":"tuesday"}',
            },
            result: '{"slots":["10:00","14:00"]}',
          },
        ],
      },
    ],
    // One object per stage, as Retell's documentation shapes one: the summary
    // it worked out, and `values`, the individual measurements it worked the
    // summary out from. This is the documented shape and not a captured
    // payload — no live Retell document is checked in yet — so the stage names
    // are held here to be settled by the next live capture. The 2145 ms sample
    // is the live proof's own reading: the turn that beat a two-second bound
    // with no verdict to say so.
    latency: {
      e2e: {
        p50: 820,
        p90: 2010,
        p95: 2100,
        p99: 2140,
        max: 2145,
        min: 517,
        num: 4,
        values: [517, 820, 1704, 2145],
      },
      llm: {
        p50: 410,
        p90: 700,
        max: 780,
        min: 260,
        num: 4,
        values: [260, 410, 700, 780],
      },
      tts: {
        p50: 190,
        p90: 250,
        max: 260,
        min: 150,
        num: 4,
        values: [150, 190, 240, 260],
      },
      asr: {
        p50: 90,
        p90: 145,
        max: 150,
        min: 70,
        num: 4,
        values: [70, 90, 140, 150],
      },
      knowledge_base: {
        p50: 300,
        p90: 370,
        max: 380,
        min: 280,
        num: 3,
        values: [280, 300, 380],
      },
      // A stage egma maps to nothing. It stays in the verbatim payload and out
      // of the block, which is what "only the mapped stages" has to be checked
      // against.
      llm_websocket_network_rtt: {
        p50: 40,
        max: 61,
        min: 22,
        num: 3,
        values: [22, 40, 61],
      },
    },
    // Nothing reads this. That is the point of the verbatim rule.
    call_analysis: { user_sentiment: "Positive", call_successful: true },
    ...overrides,
  };
}

const NOW = 1_786_000_100_000;

/** A batch as bytes, with the bigints written out — which is what `appendSpans` does. */
function asBytes(spans: readonly unknown[]): string {
  return JSON.stringify(spans, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

describe("the trace identity", () => {
  it("is the same twice for the same call on the same connection", () => {
    const once = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
    const again = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);

    expect(once.traceId).toBe(again.traceId);
    expect(once.spans.map((span) => span.spanId)).toEqual(
      again.spans.map((span) => span.spanId),
    );
    // Byte-identical, which is the property a replay after a crash needs for
    // the store's recent-block backstop.
    expect(asBytes(once.spans)).toBe(asBytes(again.spans));
  });

  it("is the shape every trace id in this store has", () => {
    const { traceId } = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("differs per connection, so one agent in two projects never collides", () => {
    const here = traceIdFor("con_one", "call_a1b2c3d4e5f6");
    const there = traceIdFor("con_two", "call_a1b2c3d4e5f6");
    expect(here).not.toBe(there);
  });
});

describe("the spans a captured payload becomes", () => {
  const normalised = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
  const root = normalised.spans[0];
  const turns = normalised.spans.filter((span) => span.kind.startsWith("turn:"));
  const tools = normalised.spans.filter((span) => span.kind === "tool");

  it("opens with a root span nothing is the parent of", () => {
    expect(root?.parentSpanId).toBe("");
    expect(root?.kind).toBe("conversation");
    expect(root?.status).toBe("ok");
  });

  it("files them as production traffic the agent emitted", () => {
    for (const span of normalised.spans) {
      expect(span.source).toBe("production");
      expect(span.emitter).toBe("agent");
      expect(span.environment).toBe("production");
      expect(span.connectionType).toBe("retell");
      expect(span.agentId).toBe(FILED_INTO.agentId);
      // The join across an audio channel, on every row.
      expect(span.providerCallId).toBe("call_a1b2c3d4e5f6");
      // Nothing about a simulation is claimed by a production trace.
      expect(span.runId).toBe("");
      expect(span.testVersionId).toBe("");
      expect(span.personaVersionId).toBe("");
    }
  });

  it("takes the turns from the transcript and nothing else", () => {
    expect(turns.map((turn) => turn.kind)).toEqual([
      "turn:agent",
      "turn:human",
      "turn:agent",
    ]);
    expect(turns[1]?.text).toBe("I would like to reschedule Tuesday.");
  });

  it("carries the agent's tool call inside the turn it happened in", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolName).toBe("check_calendar");
    expect(tools[0]?.toolArguments).toBe('{"day":"tuesday"}');
    expect(tools[0]?.toolResult).toBe('{"slots":["10:00","14:00"]}');
    expect(tools[0]?.parentSpanId).toBe(turns[2]?.spanId);
  });

  it("synthesises no per-turn timing, because Retell reports none", () => {
    // Every turn opens where the conversation opened and claims no duration.
    // A number divided out of the total would look measured and would not be.
    for (const turn of turns) {
      expect(turn.startedAtMicroseconds).toBe(root?.startedAtMicroseconds);
      expect(turn.durationNanoseconds).toBe(0n);
    }
  });

  it("puts the aggregates and the ending reason on the root and nowhere else", () => {
    expect(root?.text).toBe("agent_hangup");
    const held = JSON.parse(root?.payload ?? "{}") as Record<string, unknown>;
    const normalisedBlock = held["egma_normalised"] as Record<string, unknown>;
    // Retell's own latency object, under Retell's own names, untouched — the
    // summary included, because a reader who knows Retell looks for it here,
    // and the stages egma maps to nothing included for the same reason.
    const latency = normalisedBlock["latency"] as Record<string, unknown>;
    expect(latency["e2e"]).toEqual({
      p50: 820,
      p90: 2010,
      p95: 2100,
      p99: 2140,
      max: 2145,
      min: 517,
      num: 4,
      values: [517, 820, 1704, 2145],
    });
    expect(latency["llm_websocket_network_rtt"]).toEqual({
      p50: 40,
      max: 61,
      min: 22,
      num: 3,
      values: [22, 40, 61],
    });
    expect(Object.keys(latency)).toEqual([
      "e2e",
      "llm",
      "tts",
      "asr",
      "knowledge_base",
      "llm_websocket_network_rtt",
    ]);
    // The whole conversation's extent, from Retell's own two instants.
    expect(root?.durationNanoseconds).toBe(74_000n * 1_000_000n);
  });

  it("stores the recording as the audio reference and copies no audio", () => {
    expect(root?.audioUrl).toBe(
      "https://recordings.retellai.com/call_a1b2c3d4e5f6.wav",
    );
  });

  it("keeps the vendor payload verbatim, fields egma never reads included", () => {
    const held = JSON.parse(root?.payload ?? "{}") as Record<string, unknown>;
    expect(held["call_analysis"]).toEqual({
      user_sentiment: "Positive",
      call_successful: true,
    });
    expect(held["call_type"]).toBe("phone_call");
    expect(held["transcript"]).toBe(
      "Agent: Hello. User: I would like to reschedule.",
    );
  });
});

/** The egma-owned corner of the root span's payload, as a reader holds it. */
function normalisedCornerOf(call: RetellCall): Record<string, unknown> {
  const [root] = normaliseRetellCall(call, FILED_INTO, NOW).spans;
  const payload = JSON.parse(root?.payload ?? "{}") as Record<string, unknown>;
  return payload["egma_normalised"] as Record<string, unknown>;
}

/**
 * What Retell measured, translated into egma's own vocabulary at the door.
 *
 * This file is the only code in egma that knows Retell's latency shape, so this
 * is the only place that translation can be proved — a reader downstream will
 * meet the neutral block alone, and would meet the identical one from any
 * platform.
 */
describe("the reported-measurements block", () => {
  it("maps each stage Retell reports to the measure it means", () => {
    expect(normalisedCornerOf(capturedCall())["reported_measurements"]).toEqual({
      version: REPORTED_MEASUREMENTS_VERSION,
      reported_by: "retell",
      measurements: [
        {
          // Retell's `e2e` is what the catalog calls `turn_response_latency`:
          // same meaning, same name, so the day the measure module reads this
          // block, the latency grader a developer already configured judges
          // this trace with nothing reconfigured.
          measure: "turn_response_latency",
          // The catalog's own unit for that measure, not a word chosen here.
          unit: "milliseconds",
          values: [517, 820, 1704, 2145],
        },
        {
          measure: "retell/llm_latency",
          unit: "milliseconds",
          values: [260, 410, 700, 780],
        },
        {
          measure: "retell/tts_latency",
          unit: "milliseconds",
          values: [150, 190, 240, 260],
        },
        {
          measure: "retell/asr_latency",
          unit: "milliseconds",
          values: [70, 90, 140, 150],
        },
        {
          measure: "retell/knowledge_base_latency",
          unit: "milliseconds",
          values: [280, 300, 380],
        },
      ],
    });
  });

  it("names the reporter exactly as the row names the platform", () => {
    const { spans } = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
    const block = normalisedCornerOf(capturedCall())["reported_measurements"] as {
      reported_by: string;
    };
    // Provenance, and the word a rationale will print: one spelling of this
    // platform, on the block and on the row it rides alike.
    expect(block.reported_by).toBe(spans[0]?.connectionType);
  });

  it("carries the measurements, and leaves the summary to the vendor's own block", () => {
    const corner = normalisedCornerOf(capturedCall());
    const block = corner["reported_measurements"] as {
      measurements: readonly { measure: string; values: readonly number[] }[];
    };
    // The individual measurements — never a p50 wearing a sample's clothes,
    // which would let one summarised turn pass a bound a real turn failed.
    expect(block.measurements[0]?.values).toEqual([517, 820, 1704, 2145]);
    // And Retell's own aggregates are still there, under Retell's own names.
    expect((corner["latency"] as Record<string, unknown>)["e2e"]).toEqual(
      (capturedCall()["latency"] as Record<string, unknown>)["e2e"],
    );
  });

  it("writes nothing at all where Retell measured nothing", () => {
    for (const latency of [
      undefined,
      {},
      "sometimes a payload is not the shape it was",
      { e2e: null },
      // A summary with no measurements under it. The percentiles are Retell's own
      // arithmetic, and egma reports no measurement it was not handed.
      { e2e: { p50: 820, p90: 2010, num: 4 } },
      { e2e: { values: [] } },
      { e2e: { values: "1704" } },
      { e2e: { values: [null, "1704"] } },
      // A stage nothing maps to, alone, is a stage nobody reported.
      { llm_websocket_network_rtt: { values: [22, 40, 61] } },
    ]) {
      const corner = normalisedCornerOf(capturedCall({ latency }));
      expect(
        Object.hasOwn(corner, "reported_measurements"),
        JSON.stringify(latency),
      ).toBe(false);
      // The vendor's own key stays exactly where it was, empty object and all.
      expect(Object.hasOwn(corner, "latency")).toBe(true);
    }
  });

  it("keeps the numbers Retell reported and drops what is not one", () => {
    const corner = normalisedCornerOf(
      capturedCall({
        latency: { e2e: { values: [517, "1704", null, 2145, Number.NaN] } },
      }),
    );
    expect(corner["reported_measurements"]).toEqual({
      version: REPORTED_MEASUREMENTS_VERSION,
      reported_by: "retell",
      measurements: [
        {
          measure: "turn_response_latency",
          unit: "milliseconds",
          values: [517, 2145],
        },
      ],
    });
  });

  it("is the same bytes twice, which is what a replay rests on", () => {
    const once = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
    const again = normaliseRetellCall(capturedCall(), FILED_INTO, NOW);
    // The root payload holds the block, so its own bytes are the property the
    // store's insert dedup recognises a replayed batch by. The whole batch's
    // bytes are the identity suite's own check, above.
    expect(once.spans[0]?.payload).toBe(again.spans[0]?.payload);
  });
});

describe("a payload the normalizer cannot fully read", () => {
  it("still becomes a trace, flagged, with the payload intact", () => {
    const broken = normaliseRetellCall(
      {
        call_id: "call_broken",
        agent_id: "agent_in_retell_1",
        end_timestamp: 1_786_000_074_000,
        // Not a list of turns at all.
        transcript_object: "Agent: Hello.",
        something_new: { egma: "has no place for this yet" },
      },
      FILED_INTO,
      NOW,
    );

    expect(broken.degraded).toBe(true);
    expect(broken.spans).toHaveLength(1);
    expect(broken.spans[0]?.status).toBe("error");
    const held = JSON.parse(broken.spans[0]?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(held["something_new"]).toEqual({
      egma: "has no place for this yet",
    });
    expect(held["transcript_object"]).toBe("Agent: Hello.");
  });

  it("normalises against the clock it is handed, so a replay repeats it", () => {
    const nothing = { call_id: "call_timeless", agent_id: "agent_in_retell_1" };
    const first = normaliseRetellCall(nothing, FILED_INTO, NOW);
    // A replay hands the claim's own `ended_at` back as the clock, which is
    // what the first pass wrote — so the second batch is the first batch.
    const replayed = normaliseRetellCall(
      nothing,
      FILED_INTO,
      first.endedAt.getTime(),
    );
    expect(asBytes(replayed.spans)).toBe(asBytes(first.spans));
  });

  it("never claims a negative duration when the clock disagrees with itself", () => {
    // End before start. The duration column is unsigned, so a negative one is
    // not a bad number — it is an append the store refuses, a claim left
    // unwritten, and a replay that fails identically on every tick for ever.
    const skewed = normaliseRetellCall(
      capturedCall({
        start_timestamp: 1_786_000_074_000,
        end_timestamp: 1_786_000_000_000,
      }),
      FILED_INTO,
      NOW,
    );

    expect(skewed.degraded).toBe(true);
    expect(skewed.spans[0]?.durationNanoseconds).toBe(0n);
    // Filed at the instant the provider called the end, and both original
    // timestamps are still in the payload underneath.
    expect(skewed.endedAt.getTime()).toBe(1_786_000_000_000);
    const held = JSON.parse(skewed.spans[0]?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(held["start_timestamp"]).toBe(1_786_000_074_000);
    // The provider did report an end, contradictory or not, so the cursor is
    // allowed to believe this one.
    expect(skewed.endReported).toBe(true);
  });

  it("says when an end is egma's stand-in rather than the provider's answer", () => {
    // The case the cursor must not believe: no end at all, so the instant is
    // the wall clock, and honouring it would carry the cursor to now and drop
    // everything a sweep had not yet drained.
    const timeless = normaliseRetellCall(
      { call_id: "call_timeless", agent_id: "agent_in_retell_1" },
      FILED_INTO,
      NOW,
    );
    expect(timeless.endReported).toBe(false);
    expect(timeless.endedAt.getTime()).toBe(NOW);

    // A start and no end is still nobody's reported end, but it is at least an
    // instant the provider named, so nothing is invented.
    const started = normaliseRetellCall(
      {
        call_id: "call_open",
        agent_id: "agent_in_retell_1",
        start_timestamp: 1_786_000_000_000,
      },
      FILED_INTO,
      NOW,
    );
    expect(started.endReported).toBe(false);
    expect(started.endedAt.getTime()).toBe(1_786_000_000_000);
    expect(started.spans[0]?.durationNanoseconds).toBe(0n);

    // And an ordinary conversation is the provider's own answer.
    expect(normaliseRetellCall(capturedCall(), FILED_INTO, NOW).endReported).toBe(
      true,
    );
  });

  it("is not degraded merely for having said nothing", () => {
    const quiet = normaliseRetellCall(
      {
        call_id: "call_quiet",
        agent_id: "agent_in_retell_1",
        start_timestamp: 1_786_000_000_000,
        end_timestamp: 1_786_000_001_000,
      },
      FILED_INTO,
      NOW,
    );
    expect(quiet.degraded).toBe(false);
    expect(quiet.spans).toHaveLength(1);
  });
});
