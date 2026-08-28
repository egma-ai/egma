"use client";

import { CopyBlock } from "./copy-block.tsx";

/**
 * The chat setup, exactly as `skills/integrate-egma/references/integrate-livekit.md`
 * teaches it.
 *
 * One block of plain LiveKit code, and no Egma package behind it: the worker
 * reads the modality Egma sends with the dispatch and, when it says chat,
 * starts its room with no audio either way and no transcription
 * synchronisation. A room without Egma's metadata never sees `chat`, so a
 * production deployment behaves exactly as it did before.
 */
export const CHAT_SETUP_SNIPPET = `context = json.loads(ctx.job.metadata or "{}")
chat = context.get("modality") == "chat"
options = RoomOptions(
    audio_input=False,
    audio_output=False,
    text_output=TextOutputOptions(sync_transcription=False),
) if chat else RoomOptions()`;

/**
 * The same work, asked for in the words a coding agent acts on.
 *
 * It carries the naming part beside the setup because the two are one visit to
 * one file, and because a worker with no registered name is a worker Egma
 * cannot dispatch — which is the other half of what a chat simulation needs.
 */
export const CHAT_SETUP_PROMPT = `Add Egma's chat setup to this repository's LiveKit worker.

In the job entrypoint, read the modality out of the job's dispatch metadata. When it is "chat", build the room options with the audio input off, the audio output off, and text_output=TextOutputOptions(sync_transcription=False), and pass them to AgentSession.start as room_options. Otherwise keep the room options the worker already used. Add no package for this.

Then register the worker under a name, with agent_name in its WorkerOptions, and tell me the name it registers under.

Change nothing else, and leave every environment file unread.`;

/**
 * The LiveKit chat work the web can explain but cannot perform.
 *
 * The customer owns the worker and its deployment. **This component therefore
 * makes no write and never claims that chat is ready.** The first chat
 * simulation's record is the only confirmation: an agent that still answers in
 * speech ends its simulation at the first turn, and the reason on that record
 * names this setup and sends the developer back here.
 */
export function LiveKitChatInstructions() {
  const steps = [
    { title: "Give this to your coding agent", value: CHAT_SETUP_PROMPT },
    { title: "Or add these lines to the worker yourself", value: CHAT_SETUP_SNIPPET },
  ] as const;

  return (
    <section className="flex flex-col gap-5" aria-labelledby="livekit-chat-title">
      <div className="flex flex-col gap-2">
        <h3
          className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
          data-setup-heading
          id="livekit-chat-title"
          tabIndex={-1}
        >
          Add the chat setup to your LiveKit agent
        </h3>
        <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
          A chat simulation types to your agent and reads its words back. Your
          worker needs six lines to answer in text. They need no Egma package,
          and they work the same in a Python worker and a Node one.
        </p>
      </div>

      <ol className="m-0 flex list-none flex-col gap-5 p-0">
        {steps.map((step, index) => (
          <li className="flex gap-3" key={step.title}>
            <span className="w-(--space-5) flex-none text-sm leading-(--line-normal) text-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="m-0 text-sm leading-(--line-normal) font-medium text-foreground">
                {step.title}
              </p>
              <CopyBlock value={step.value} />
            </div>
          </li>
        ))}
      </ol>
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        Your live rooms are untouched: a room without Egma&apos;s metadata keeps
        the options the worker always used. Egma cannot see this change from
        here. Your first chat simulation is what confirms it — an agent that
        still answers in speech stops at its first turn, and says so.
      </p>
    </section>
  );
}
