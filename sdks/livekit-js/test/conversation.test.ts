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

import { ConversationCollector } from "../src/conversation.ts";
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
  it("exports the startup say greeting and the next model reply exactly once", async () => {
    const session = newSession();
    exportConversation(session);
    await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
    await session.say("Hello, I can help you schedule an appointment!").waitForPlayout();
    await session.run({ userInput: "Tomorrow, please." }).wait();
    await session.close();
    await exportStateForTests()!.processor.forceFlush();

    expect(turns().map((span) => span.attributes["lk.pii.response.text"])).toEqual([
      "Hello, I can help you schedule an appointment!",
      "What time tomorrow?",
    ]);
    expect(turns().map((span) => span.name)).toEqual(["conversation_item", "agent_turn"]);
    const greeting = turns()[0]!;
    const root = exported.find((span) => span.name === "agent_session")!;
    expect(greeting.instrumentationScope.name).toBe("egma.livekit");
    expect(greeting.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(greeting.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(greeting.attributes).toMatchObject({
      "session.id": "conversation-room",
      "egma.conversation_item.role": "assistant",
      "egma.conversation_item.interrupted": false,
    });
    expect(exported.indexOf(greeting)).toBeLessThan(exported.indexOf(root));
  });

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

  it("captures an interrupted streaming say with its committed text and interruption flag", async () => {
    const session = newSession();
    exportConversation(session);
    await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
    const speaking = new Promise<void>((resolve) => {
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
        if (event.newState === "speaking") resolve();
      });
    });
    let source: ReadableStreamDefaultController<string> | undefined;
    const text = new ReadableStream<string>({
      start(controller) { source = controller; controller.enqueue("Hello, "); },
    });
    const speech = session.say(text);
    await speaking;
    speech.interrupt(true);
    source!.close();
    await speech.waitForPlayout();
    await session.close();
    await exportStateForTests()!.processor.forceFlush();

    expect(turns()).toHaveLength(1);
    expect(turns()[0]!.attributes).toMatchObject({
      "lk.pii.response.text": "Hello, ",
      "egma.conversation_item.interrupted": true,
    });
  });

  it("does not duplicate a native reply committed after forced speech completion", async () => {
    const text = "This is the generated reply before interruption.";
    const session = newSession(new voice.testing.FakeLLM([
      { input: "Hello.", content: text, duration: 500 },
    ]));
    exportConversation(session);
    await session.start({ agent: new voice.Agent({ instructions: "Reply briefly." }) });
    const speaking = new Promise<void>((resolve) => {
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
        if (event.newState === "speaking") resolve();
      });
    });
    let doneAtCommit = false;
    let committedText = "";
    const committed = new Promise<void>((resolve) => {
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
        if (item.type === "message" && item.role === "assistant") {
          doneAtCommit = speech.done();
          committedText = item.textContent ?? "";
          resolve();
        }
      });
    });
    const speech = session.generateReply({ userInput: "Hello." });
    await speaking;
    session.interrupt({ force: true });
    await speech.waitForPlayout();
    await committed;
    await session.close();
    await exportStateForTests()!.processor.forceFlush();

    expect(doneAtCommit).toBe(true);
    expect(committedText).not.toBe("");
    expect(text.startsWith(committedText)).toBe(true);
    expect(turns().map((span) => ({
      name: span.name, text: span.attributes["lk.pii.response.text"],
    }))).toEqual([{ name: "agent_turn", text: committedText }]);
  });

  it("exports say when it inherits an active native turn and keeps repeated committed messages", async () => {
    const session = newSession();
    exportConversation(session);
    await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
    await telemetry.tracer.startActiveSpan(async () => {
      await session.say("Hello.").waitForPlayout();
      await session.say("Hello.").waitForPlayout();
    }, { name: "agent_turn" });
    await session.close();
    await exportStateForTests()!.processor.forceFlush();
    expect(turns().map((span) => span.attributes["lk.pii.response.text"])).toEqual(["Hello.", "Hello."]);
    expect(new Set(turns().map((span) => span.attributes["egma.conversation_item.id"])).size).toBe(2);
  });

  it("registers once, deduplicates item IDs, and ignores non-assistant or empty items", async () => {
    const session = newSession();
    const ctx = job();
    exportConversation(session, ctx);
    exportConversation(session, ctx);
    await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
    await session.say("Hello.").waitForPlayout();
    const hello = session.history.items.find((item) => item.type === "message" && item.role === "assistant")!;
    session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, {
      type: "conversation_item_added", item: hello as llm.ChatMessage, createdAt: Date.now(),
    });
    for (const item of [
      llm.ChatMessage.create({ role: "user", content: "User message" }),
      llm.ChatMessage.create({ role: "system", content: "System message" }),
      llm.ChatMessage.create({ role: "assistant", content: " " }),
    ]) {
      session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, {
        type: "conversation_item_added", item, createdAt: Date.now(),
      });
    }
    await session.close();
    await exportStateForTests()!.processor.forceFlush();
    expect(turns().map((span) => span.attributes["lk.pii.response.text"])).toEqual(["Hello."]);
    expect(session.listenerCount(voice.AgentSessionEventTypes.SpeechCreated)).toBe(0);
    expect(session.listenerCount(voice.AgentSessionEventTypes.ConversationItemAdded)).toBe(0);
  });

  it("uses committed timestamps and does not invent speech duration when metrics are absent", async () => {
    const session = newSession();
    exportConversation(session);
    await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
    const createdAt = Date.now() - 1_000;
    session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, {
      type: "conversation_item_added",
      item: llm.ChatMessage.create({ role: "assistant", content: "A committed message.", createdAt }),
      createdAt: Date.now(),
    });
    await session.close();
    await exportStateForTests()!.processor.forceFlush();
    const span = turns()[0]!;
    expect(span.startTime[0] * 1_000 + span.startTime[1] / 1e6).toBe(createdAt);
    expect(span.duration).toEqual([0, 0]);
  });

  it("detaches session listeners when the collector shuts down before session close", async () => {
    const session = newSession();
    const collector = new ConversationCollector(trace.getTracer("egma.livekit"));
    const events = [
      voice.AgentSessionEventTypes.SpeechCreated,
      voice.AgentSessionEventTypes.ConversationItemAdded,
      voice.AgentSessionEventTypes.Close,
    ];
    const before = events.map((event) => session.listenerCount(event));
    collector.attach(session);
    expect(events.map((event) => session.listenerCount(event))).toEqual(before.map((count) => count + 1));

    await collector.shutdown();
    await collector.shutdown();
    expect(events.map((event) => session.listenerCount(event))).toEqual(before);
    await session.close();
  });
});
