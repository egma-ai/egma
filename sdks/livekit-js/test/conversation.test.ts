import {
  initializeLogger,
  llm,
  telemetry,
  type JobContext,
  voice,
} from "@livekit/agents";
import { context, ProxyTracerProvider, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { exportStateForTests, resetExportForTests } from "../src/export.ts";
import { monitor } from "../src/monitoring.ts";

const PROJECT_KEY = `egma_sk_${"a".repeat(43)}`;
const exported: ReadableSpan[] = [];
const sessions: voice.AgentSession[] = [];

function job(): JobContext {
  return {
    job: { room: { name: "conversation-room" }, agentName: "frontdesk" },
    addShutdownCallback: vi.fn(),
  } as unknown as JobContext;
}

function newSession(model = new voice.testing.FakeLLM([
  { input: "Tomorrow, please.", content: "What time tomorrow?" },
])): voice.AgentSession {
  const session = new voice.AgentSession({
    llm: model,
  });
  sessions.push(session);
  return session;
}

function exportConversation(session: voice.AgentSession, ctx = job()): void {
  monitor(ctx, {
    endpoint: "http://127.0.0.1:9",
    apiKey: PROJECT_KEY,
    session,
  });
}

function turns(): ReadableSpan[] {
  return exported.filter((span) =>
    (span.name === "agent_turn" || span.name === "conversation_item") &&
    typeof span.attributes["lk.pii.response.text"] === "string",
  );
}

beforeEach(() => {
  initializeLogger({ pretty: false, level: "silent" });
  exported.length = 0;
  telemetry.setTracerProvider(new ProxyTracerProvider());
  vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation((spans, done) => {
    exported.push(...spans);
    done({ code: 0 });
  });
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await exportStateForTests()?.processor.forceFlush();
  await exportStateForTests()?.processor.shutdown();
  resetExportForTests();
  telemetry.setTracerProvider(new ProxyTracerProvider());
  context.disable();
  trace.disable();
  vi.restoreAllMocks();
});

describe("LiveKit committed conversation export", () => {
  it("keeps repeated speech from say inside a tool and its native model reply", async () => {
    const session = newSession(new voice.testing.FakeLLM([
      { input: "Check tomorrow.", toolCalls: [{ name: "check", args: {} }] },
      { input: JSON.stringify("available"), content: "Tomorrow is available." },
    ]));
    exportConversation(session);
    await session.start({ agent: new voice.Agent({
      instructions: "Book appointments.",
      tools: [llm.tool({
        name: "check",
        description: "Check availability.",
        parameters: z.object({}),
        execute: async () => {
          await session.say("Tomorrow is available.").waitForPlayout();
          return "available";
        },
      })],
    }) });
    await session.run({ userInput: "Check tomorrow." }).wait();
    await session.close();
    await exportStateForTests()!.processor.forceFlush();

    expect(turns().map((span) => span.attributes["lk.pii.response.text"])).toEqual([
      "Tomorrow is available.", "Tomorrow is available.",
    ]);
    expect(turns().map((span) => span.name)).toEqual(["conversation_item", "agent_turn"]);
  });
});
