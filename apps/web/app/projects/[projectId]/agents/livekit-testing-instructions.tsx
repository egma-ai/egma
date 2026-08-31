"use client";

import { CopyBlock } from "./copy-block.tsx";

export const TESTING_SETUP_INSTALL =
  "pip install 'egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python'";

export const VOICE_SETUP_SNIPPET = `from egma import mockable

agent = ...
session = AgentSession(...)
await mockable(agent, ctx, session)
await session.start(...)`;

export const CHAT_SETUP_SNIPPET = `from livekit.agents import room_io
from egma import mockable

agent = ...
session = AgentSession(...)
await mockable(agent, ctx, session)

chat = ctx.job.room.name.startswith("egma-sim-chat-")
options = (
    room_io.RoomOptions(
        audio_input=False,
        audio_output=False,
        text_output=room_io.TextOutputOptions(sync_transcription=False),
    )
    if chat
    else room_io.RoomOptions()
)
await session.start(agent=agent, room=ctx.room, room_options=options)`;

const PROMPT_START = `Set up Egma simulation testing for this repository's Python LiveKit worker.

Start by running \`egma livekit\` if it is available, or \`npx --yes @egma/cli livekit\` otherwise, and follow its current Python testing contract.

Use the repository's existing dependency file and package manager to install the latest Egma Python SDK from \`egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python\`. Do not pin a version, tag, or commit.

In the job entrypoint, import mockable from egma. After the initial agent and AgentSession exist, and before AgentSession.start, call await mockable(agent, ctx, session).`;

const PROMPT_END = `Register the worker under one exact name, with agent_name in its WorkerOptions, and tell me the name it registers under.

Preserve the production voice path, run the repository's focused checks, change nothing else, and leave every environment file unread.`;

export const VOICE_SETUP_PROMPT = `${PROMPT_START}

${PROMPT_END}`;

export const CHAT_SETUP_PROMPT = `${PROMPT_START}

For rooms whose name starts with "egma-sim-chat-", pass room options to AgentSession.start with audio input off, audio output off, and transcription sync off. Keep the worker's existing room options for every other room.

Do not start any independent audio publisher, such as background audio, while chat is true.

${PROMPT_END}`;

type LiveKitTestingInstructionsProps = {
  readonly modality: "chat" | "voice";
};

/**
 * The LiveKit testing work the web can explain but cannot perform.
 *
 * The customer owns the worker and its deployment. This component makes no
 * write and never claims that testing is ready. The first simulation is the
 * confirmation that the source integration works.
 */
export function LiveKitTestingInstructions({
  modality,
}: LiveKitTestingInstructionsProps) {
  const chat = modality === "chat";
  const steps = [
    {
      title: "Give this to your coding agent",
      value: chat ? CHAT_SETUP_PROMPT : VOICE_SETUP_PROMPT,
      copyLabel: "coding-agent prompt",
    },
    {
      title: "Install the latest Egma SDK",
      value: TESTING_SETUP_INSTALL,
      copyLabel: "install command",
    },
    {
      title: "Apply the Python testing contract",
      value: chat ? CHAT_SETUP_SNIPPET : VOICE_SETUP_SNIPPET,
      copyLabel: "Python testing code",
    },
  ] as const;

  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="livekit-testing-title"
    >
      <div className="flex flex-col gap-2">
        <h3
          className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
          data-setup-heading
          id="livekit-testing-title"
          tabIndex={-1}
        >
          Add simulation testing to your LiveKit agent
        </h3>
        <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
          {chat
            ? "A Python worker needs the Egma testing hook, silent chat-room options, and a registered dispatch name. JavaScript workers support monitoring, but not Egma simulation testing."
            : "A Python worker needs the Egma testing hook and a registered dispatch name. JavaScript workers support monitoring, but not Egma simulation testing."}
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
              <CopyBlock value={step.value} copyLabel={step.copyLabel} />
            </div>
          </li>
        ))}
      </ol>
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        Production rooms keep the worker&apos;s existing behavior. Egma cannot
        see this change from here. The first simulation confirms it.
      </p>
    </section>
  );
}
