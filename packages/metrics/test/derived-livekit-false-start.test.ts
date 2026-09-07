import { describe, expect, it } from "vitest";

import { measuresFromSpans, type TraceSpan } from "../src/index.ts";

/**
 * A caller's sentence the transcriber delivered in two pieces, and the reply
 * the second piece cut off.
 *
 * **Found on a live LiveKit call, and by no test before this one.** The caller
 * said one sentence and waited once. The framework committed the first half of
 * it as a turn and began answering; then the rest of the same utterance arrived
 * from the transcriber — after the VAD had already closed the caller's speech —
 * as a second `user_turn` carrying no audio of its own, and it interrupted the
 * reply mid-word. What the agent's spans hold afterwards is a forty-millisecond
 * fragment of speech nobody heard and a turn nobody spoke.
 *
 * Read one human turn at a time, that call answered with two waits: 2000 ms to
 * the fragment, and 2840 ms measured from the second turn's commit instant,
 * which nobody waited from. The caller waited once, for 5178 ms — and egma's
 * own recording of the same wait read 5720 ms, the half-second the two clocks
 * are known to differ by, which is what says 5178 is the wait and the other two
 * numbers are the framework's bookkeeping.
 *
 * The tree below is that exchange to the millisecond: the two spoken bursts of
 * the caller's sentence, the false start with its fragment, the continuation
 * with no speech, a silent tool step, and the turn that actually answered.
 */

/** The call's own beginning, which every offset below is counted from. */
const SESSION_BEGAN = Date.parse("2026-09-04T09:00:00.000Z");

/**
 * An instant this many milliseconds into the call, written the way a trace read
 * answers one: RFC 3339 to the microsecond.
 */
function at(millisecondsIn: number): string {
  return new Date(SESSION_BEGAN + millisecondsIn)
    .toISOString()
    .replace("Z", "000Z");
}

function span(one: {
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  from: number;
  to: number;
  spans?: readonly TraceSpan[];
}): TraceSpan {
  return {
    spanId: one.spanId,
    parentSpanId: one.parentSpanId,
    name: one.name,
    kind: one.kind,
    startedAt: at(one.from),
    durationNanoseconds: String(BigInt(one.to - one.from) * 1_000_000n),
    spans: one.spans ?? [],
  };
}

function theCallWithAFalseStart(): {
  turns: readonly TraceSpan[];
  spans: readonly TraceSpan[];
} {
  return {
    turns: [
      // "Thank you for letting me know!" — two audible bursts, the last of them
      // ending at 50.632, which is where the caller stopped being heard.
      span({
        spanId: "human_utterance",
        parentSpanId: "session",
        name: "user_turn",
        kind: "turn:human",
        from: 41_890,
        to: 51_210,
        spans: [
          span({
            spanId: "human_speech_first",
            parentSpanId: "human_utterance",
            name: "user_speaking",
            kind: "speaking",
            from: 41_890,
            to: 43_080,
          }),
          span({
            spanId: "human_speech_last",
            parentSpanId: "human_utterance",
            name: "user_speaking",
            kind: "speaking",
            from: 43_690,
            to: 50_632,
          }),
        ],
      }),
      // The false start: it began answering the first half and was interrupted
      // twenty milliseconds after its forty-millisecond fragment came out.
      span({
        spanId: "agent_false_start",
        parentSpanId: "session",
        name: "agent_turn",
        kind: "turn:agent",
        from: 44_510,
        to: 52_690,
        spans: [
          span({
            spanId: "false_start_speech",
            parentSpanId: "agent_false_start",
            name: "agent_speaking",
            kind: "speaking",
            from: 52_630,
            to: 52_670,
          }),
        ],
      }),
      // The continuation: the rest of the same sentence, delivered late and
      // with no `user_speaking` child, because the caller was not speaking.
      span({
        spanId: "human_continuation",
        parentSpanId: "session",
        name: "user_turn",
        kind: "turn:human",
        from: 52_670,
        to: 52_970,
      }),
      // A tool-calling step, which says nothing and is part of the wait.
      span({
        spanId: "agent_tool_step",
        parentSpanId: "session",
        name: "agent_turn",
        kind: "turn:agent",
        from: 52_970,
        to: 53_830,
      }),
      // The answer the caller actually heard.
      span({
        spanId: "agent_answer",
        parentSpanId: "session",
        name: "agent_turn",
        kind: "turn:agent",
        from: 53_830,
        to: 67_300,
        spans: [
          span({
            spanId: "answer_speech",
            parentSpanId: "agent_answer",
            name: "agent_speaking",
            kind: "speaking",
            from: 55_810,
            to: 67_300,
          }),
        ],
      }),
    ],
    spans: [
      span({
        spanId: "session",
        parentSpanId: "",
        name: "agent_session",
        kind: "root",
        from: 0,
        to: 70_000,
      }),
    ],
  };
}

/**
 * The same shape on a word-bounded trace: no turn carries speech, and the
 * caller's second turn opens while the agent's is still running — the caller
 * talking over the agent, which on such a trace is their own turn.
 */
function theWordBoundedCallWithABargeIn(): {
  turns: readonly TraceSpan[];
  spans: readonly TraceSpan[];
} {
  return {
    turns: [
      span({
        spanId: "human_first",
        parentSpanId: "session",
        name: "user_turn",
        kind: "turn:human",
        from: 40_000,
        to: 50_000,
      }),
      span({
        spanId: "agent_first",
        parentSpanId: "session",
        name: "agent_turn",
        kind: "turn:agent",
        from: 50_500,
        to: 52_690,
      }),
      span({
        spanId: "human_barge_in",
        parentSpanId: "session",
        name: "user_turn",
        kind: "turn:human",
        from: 52_000,
        to: 52_970,
      }),
      span({
        spanId: "agent_second",
        parentSpanId: "session",
        name: "agent_turn",
        kind: "turn:agent",
        from: 53_500,
        to: 60_000,
      }),
    ],
    spans: [
      span({
        spanId: "session",
        parentSpanId: "",
        name: "call",
        kind: "root",
        from: 0,
        to: 70_000,
      }),
    ],
  };
}

describe("a caller's sentence the transcriber delivered in two pieces", () => {
  it("measures the one wait the caller took, past the reply the second piece cut off", () => {
    const turnLatency = measuresFromSpans(theCallWithAFalseStart()).find(
      (one) => one.measure === "turn_response_latency",
    );

    // The agent's own POV: this conversation carries no timing span of egma's,
    // so the derivation is the only account of it there is.
    expect(turnLatency?.origin).toBe("derived");
    // 55810 − 50632, once. The caller's last audible sample to the first
    // audible sample of the answer, citing the speech the answer came out of.
    expect(turnLatency?.samples).toEqual([
      { value: 5_178, spanId: "answer_speech" },
    ]);
    // Never the fragment: it was cut off, nobody heard it as an answer, and a
    // wait that ends there ends in silence.
    expect(turnLatency?.samples.map((one) => one.spanId)).not.toContain(
      "false_start_speech",
    );
  });

  it("reads no continuation on a word-bounded trace, where a turn opening inside the agent's is the caller talking over it", () => {
    const turnLatency = measuresFromSpans(
      theWordBoundedCallWithABargeIn(),
    ).find((one) => one.measure === "turn_response_latency");

    expect(turnLatency?.samples).toEqual([
      { value: 500, spanId: "agent_first" },
      { value: 530, spanId: "agent_second" },
    ]);
  });
});
