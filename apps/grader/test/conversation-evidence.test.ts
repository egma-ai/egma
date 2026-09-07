import type { Simulation, TraceDetail, TraceSpan } from "@egma/db";
import { describe, expect, it } from "vitest";

import { conversationOfSimulation, evidenceIsStillArriving } from "../src/conversation.ts";

const simulation: Simulation = {
  id: "sim_01M10000000000000000000001",
  runId: "run_01M10000000000000000000002",
  projectId: "prj_01M10000000000000000000003",
  agentId: "agt_01M10000000000000000000004",
  connectionId: "con_01M10000000000000000000005",
  personaId: "persona", personaVersionId: "persona-version",
  testId: "test", testVersionId: "test-version",
  position: 0, modality: "voice", status: "completed",
  endingReason: "agent_ended", executionFailure: null,
  claimedBy: null, claimedAt: null, heartbeatAt: null,
  cancelRequestedAt: null, startedAt: new Date("2026-09-07T18:34:57Z"),
  endedAt: new Date("2026-09-07T18:38:43Z"), recordingReference: null,
  turnCount: 2, providerReference: "call_fixture",
  createdAt: new Date("2026-09-07T18:34:57Z"),
};

function span(pov: "agent" | "persona", fields: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId: pov === "agent" ? "1111111111111111" : "2222222222222222",
    parentSpanId: "", name: "turn", kind: "turn:agent", status: "ok",
    startedAt: "2026-09-07T18:35:00.000000Z", durationNanoseconds: "1000000000",
    text: pov === "agent" ? "The platform's words" : "Egma's speech recognition",
    audioUrl: "", toolName: "", toolArguments: "", toolResult: "", pov,
    spans: [], ...fields,
  };
}

function trace(connectionType: string, turns: TraceSpan[], spans: TraceSpan[] = []): TraceDetail {
  return {
    projectId: simulation.projectId, traceId: "1234567890abcdef1234567890abcdef",
    startedAt: "2026-09-07T18:34:57.000000Z", endedAt: "2026-09-07T18:38:43.000000Z",
    durationNanoseconds: "226000000000", spanCount: turns.length + spans.length,
    humanTurnCount: 0, agentTurnCount: turns.length, toolSpanCount: spans.length,
    erroredSpanCount: 0, source: "simulation", emitter: "egma-runtime", pov: "persona",
    environment: "test", connectionType, providerCallId: "call_fixture",
    agentPlatform: "retell", platformAgentId: "agent_fixture",
    platformAgentName: "Test agent", platformAgentVersion: "1",
    runId: simulation.runId, agentId: simulation.agentId,
    turns, spans, truncated: false,
    agentEvidenceComplete: [...turns, ...spans].some((item) => item.pov === "agent"),
  };
}

const mock = span("persona", { kind: "tool", text: "", toolName: "book_appointment", toolResult: '{"mocked":true}' });

describe("the evidence used to grade a platform simulation", () => {
  it.each(["retell_web_call", "livekit_room"])("does not substitute simulator evidence when %s evidence is missing", (lane) => {
    const conversation = conversationOfSimulation(simulation, trace(lane, [span("persona")], [mock]));
    expect(conversation.transcript).toEqual([]);
    expect(conversation.events).toEqual([]);
    expect(conversation.nothingToJudgeBecause).toMatch(/platform.*unavailable/i);
  });

  it("does not invent a platform tool call from the mock server's record", () => {
    const conversation = conversationOfSimulation(simulation, trace("retell_web_call", [span("agent"), span("persona")], [mock]));
    expect(conversation.nothingToJudgeBecause).toBeNull();
    expect(conversation.transcript).toEqual([expect.objectContaining({ text: "The platform's words" })]);
    expect(conversation.events).toEqual([]);
  });

  it("uses the actual platform tool result when both records exist", () => {
    const actual = span("agent", { kind: "tool", text: "", toolName: "get_availability", toolResult: '{"slots":["10:30"]}' });
    const conversation = conversationOfSimulation(simulation, trace("retell_web_call", [span("agent")], [mock, actual]));
    expect(conversation.events).toEqual([expect.objectContaining({ name: "get_availability", result: '{"slots":["10:30"]}' })]);
  });

  it("does not issue a score from an incomplete platform record", () => {
    const partial = { ...trace("retell_web_call", [span("agent")]), agentEvidenceIncomplete: true };
    const conversation = conversationOfSimulation(simulation, partial);
    expect(conversation.nothingToJudgeBecause).toMatch(/platform.*unavailable/i);
    expect(conversation.transcript).toHaveLength(1);
  });

  it("waits for the agent session to finish instead of grading the first agent turn", () => {
    const partial = {
      ...trace("livekit_room", [span("agent")], [span("persona", { kind: "root" })]),
      agentEvidenceComplete: false,
    };
    expect(evidenceIsStillArriving(simulation, partial)).toBe(true);
    expect(conversationOfSimulation(simulation, partial).nothingToJudgeBecause)
      .toMatch(/platform.*incomplete/i);
  });

  it.each(["phone_number", "retell_text_mode"])("keeps the native record for %s", (lane) => {
    const conversation = conversationOfSimulation(simulation, trace(lane, [span("persona")]));
    expect(conversation.nothingToJudgeBecause).toBeNull();
    expect(conversation.transcript).toHaveLength(1);
  });
});
