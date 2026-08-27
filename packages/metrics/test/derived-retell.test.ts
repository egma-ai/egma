import { describe, expect, it } from "vitest";

import {
  measuresFromSpans,
  turnResponseLatencySpanKinds,
  type TraceSpan,
} from "../src/index.ts";

/**
 * The Retell derivations, pinned to the live validation of 2026-08-22.
 *
 * A word-bounded Retell conversation carries turns with real timestamps and a
 * root filed as `conversation` — not `root` — so this file is the proof of the
 * two rules that made its latencies computable: the root is recognised by its
 * empty parent, never by a kind word, and a turn with no `speaking` children
 * measures from its own bounds. The shape below is the captured call
 * `call_72ecf…` in miniature: the derived gaps matched Retell's own reported
 * `e2e` exactly where both measured, and caught an answered turn its list
 * missed — which is why the derivation outranks the reported block.
 */

const STARTED = "2026-08-22T10:00:00.000000Z";

it("owns the store projection needed for turn-response latency", () => {
  expect(turnResponseLatencySpanKinds()).toEqual([
    "timing",
    "turn:human",
    "turn:agent",
    "speaking",
  ]);
});

function at(secondsIn: number): string {
  const base = Date.parse("2026-08-22T10:00:00.000Z");
  const instant = new Date(base + Math.round(secondsIn * 1000));
  return instant.toISOString().replace("Z", "000Z").replace(".", ".");
}

function span(partial: {
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  startedAt: string;
  seconds: number;
  spans?: readonly TraceSpan[];
}): TraceSpan {
  return {
    spanId: partial.spanId,
    parentSpanId: partial.parentSpanId,
    name: partial.name,
    kind: partial.kind,
    startedAt: partial.startedAt,
    durationNanoseconds: String(BigInt(Math.round(partial.seconds * 1000)) * 1_000_000n),
    spans: partial.spans ?? [],
  };
}

/** The captured call's shape: word-bounded turns under a `conversation` root. */
function wordBoundedCall(): {
  turns: readonly TraceSpan[];
  spans: readonly TraceSpan[];
} {
  return {
    turns: [
      // agent opening at 1.247s, then three answered exchanges.
      span({ spanId: "t0", parentSpanId: "root", name: "agent_turn", kind: "turn:agent", startedAt: at(1.247), seconds: 16.288 }),
      span({ spanId: "t1", parentSpanId: "root", name: "human_turn", kind: "turn:human", startedAt: at(22.764), seconds: 7.467 }),
      span({ spanId: "t2", parentSpanId: "root", name: "agent_turn", kind: "turn:agent", startedAt: at(32.449), seconds: 5.93 }),
      span({ spanId: "t3", parentSpanId: "root", name: "human_turn", kind: "turn:human", startedAt: at(42.284), seconds: 4.912 }),
      span({ spanId: "t4", parentSpanId: "root", name: "agent_turn", kind: "turn:agent", startedAt: at(49.753), seconds: 10.0 }),
      span({ spanId: "t5", parentSpanId: "root", name: "human_turn", kind: "turn:human", startedAt: at(64.908), seconds: 6.066 }),
      span({ spanId: "t6", parentSpanId: "root", name: "agent_turn", kind: "turn:agent", startedAt: at(74.299), seconds: 5.159 }),
    ],
    spans: [
      span({ spanId: "root", parentSpanId: "", name: "retell_call", kind: "conversation", startedAt: STARTED, seconds: 80 }),
    ],
  };
}

describe("a word-bounded Retell conversation", () => {
  it("derives each answered turn's wait, matching the platform's own ruler", () => {
    const measured = measuresFromSpans(wordBoundedCall());
    const turnLatency = measured.find(
      (one) => one.measure === "turn_response_latency",
    );

    // 32.449-30.231, 49.753-47.196, 74.299-70.974 — the first two are exactly
    // Retell's own reported e2e values; the third is the answered turn its
    // list missed.
    expect(turnLatency?.samples.map((sample) => sample.value)).toEqual([
      2218, 2557, 3325,
    ]);
    expect(turnLatency?.origin).toBe("derived");
  });

  it("derives the first response from the parentless root, whatever kind word its platform used", () => {
    const measured = measuresFromSpans(wordBoundedCall());
    const first = measured.find(
      (one) => one.measure === "first_response_latency",
    );

    // The root is kind `conversation`; only its empty parent names it. The
    // first agent turn has no speaking children, so its own word-bounded start
    // is the first word.
    expect(first?.samples).toEqual([{ value: 1247, spanId: "t0" }]);
    expect(first?.origin).toBe("derived");
  });

  it("outranks the reported block where both can answer", () => {
    const conversation = {
      ...wordBoundedCall(),
      reported: {
        spanId: "root",
        reportedBy: "retell",
        measurements: [
          {
            measure: "turn_response_latency",
            unit: "milliseconds",
            values: [2218, 2557],
          },
        ],
      },
    };
    const turnLatency = measuresFromSpans(conversation).find(
      (one) => one.measure === "turn_response_latency",
    );

    expect(turnLatency?.origin).toBe("derived");
    expect(turnLatency?.samples).toHaveLength(3);
  });
});

describe("a placeholder Retell conversation (no word bounds)", () => {
  /** Every turn opened at the trace's own start with zero width — the stored
   * shape of calls ingested before the normalizer read word bounds. */
  function placeholderCall() {
    return {
      turns: ["turn:agent", "turn:human", "turn:agent"].map((kind, index) =>
        span({
          spanId: `p${String(index)}`,
          parentSpanId: "root",
          name: kind === "turn:human" ? "human_turn" : "agent_turn",
          kind,
          startedAt: STARTED,
          seconds: 0,
        }),
      ),
      spans: [
        span({ spanId: "root", parentSpanId: "", name: "retell_call", kind: "conversation", startedAt: STARTED, seconds: 80 }),
      ],
      reported: {
        spanId: "root",
        reportedBy: "retell",
        measurements: [
          {
            measure: "turn_response_latency",
            unit: "milliseconds",
            values: [517, 2145],
          },
        ],
      },
    };
  }

  it("derives nothing from the placeholders and answers from the reported block", () => {
    const measured = measuresFromSpans(placeholderCall());
    const turnLatency = measured.find(
      (one) => one.measure === "turn_response_latency",
    );
    const first = measured.find(
      (one) => one.measure === "first_response_latency",
    );

    expect(turnLatency?.origin).toBe("reported");
    expect(turnLatency?.samples.map((sample) => sample.value)).toEqual([
      517, 2145,
    ]);
    // A zero-width first agent turn is a placeholder, not a first word.
    expect(first).toBeUndefined();
  });
});
