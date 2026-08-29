import { describe, expect, it } from "vitest";

import type { OtlpAttribute, OtlpSpan } from "../src/otlp/decode.ts";
import { normaliseOtlpExport } from "../src/otlp/normalise.ts";

const TRACE_ID = "11223344556677889900aabbccddeeff";
const START = 1_785_920_400_000_000_000n;

function attributes(values: Readonly<Record<string, string>>): OtlpAttribute[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function span(
  spanId: string,
  name: string,
  values: Readonly<Record<string, string>>,
): OtlpSpan {
  return {
    traceId: TRACE_ID,
    spanId,
    name,
    startTimeUnixNano: START.toString(),
    endTimeUnixNano: (START + 1_000_000_000n).toString(),
    attributes: attributes(values),
  };
}

function normalise(
  resourceValues: Readonly<Record<string, string>>,
  spans: OtlpSpan[],
) {
  return normaliseOtlpExport({
    resourceSpans: [
      {
        resource: { attributes: attributes(resourceValues) },
        scopeSpans: [
          { scope: { name: "livekit-agents", version: "1.7.1" }, spans },
        ],
      },
    ],
  });
}

describe("LiveKit Agents 1.7 trace attributes", () => {
  it("lifts the current PII-safe names and prefers them to legacy fallbacks", () => {
    const result = normalise(
      {
        "lk.pii.room_name": "current-room",
        "lk.room_name": "legacy-room",
        "lk.cloud_agent_id": "cloud-agent-1",
        "lk.agent_name": "front-desk",
        "lk.deployment_id": "deployment-7",
        "lk.agent_version": "legacy-version",
      },
      [
        span("0011223344556601", "user_turn", {
          "lk.pii.user_transcript": "Current human text",
          "lk.user_transcript": "Legacy human text",
        }),
        span("0011223344556602", "agent_turn", {
          "lk.pii.response.text": "Current agent text",
          "lk.response.text": "Legacy agent text",
        }),
        span("0011223344556603", "function_tool", {
          "lk.function_tool.name": "check_calendar",
          "lk.pii.function_tool.arguments": '{"day":"Monday"}',
          "lk.function_tool.arguments": '{"day":"Tuesday"}',
          "lk.pii.function_tool.output": '{"open":true}',
          "lk.function_tool.output": '{"open":false}',
        }),
      ],
    );

    expect(result.rejected).toEqual([]);
    expect(result.spans).toHaveLength(3);
    expect(result.spans[0]).toMatchObject({
      providerCallId: "current-room",
      agentPlatform: "livekit",
      platformAgentId: "cloud-agent-1",
      platformAgentName: "front-desk",
      platformAgentVersion: "deployment-7",
      kind: "turn:human",
      text: "Current human text",
    });
    expect(result.spans[1]).toMatchObject({
      kind: "turn:agent",
      text: "Current agent text",
    });
    expect(result.spans[2]).toMatchObject({
      kind: "tool",
      toolName: "check_calendar",
      toolArguments: '{"day":"Monday"}',
      toolResult: '{"open":true}',
    });
  });

  it("keeps reading traces emitted with the older LiveKit names", () => {
    const result = normalise(
      {
        "lk.room_name": "legacy-room",
        "lk.agent_id": "legacy-agent-id",
        "lk.agent_name": "legacy-agent-name",
        "lk.agent_version": "legacy-agent-version",
      },
      [
        span("0011223344556611", "user_turn", {
          "lk.user_transcript": "Legacy human text",
        }),
        span("0011223344556612", "agent_turn", {
          "lk.response.text": "Legacy agent text",
        }),
        span("0011223344556613", "function_tool", {
          "lk.function_tool.name": "lookup",
          "lk.function_tool.arguments": "legacy arguments",
          "lk.function_tool.output": "legacy output",
        }),
      ],
    );

    expect(result.rejected).toEqual([]);
    expect(result.spans[0]).toMatchObject({
      providerCallId: "legacy-room",
      platformAgentId: "legacy-agent-id",
      platformAgentName: "legacy-agent-name",
      platformAgentVersion: "legacy-agent-version",
      text: "Legacy human text",
    });
    expect(result.spans[1]?.text).toBe("Legacy agent text");
    expect(result.spans[2]).toMatchObject({
      toolName: "lookup",
      toolArguments: "legacy arguments",
      toolResult: "legacy output",
    });
  });
});
