import { describe, expect, it } from "vitest";

import {
  normaliseOtlpExport,
} from "../src/otlp/normalise.ts";
import {
  normaliseRetellCall,
  type RetellCall,
} from "../src/retell/normalise.ts";

const TRACE_START_MILLISECONDS = Date.parse("2026-08-28T06:07:14.143Z");
const RETELL_INTO = {
  projectId: "prj_tool_timeline",
  environment: "production",
  platformAgentId: "retell_agent_1",
  platformAgentName: "Front desk",
  platformAgentVersion: "1",
} as const;

/** The non-secret event shape observed in local trace 5e05...cf0a. */
function retellCallWithToolBeforeReply(): RetellCall {
  return {
    call_id: "call_tool_timeline",
    call_status: "ended",
    start_timestamp: TRACE_START_MILLISECONDS,
    end_timestamp: TRACE_START_MILLISECONDS + 56_124,
    tool_calls: [
      {
        tool_call_id: "call_tool_1",
        start_time_sec: 37.362,
        latency_ms: 531,
        success: true,
      },
    ],
    transcript_with_tool_calls: [
      {
        role: "user",
        content: "Find an appointment.",
        words: [{ word: "appointment", start: 33.649, end: 35.969 }],
      },
      {
        role: "tool_call_invocation",
        tool_call_id: "call_tool_1",
        name: "get_availability",
        arguments: "{}",
        time_sec: 37.362,
      },
      {
        role: "tool_call_result",
        tool_call_id: "call_tool_1",
        content: "{}",
        successful: true,
        time_sec: 37.893,
      },
      {
        role: "agent",
        content: "I found an opening.",
        words: [{ word: "I", start: 39.606, end: 40.1 }],
      },
    ],
  };
}

describe("tool-call timing and ownership at the provider doors", () => {
  it("uses Retell's measured tool interval and the following agent turn", () => {
    const normalised = normaliseRetellCall(
      retellCallWithToolBeforeReply(),
      RETELL_INTO,
      TRACE_START_MILLISECONDS + 60_000,
    );
    const root = normalised.spans.find((span) => span.parentSpanId === "");
    const agentTurns = normalised.spans.filter(
      (span) => span.kind === "turn:agent",
    );
    const invokingTurn = agentTurns.at(-1);
    const tool = normalised.spans.find((span) => span.kind === "tool");

    expect(root).toBeDefined();
    expect(invokingTurn).toBeDefined();
    expect(tool).toMatchObject({
      agentPlatform: "retell",
      parentSpanId: invokingTurn?.spanId,
      startedAtMicroseconds:
        (root?.startedAtMicroseconds ?? 0n) + 37_362_000n,
      durationNanoseconds: 531_000_000n,
      toolName: "get_availability",
    });
    expect(
      (tool?.startedAtMicroseconds ?? 0n) -
        (root?.startedAtMicroseconds ?? 0n),
    ).toBe(37_362_000n);
  });

  it.each([
    {
      timing: "summary start and latency",
      invocationTime: undefined,
      resultTime: undefined,
      summaryStart: 12.25,
      summaryLatency: 250,
      expectedDuration: 250_000_000n,
    },
    {
      timing: "invocation-result interval when summary latency is invalid",
      invocationTime: 12.25,
      resultTime: 12.625,
      summaryStart: 12.25,
      summaryLatency: -1,
      expectedDuration: 375_000_000n,
    },
  ])(
    "uses Retell's $timing",
    ({
      invocationTime,
      resultTime,
      summaryStart,
      summaryLatency,
      expectedDuration,
    }) => {
      const normalised = normaliseRetellCall(
        {
          call_id: "call_tool_fallback",
          call_status: "ended",
          start_timestamp: TRACE_START_MILLISECONDS,
          end_timestamp: TRACE_START_MILLISECONDS + 20_000,
          tool_calls: [
            {
              tool_call_id: "call_tool_fallback_1",
              start_time_sec: summaryStart,
              latency_ms: summaryLatency,
              success: true,
            },
          ],
          transcript_with_tool_calls: [
            {
              role: "agent",
              content: "I will check.",
              words: [{ word: "check", start: 10, end: 10.2 }],
            },
            {
              role: "tool_call_invocation",
              tool_call_id: "call_tool_fallback_1",
              name: "get_availability",
              arguments: "{}",
              ...(invocationTime === undefined
                ? {}
                : { time_sec: invocationTime }),
            },
            {
              role: "tool_call_result",
              tool_call_id: "call_tool_fallback_1",
              content: "{}",
              successful: true,
              ...(resultTime === undefined ? {} : { time_sec: resultTime }),
            },
          ],
        },
        RETELL_INTO,
        TRACE_START_MILLISECONDS + 21_000,
      );
      const root = normalised.spans.find((span) => span.parentSpanId === "");
      const tool = normalised.spans.find((span) => span.kind === "tool");

      expect(
        (tool?.startedAtMicroseconds ?? 0n) -
          (root?.startedAtMicroseconds ?? 0n),
      ).toBe(12_250_000n);
      expect(tool?.durationNanoseconds).toBe(expectedDuration);
    },
  );

  it("preserves an OTLP tool span's measured offset and invoking agent parent", () => {
    const traceId = "112233445566778899aabbccddeeff00";
    const rootId = "0011223344556677";
    const agentTurnId = "1122334455667788";
    const toolId = "2233445566778899";
    const traceStartNanoseconds = 1_785_920_400_000_000_000n;
    const normalised = normaliseOtlpExport({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "livekit-agents" },
              spans: [
                {
                  traceId,
                  spanId: rootId,
                  name: "agent_session",
                  startTimeUnixNano: traceStartNanoseconds.toString(),
                  endTimeUnixNano: (traceStartNanoseconds + 10_000_000_000n)
                    .toString(),
                },
                {
                  traceId,
                  spanId: agentTurnId,
                  parentSpanId: rootId,
                  name: "agent_turn",
                  startTimeUnixNano: (traceStartNanoseconds + 4_000_000_000n)
                    .toString(),
                  endTimeUnixNano: (traceStartNanoseconds + 8_000_000_000n)
                    .toString(),
                },
                {
                  traceId,
                  spanId: toolId,
                  parentSpanId: agentTurnId,
                  name: "function_tool",
                  startTimeUnixNano: (traceStartNanoseconds + 6_000_000_000n)
                    .toString(),
                  endTimeUnixNano: (traceStartNanoseconds + 6_250_000_000n)
                    .toString(),
                },
              ],
            },
          ],
        },
      ],
    });
    const root = normalised.spans.find((span) => span.spanId === rootId);
    const tool = normalised.spans.find((span) => span.spanId === toolId);

    expect(normalised.rejected).toEqual([]);
    expect(tool).toMatchObject({
      agentPlatform: "livekit",
      kind: "tool",
      parentSpanId: agentTurnId,
      startedAtMicroseconds: 1_785_920_406_000_000n,
    });
    expect(
      (tool?.startedAtMicroseconds ?? 0n) -
        (root?.startedAtMicroseconds ?? 0n),
    ).toBe(6_000_000n);
  });
});
