import assert from "node:assert/strict";
import { monitor } from "@egma/livekit";
import { initializeLogger, telemetry, voice } from "@livekit/agents";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const privateContent = process.argv[2] === "private";
if (privateContent) {
  process.env.LIVEKIT_TELEMETRY_ALLOW_PII = "false";
}
initializeLogger({ pretty: false, level: "silent" });
const batches = [];
OTLPTraceExporter.prototype.export = function (spans, done) {
  batches.push(...spans);
  done({ code: 0 });
};
const shutdownCallbacks = [];
const ctx = {
  job: { room: { name: "conversation-compatibility" }, agentName: "frontdesk" },
  addShutdownCallback(callback) { shutdownCallbacks.push(callback); },
};
const session = new voice.AgentSession({
  llm: new voice.testing.FakeLLM([
    { input: "Tomorrow.", content: "What time tomorrow?" },
  ]),
});
const options = {
  endpoint: "http://127.0.0.1:9",
  apiKey: `egma_sk_${"a".repeat(43)}`,
  session,
};
monitor(ctx, options);
monitor(ctx, options);
await session.start({ agent: new voice.Agent({ instructions: "Book appointments." }) });
await session.say("Hello, I can help you schedule an appointment!").waitForPlayout();
await session.run({ userInput: "Tomorrow." }).wait();
await session.close();
await Promise.all(shutdownCallbacks.map((callback) => callback()));
await telemetry.tracer.getProvider().shutdown();

const greeting = batches.filter((span) => span.name === "conversation_item");
assert.equal(greeting.length, 1);
assert.equal(greeting[0].instrumentationScope.name, "egma.livekit");
assert.equal(greeting[0].attributes["egma.conversation_item.role"], "assistant");
const texts = batches
  .filter((span) => span.name === "agent_turn" || span.name === "conversation_item")
  .map((span) => span.attributes["lk.pii.response.text"] ?? span.attributes["lk.response.text"])
  .filter((value) => typeof value === "string" && value !== "");
assert.deepEqual(texts, privateContent ? [] : [
  "Hello, I can help you schedule an appointment!", "What time tomorrow?",
]);
const root = batches.find((span) => span.name === "agent_session");
assert.equal(greeting[0].spanContext().traceId, root.spanContext().traceId);
assert.ok(batches.indexOf(greeting[0]) < batches.indexOf(root));
process.stdout.write(`committed conversation export passed (${privateContent ? "private" : "content"})\n`);
