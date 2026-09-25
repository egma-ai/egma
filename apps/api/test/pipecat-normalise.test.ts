import { describe, expect, it } from "vitest";

import type { OtlpAttribute, OtlpSpan } from "../src/otlp/decode.ts";
import { normaliseOtlpExport } from "../src/otlp/normalise.ts";

/**
 * The `egma.pipecat` scope the egma SDK's Pipecat observer writes, mapped onto
 * the kinds every reader already reads for LiveKit.
 */

const TRACE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const START = 1_790_000_000_000_000_000n;
const ROOT = "a000000000000001";
const AGENT_TURN = "a000000000000003";

function attributes(
  values: Readonly<Record<string, string | boolean>>,
): OtlpAttribute[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "boolean" ? { boolValue: value } : { stringValue: value },
  }));
}

function span(
  spanId: string,
  name: string,
  parentSpanId: string,
  values: Readonly<Record<string, string | boolean>> = {},
  status?: OtlpSpan["status"],
): OtlpSpan {
  return {
    traceId: TRACE_ID,
    spanId,
    ...(parentSpanId === "" ? {} : { parentSpanId }),
    name,
    startTimeUnixNano: START.toString(),
    endTimeUnixNano: (START + 1_000_000_000n).toString(),
    attributes: attributes(values),
    ...(status === undefined ? {} : { status }),
  };
}

function normalisedPipecat(
  spans: OtlpSpan[],
  resource: Readonly<Record<string, string>> = { "service.name": "pipecat" },
) {
  return normaliseOtlpExport({
    resourceSpans: [
      {
        resource: { attributes: attributes(resource) },
        scopeSpans: [{ scope: { name: "egma.pipecat", version: "0.4.0" }, spans }],
      },
    ],
  });
}

describe("the egma.pipecat scope", () => {
  it("maps every span name in the vocabulary onto the shared kinds", () => {
    const result = normalisedPipecat([
      span(ROOT, "pipecat_session", "", {
        "egma.pipecat.version": "1.11.0",
        "egma.pipecat.transport": "daily",
      }),
      span("a000000000000002", "user_turn", ROOT, { "egma.turn.text": "Is Saturday open?" }),
      span(AGENT_TURN, "agent_turn", ROOT, { "egma.turn.text": "We open at nine." }),
      span("a000000000000004", "function_call", AGENT_TURN, {
        "egma.tool.name": "check_calendar",
        "egma.tool.call_id": "call_1",
        "egma.tool.arguments": '{"day":"2026-08-13"}',
        "egma.tool.result": '{"slots":[]}',
      }),
      span("a000000000000005", "user_speaking", "a000000000000002"),
      span("a000000000000006", "agent_speaking", AGENT_TURN),
      span("a000000000000007", "llm_generation", AGENT_TURN),
      span("a000000000000008", "tts_synthesis", AGENT_TURN),
      span("a000000000000009", "something_new", ROOT),
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.spans.map((one) => [one.name, one.kind])).toEqual([
      ["pipecat_session", "root"],
      ["user_turn", "turn:human"],
      ["agent_turn", "turn:agent"],
      ["function_call", "tool"],
      ["user_speaking", "speaking"],
      ["agent_speaking", "speaking"],
      ["llm_generation", "model"],
      ["tts_synthesis", "tts"],
      ["something_new", "other"],
    ]);
    expect(result.spans.every((one) => one.agentPlatform === "pipecat")).toBe(true);
  });

  it("reads each turn's words from egma.turn.text", () => {
    const result = normalisedPipecat([
      span("a000000000000002", "user_turn", ROOT, { "egma.turn.text": "Is Saturday open?" }),
      span(AGENT_TURN, "agent_turn", ROOT, {
        "egma.turn.text": "We open at nine.",
        "egma.turn.interrupted": true,
      }),
    ]);

    expect(result.spans.map((one) => [one.kind, one.text])).toEqual([
      ["turn:human", "Is Saturday open?"],
      ["turn:agent", "We open at nine."],
    ]);
  });

  it("keeps a turn with no words off the spoken transcript, as LiveKit's", () => {
    const result = normalisedPipecat([
      span(AGENT_TURN, "agent_turn", ROOT),
      span("a000000000000004", "function_call", AGENT_TURN, {
        "egma.tool.name": "check_calendar",
        "egma.tool.arguments": "{}",
        "egma.tool.result": '{"slots":[]}',
      }),
    ]);

    expect(result.spans.map((one) => [one.name, one.kind])).toEqual([
      ["agent_turn", "other"],
      ["function_call", "tool"],
    ]);
  });

  it("lifts a tool call's name, arguments and result into columns", () => {
    const result = normalisedPipecat([
      span("a000000000000004", "function_call", AGENT_TURN, {
        "egma.tool.name": "check_calendar",
        "egma.tool.call_id": "call_1",
        "egma.tool.arguments": '{"day":"2026-08-13"}',
        "egma.tool.result": '{"slots":[]}',
      }),
    ]);

    expect(result.spans[0]).toMatchObject({
      kind: "tool",
      status: "unset",
      toolName: "check_calendar",
      toolArguments: '{"day":"2026-08-13"}',
      toolResult: '{"slots":[]}',
    });
  });

  it("files a failed tool call's error as its result, with an error status", () => {
    const result = normalisedPipecat([
      span(
        "a000000000000004",
        "function_call",
        AGENT_TURN,
        {
          "egma.tool.name": "check_calendar",
          "egma.tool.arguments": "{}",
          "egma.tool.error":
            'Egma could not answer the mocked tool "check_calendar": timed out. The real tool did not run.',
        },
        { code: "STATUS_CODE_ERROR" },
      ),
    ]);

    expect(result.spans[0]).toMatchObject({
      kind: "tool",
      status: "error",
      toolName: "check_calendar",
      toolResult:
        'Egma could not answer the mocked tool "check_calendar": timed out. The real tool did not run.',
    });
  });

  it("ends a production trace on the root, and on nothing else", () => {
    const result = normalisedPipecat(
      [
        span(AGENT_TURN, "agent_turn", ROOT, { "egma.turn.text": "Goodbye." }),
        span(ROOT, "pipecat_session", ""),
      ],
      { "service.name": "pipecat", "session.id": "3f7c9a8e-session" },
    );

    expect(result.spans.map((one) => [one.name, one.endsTrace])).toEqual([
      ["agent_turn", false],
      ["pipecat_session", true],
    ]);
    expect(result.spans.every((one) => one.source === "production")).toBe(true);
    expect(result.spans.every((one) => one.providerCallId === "3f7c9a8e-session")).toBe(true);
  });

  it("reads Pipecat names under no other scope", () => {
    const result = normaliseOtlpExport({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "somebody-else" },
              spans: [
                span(ROOT, "pipecat_session", ""),
                span("a000000000000004", "function_call", ROOT, {
                  "egma.tool.name": "check_calendar",
                }),
              ],
            },
          ],
        },
      ],
    });

    expect(result.spans.map((one) => [one.kind, one.agentPlatform, one.endsTrace, one.toolName])).toEqual([
      ["other", "", false, ""],
      ["other", "", false, ""],
    ]);
  });
});
