/** Packaged JavaScript SDK worker used by the LiveKit end-to-end lane. */

import { writeFile } from "node:fs/promises";
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

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    await ctx.connect();
    await delayFrom("EGMA_E2E_SETUP_DELAY_MS");

    const agent = voice.Agent.create({
      instructions:
        "You schedule dental appointments. Always call check_availability " +
        "before you say whether Tuesday is free. Keep each reply short.",
      tools: [checkAvailability],
    });
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      llm: new openai.LLM({ model: "gpt-4o-mini" }),
      stt: new openai.STT({ model: "whisper-1", useRealtime: false }),
      tts: new openai.TTS({ model: "tts-1", voice: "alloy" }),
    });

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
