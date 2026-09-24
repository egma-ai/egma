import { describe, expect, it } from "vitest";

import type { OtlpAttribute, OtlpSpan } from "../src/otlp/decode.ts";
import {
  normaliseOtlpExport,
  type NormalisationBudget,
} from "../src/otlp/normalise.ts";

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
  version = "1.7.1",
  modality?: "chat" | "voice",
  budget?: NormalisationBudget,
) {
  return normaliseOtlpExport(
    {
      resourceSpans: [
        {
          resource: { attributes: attributes(resourceValues) },
          scopeSpans: [
            { scope: { name: "livekit-agents", version }, spans },
          ],
        },
      ],
    },
    modality === undefined
      ? undefined
      : () => ({
          source: "simulation",
          emitter: "agent",
          modality,
          runId: "run_livekit",
          agentId: "agt_livekit",
          testVersionId: "tst_livekit",
          personaVersionId: "prs_livekit",
        }),
    budget,
  );
}

describe("LiveKit Agents 1.7 trace attributes", () => {
  it("includes a committed say greeting as customer-agent evidence", () => {
    const result = normaliseOtlpExport({
      resourceSpans: [{
        resource: { attributes: attributes({ "egma.provider_reference": "egma-sim-greeting" }) },
        scopeSpans: [{
          scope: { name: "egma.livekit", version: "0.3.5" },
          spans: [{
            ...span("0011223344556620", "conversation_item", {
              "egma.conversation_item.id": "item_greeting",
              "egma.conversation_item.role": "assistant",
              "lk.pii.response.text": "Hello, I can help you schedule an appointment!",
            }),
            parentSpanId: "0011223344556621",
          }],
        }],
      }],
    });

    expect(result.rejected).toEqual([]);
    expect(result.spans).toMatchObject([{
      kind: "turn:agent",
      emitter: "agent",
      agentPlatform: "livekit",
      text: "Hello, I can help you schedule an appointment!",
      parentSpanId: "0011223344556621",
      endsTrace: false,
    }]);
  });

  it.each([
    { role: "assistant", text: undefined },
    { role: "assistant", text: "   " },
    { role: "user", text: "Is Tuesday available?" },
  ])("does not turn redacted or non-agent conversation items into agent speech ($role, $text)", ({ role, text }) => {
    const result = normaliseOtlpExport({
      resourceSpans: [{
        scopeSpans: [{
          scope: { name: "egma.livekit" },
          spans: [span("0011223344556623", "conversation_item", {
            "egma.conversation_item.role": role,
            ...(text === undefined ? {} : { "lk.pii.response.text": text }),
          })],
        }],
      }],
    });

    expect(result.spans).toMatchObject([{ kind: "other", text: "" }]);
  });

  it.each([
    { flag: false, wireStatus: undefined, expected: "ok" },
    { flag: false, wireStatus: 2, expected: "error" },
    { flag: true, wireStatus: 1, expected: "error" },
  ])("preserves LiveKit tool result status $expected ($flag, $wireStatus)", ({ flag, wireStatus, expected }) => {
    const tool: OtlpSpan = {
      ...span("0011223344556622", "function_tool", {}),
      attributes: [
        ...attributes({
          "lk.function_tool.name": "scheduleAppointment",
          "lk.pii.function_tool.output": flag ? "Slot unavailable" : "Booked",
        }),
        { key: "lk.function_tool.is_error", value: { boolValue: flag } },
      ],
      ...(wireStatus === undefined ? {} : { status: { code: wireStatus } }),
    };
    const result = normalise({}, [tool]);
    expect(result.spans[0]).toMatchObject({
      kind: "tool",
      status: expected,
      toolResult: flag ? "Slot unavailable" : "Booked",
    });
  });

  it("recovers chat caller input from the agent turn that accepted it", () => {
    const inputOnly = span("0011223344556600", "agent_turn", {
      "lk.pii.user_input": "Is Tuesday available?",
    });
    const inputAndReply = span("0011223344556601", "agent_turn", {
      "lk.pii.user_input": "Please book it.",
      "lk.pii.response.text": "You are booked.",
    });

    const first = normalise(
      { "lk.pii.room_name": "egma-sim-chat-sim_caller" },
      [inputOnly, inputAndReply],
      "1.7.1",
      "chat",
    );
    const retried = normalise(
      { "lk.pii.room_name": "egma-sim-chat-sim_caller" },
      [inputOnly, inputAndReply],
      "1.7.1",
      "chat",
    );

    expect(first.rejected).toEqual([]);
    expect(
      first.spans
        .filter(({ kind }) => kind.startsWith("turn:"))
        .map(({ kind, text }) => ({ kind, text })),
    ).toEqual([
      { kind: "turn:human", text: "Is Tuesday available?" },
      { kind: "turn:human", text: "Please book it." },
      { kind: "turn:agent", text: "You are booked." },
    ]);
    expect(first.spans[0]?.spanId).not.toBe(inputOnly.spanId);
    expect(first.spans[0]).toMatchObject({
      startedAtMicroseconds: START / 1_000n,
      durationNanoseconds: 0n,
    });
    expect(first.spans[1]?.spanId).toBe(inputOnly.spanId);
    expect(first.spans[1]).toMatchObject({
      kind: "other",
      text: "",
      startedAtMicroseconds: START / 1_000n,
      durationNanoseconds: 1_000_000_000n,
    });
    expect(first.spans[0]?.payload).toContain(
      '"egma.projection":{"source":"lk.pii.user_input","duration":"unmeasured"}',
    );
    expect(first.spans[0]?.payload).toContain('"name":"agent_turn"');
    expect(first.spans.map(({ spanId }) => spanId)).toEqual(
      retried.spans.map(({ spanId }) => spanId),
    );
  });

  it("keeps repeated chat caller text as separate turns", () => {
    const result = normalise(
      { "lk.pii.room_name": "egma-sim-chat-sim_repeated" },
      [
        span("0011223344556604", "agent_turn", {
          "lk.pii.user_input": "Hello?",
        }),
        span("0011223344556605", "agent_turn", {
          "lk.pii.user_input": "Hello?",
        }),
      ],
      "1.7.1",
      "chat",
    );

    expect(
      result.spans
        .filter(({ kind }) => kind.startsWith("turn:"))
        .map(({ kind, text }) => ({ kind, text })),
    ).toEqual([
      { kind: "turn:human", text: "Hello?" },
      { kind: "turn:human", text: "Hello?" },
    ]);
    expect(
      new Set(
        result.spans
          .filter(({ kind }) => kind === "turn:human")
          .map(({ spanId }) => spanId),
      ),
    ).toHaveProperty(
      "size",
      2,
    );
  });

  it("keeps empty native agent records out of the conversation and keeps response errors on the native record", () => {
    const failedResponse: OtlpSpan = {
      ...span("0011223344556603", "agent_turn", {
        "lk.pii.user_input": "Please try that.",
      }),
      status: {
        code: "STATUS_CODE_ERROR",
        message: "the response failed",
      },
    };
    const continuation = span("0011223344556613", "agent_turn", {});

    const result = normalise(
      { "lk.pii.room_name": "egma-sim-chat-sim_empty" },
      [failedResponse, continuation],
      "1.7.1",
      "chat",
    );

    expect(result.spans).toMatchObject([
      {
        kind: "turn:human",
        text: "Please try that.",
        status: "unset",
        durationNanoseconds: 0n,
      },
      { kind: "other", text: "", status: "error" },
      { kind: "other", text: "", status: "unset" },
    ]);
    expect(result.spans[1]?.payload).toContain('"message":"the response failed"');
  });

  it("retains an empty terminal user record outside the spoken conversation", () => {
    const heard = span("0011223344556614", "user_turn", {
      "lk.pii.user_transcript": "Is Tuesday available?",
    });
    const aborted = span("0011223344556615", "user_turn", {});

    const result = normalise(
      { "lk.pii.room_name": "egma-sim-sim_aborted_stt" },
      [heard, aborted],
      "1.7.1",
      "voice",
    );

    expect(result.spans.filter(({ kind }) => kind.startsWith("turn:"))).toMatchObject([
      { spanId: heard.spanId, kind: "turn:human", text: "Is Tuesday available?" },
    ]);
    expect(result.spans[1]).toMatchObject({
      spanId: aborted.spanId,
      name: "user_turn",
      kind: "other",
      text: "",
    });
    expect(result.spans[1]?.payload).toContain('"name":"user_turn"');
  });

  it.each([
    { name: "user_turn", key: "lk.pii.user_transcript", text: " \t" },
    { name: "agent_turn", key: "lk.pii.response.text", text: " \t" },
  ])("keeps blank $name text as raw evidence for %#", ({ name, key, text }) => {
    const result = normalise(
      { "lk.pii.room_name": "egma-sim-sim_blank_native_turn" },
      [span("0011223344556616", name, { [key]: text })],
      "1.7.1",
      "voice",
    );

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ name, kind: "other", text });
  });

  it.each([
    { boundary: "span", budget: { spans: 9_999, bytes: 0 } },
    {
      boundary: "byte",
      budget: { spans: 0, bytes: 64 * 1024 * 1024 - 1 },
    },
  ])(
    "accepts or rejects the native chat span and its projection together at the $boundary limit",
    ({ budget }) => {
      const result = normalise(
        { "lk.pii.room_name": "any-token-endpoint-room" },
        [
          span("0011223344556609", "agent_turn", {
            "lk.pii.user_input": "Please book it.",
            "lk.pii.response.text": "You are booked.",
          }),
        ],
        "1.7.1",
        "chat",
        budget,
      );

      expect(result.spans).toEqual([]);
      expect(result.rejected).toHaveLength(1);
    },
  );

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

describe("LiveKit Agents 1.8 trace attributes", () => {
  it("keeps realtime inference separate from the agent turn", () => {
    const messages = JSON.stringify([
      { role: "assistant", parts: [{ type: "text", content: "Tuesday is free." }] },
    ]);
    const result = normalise(
      { "lk.pii.room_name": "realtime-room" },
      [
        span("0011223344556621", "agent_turn", {
          "lk.pii.response.text": "Tuesday is free.",
          "gen_ai.operation.name": "invoke_agent",
        }),
        {
          ...span("0011223344556622", "realtime_inference", {
            "gen_ai.operation.name": "generate_content",
            "gen_ai.output.messages": messages,
          }),
          parentSpanId: "0011223344556621",
        },
      ],
      "1.8.0",
    );

    expect(result.rejected).toEqual([]);
    expect(result.spans[0]).toMatchObject({
      kind: "turn:agent",
      text: "Tuesday is free.",
    });
    expect(result.spans[1]).toMatchObject({
      kind: "model",
      text: "",
      parentSpanId: "0011223344556621",
      providerCallId: "realtime-room",
    });
    expect(result.spans[1]?.payload).toContain("gen_ai.output.messages");
  });
});

describe("Langfuse 5.10 custom LiveKit agent traces", () => {
  function normaliseLangfuse(spans: OtlpSpan[]) {
    return normaliseOtlpExport({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            { scope: { name: "langfuse-sdk", version: "5.10.1" }, spans },
          ],
        },
      ],
    });
  }

  it("lifts a semantic tool observation with its actual input and output", () => {
    const result = normaliseLangfuse([
      span("0011223344556631", "submit_lead_result", {
        "session.id": "egma-sim-rentlyx",
        "lk.agent_name": "rentlyx-voice-lead-agent",
        "langfuse.observation.type": "tool",
        "langfuse.observation.input": '{"lead_id":"lead_123"}',
        "langfuse.observation.output": '{"accepted":true}',
      }),
    ]);

    expect(result.spans[0]).toMatchObject({
      kind: "tool",
      toolName: "submit_lead_result",
      toolArguments: '{"lead_id":"lead_123"}',
      toolResult: '{"accepted":true}',
      providerCallId: "egma-sim-rentlyx",
      platformAgentName: "rentlyx-voice-lead-agent",
    });
  });

  it("recognizes generations but does not classify a tool-like name alone", () => {
    const result = normaliseLangfuse([
      span("0011223344556632", "ChatOpenRouter", {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": "model input",
        "langfuse.observation.output": "model output",
      }),
      span("0011223344556633", "submit_lead_result", {
        "langfuse.observation.type": "span",
        "langfuse.observation.input": "not a tool observation",
      }),
    ]);

    expect(result.spans[0]).toMatchObject({
      kind: "model",
      toolName: "",
      toolArguments: "",
      toolResult: "",
    });
    expect(result.spans[1]).toMatchObject({ kind: "other", toolName: "" });
  });
});
