/** Packaged JavaScript SDK worker used by the LiveKit end-to-end lane. */

import { writeFile } from "node:fs/promises";
import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { simulation } from "@egma/livekit";
import {
  AgentSessionEventTypes,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { z } from "zod";

function delayFrom(name) {
  const milliseconds = Number.parseInt(process.env[name] ?? "0", 10);
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

const checkAvailability = llm.tool({
  name: "check_availability",
  description: "Check whether the dental office has an appointment on one day.",
  parameters: z.object({
    day: z.string().describe("The day the caller asks about."),
  }),
  execute: async ({ day }) => {
    const sentinel = process.env.EGMA_E2E_REAL_TOOL_SENTINEL;
    if (sentinel) await writeFile(sentinel, day, "utf8");
    return "The real calendar has a Tuesday appointment at 9:40.";
  },
});

const recordRequest = llm.tool({
  name: "record_request",
  description: "Record the appointment request after availability was checked.",
  parameters: z.object({
    day: z.string().describe("The requested appointment day."),
    kind: z.literal("reschedule").describe("The kind of appointment request."),
  }),
  execute: async ({ day, kind }) => {
    const sentinel = process.env.EGMA_E2E_RECORD_REQUEST_SENTINEL;
    if (sentinel) {
      await writeFile(sentinel, JSON.stringify({ day, kind }), "utf8");
    }
    return {
      recorded: true,
      reference: "fixture-request-1",
      day,
      kind,
    };
  },
});

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    await ctx.connect();
    await delayFrom("EGMA_E2E_SETUP_DELAY_MS");

    const agent = voice.Agent.create({
      instructions:
        "You schedule dental appointments. On the caller's first request, call " +
        "check_availability with day Tuesday, then immediately call record_request " +
        "with day Tuesday and kind reschedule. Each call is required exactly once, " +
        "even when Tuesday is full. Do not ask for confirmation and never check " +
        "another day. After both tools return, state the availability, confirm the " +
        "request was recorded, and end the conversation. Keep the reply short.",
      tools: [checkAvailability, recordRequest],
    });
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      llm: new openai.LLM({ model: "gpt-4o-mini" }),
      stt: new openai.STT({ model: "whisper-1", useRealtime: false }),
      tts: new openai.TTS({ model: "tts-1", voice: "alloy" }),
    });
    const historyPath = process.env.EGMA_E2E_NATIVE_HISTORY;
    if (historyPath) {
      session.on(AgentSessionEventTypes.Close, () => {
        writeFileSync(historyPath, JSON.stringify(session.history.toJSON()), "utf8");
        chmodSync(historyPath, 0o600);
      });
    }

    await simulation(agent, ctx, session);
    await delayFrom("EGMA_E2E_SESSION_DELAY_MS");

    const chat = ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;
    await session.start({
      agent,
      room: ctx.room,
      ...(chat
        ? {
            inputOptions: { audioEnabled: false },
            outputOptions: {
              audioEnabled: false,
              syncTranscription: false,
            },
          }
        : {}),
    });

    if (process.env.EGMA_E2E_SILENT_START !== "1") {
      session.generateReply({
        instructions: "Greet the caller and ask which appointment day they need.",
      });
    }

    if (process.env.EGMA_E2E_LONG_LIVED_ENTRY === "1") {
      await new Promise((resolve) =>
        session.once(AgentSessionEventTypes.Close, resolve),
      );
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: import.meta.filename,
      agentName: process.env.EGMA_E2E_AGENT_NAME ?? "egma-javascript-e2e",
      loadFunc: async () => 0,
    }),
  );
}
