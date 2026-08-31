"use client";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { LiveKitWorkerLanguage } from "@/lib/agent-setup-flow.ts";

import { CopyBlock } from "./copy-block.tsx";

export const PYTHON_TESTING_SETUP_INSTALL =
  "pip install 'egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python'";

export const PYTHON_VOICE_SETUP_SNIPPET = `from egma import mockable

agent = ...
session = AgentSession(...)
await mockable(agent, ctx, session)
await session.start(...)`;

export const PYTHON_CHAT_SETUP_SNIPPET = `from livekit.agents import room_io
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

const PYTHON_PROMPT_START = `Set up Egma simulation testing for this repository's Python LiveKit worker.

Start by running \`egma livekit\` if it is available, or \`npx --yes @egma/cli livekit\` otherwise, and follow its current Python testing contract.

Use the repository's existing dependency file and package manager to install the latest Egma Python SDK from \`egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python\`. Do not pin a version, tag, or commit.

In the job entrypoint, import mockable from egma. After the initial agent and AgentSession exist, and before AgentSession.start, call await mockable(agent, ctx, session).`;

const PYTHON_PROMPT_END = `Register the worker under one exact name, with agent_name in its WorkerOptions, and tell me the name it registers under.

Preserve the production voice path, run the repository's focused checks, change nothing else, and leave every environment file unread.`;

export const PYTHON_VOICE_SETUP_PROMPT = `${PYTHON_PROMPT_START}

${PYTHON_PROMPT_END}`;

export const PYTHON_CHAT_SETUP_PROMPT = `${PYTHON_PROMPT_START}

For rooms whose name starts with "egma-sim-chat-", pass room options to AgentSession.start with audio input off, audio output off, and transcription sync off. Keep the worker's existing room options for every other room.

Do not start any independent audio publisher, such as background audio, while chat is true.

${PYTHON_PROMPT_END}`;

export const JAVASCRIPT_TESTING_SETUP_INSTALL = "npm install @egma/livekit";

export const JAVASCRIPT_VOICE_SETUP_SNIPPET = `import { mockable } from "@egma/livekit";

const agent = voice.Agent.create({
  instructions: "Help the caller.",
  tools: [checkCalendar, bookAppointment],
});
const session = new voice.AgentSession({ stt, llm, tts });

await mockable(agent, ctx, session);
await session.start({ agent, room: ctx.room });`;

export const JAVASCRIPT_CHAT_SETUP_SNIPPET = `import { mockable } from "@egma/livekit";

const isEgmaChat =
  ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;
const agent = voice.Agent.create({
  instructions: "Help the caller.",
  tools: [checkCalendar, bookAppointment],
});
const session = new voice.AgentSession({ stt, llm, tts });

await mockable(agent, ctx, session);
await session.start({
  agent,
  room: ctx.room,
  ...(isEgmaChat
    ? {
        inputOptions: { audioEnabled: false },
        outputOptions: {
          audioEnabled: false,
          syncTranscription: false,
        },
      }
    : {}),
});`;

const JAVASCRIPT_PROMPT_START = `Set up Egma simulation testing for this repository's JavaScript or TypeScript LiveKit worker.

Start by running \`egma livekit\` if it is available, or \`npx --yes @egma/cli livekit\` otherwise, and follow its current JavaScript testing contract.

Use the repository's existing dependency file and package manager to install the latest \`@egma/livekit\` package. Do not pin a version, tag, or commit.

In the job entrypoint, import { mockable } from "@egma/livekit". After the initial agent and AgentSession exist, and before AgentSession.start, call await mockable(agent, ctx, session).`;

const JAVASCRIPT_PROMPT_END = `Register the worker under one exact name, with agentName in its WorkerOptions, and tell me the name it registers under.

Preserve the production voice path, run the repository's focused checks, change nothing else, and leave every environment file unread.`;

export const JAVASCRIPT_VOICE_SETUP_PROMPT = `${JAVASCRIPT_PROMPT_START}

${JAVASCRIPT_PROMPT_END}`;

export const JAVASCRIPT_CHAT_SETUP_PROMPT = `${JAVASCRIPT_PROMPT_START}

For rooms whose name starts with "egma-sim-chat-", pass inputOptions to AgentSession.start with audio off and outputOptions with audio and transcription sync off. Keep the worker's existing input and output options for every other room.

Do not start any independent audio publisher, such as background audio, while chat is true.

${JAVASCRIPT_PROMPT_END}`;

type LiveKitTestingInstructionsProps = {
  readonly language: LiveKitWorkerLanguage | "";
  readonly modality: "chat" | "voice";
  readonly onLanguageChange: (language: LiveKitWorkerLanguage) => void;
};

type TestingContract = {
  readonly install: string;
  readonly prompt: string;
  readonly snippet: string;
  readonly languageLabel: "JavaScript" | "Python";
};

function testingContract(
  language: LiveKitWorkerLanguage,
  chat: boolean,
): TestingContract {
  if (language === "javascript") {
    return {
      install: JAVASCRIPT_TESTING_SETUP_INSTALL,
      prompt: chat
        ? JAVASCRIPT_CHAT_SETUP_PROMPT
        : JAVASCRIPT_VOICE_SETUP_PROMPT,
      snippet: chat
        ? JAVASCRIPT_CHAT_SETUP_SNIPPET
        : JAVASCRIPT_VOICE_SETUP_SNIPPET,
      languageLabel: "JavaScript",
    };
  }
  return {
    install: PYTHON_TESTING_SETUP_INSTALL,
    prompt: chat ? PYTHON_CHAT_SETUP_PROMPT : PYTHON_VOICE_SETUP_PROMPT,
    snippet: chat ? PYTHON_CHAT_SETUP_SNIPPET : PYTHON_VOICE_SETUP_SNIPPET,
    languageLabel: "Python",
  };
}

/**
 * The LiveKit testing work the web can explain but cannot perform.
 *
 * The customer owns the worker and its deployment. This component makes no
 * write and never claims that testing is ready. The first simulation is the
 * confirmation that the source integration works.
 */
export function LiveKitTestingInstructions({
  language,
  modality,
  onLanguageChange,
}: LiveKitTestingInstructionsProps) {
  const chat = modality === "chat";

  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="livekit-testing-title"
    >
      <h3
        className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
        data-setup-heading
        id="livekit-testing-title"
        tabIndex={-1}
      >
        Add simulation testing to your LiveKit agent
      </h3>

      <Tabs
        className="flex flex-col gap-3"
        value={language}
        onValueChange={(value) =>
          onLanguageChange(value as LiveKitWorkerLanguage)
        }
      >
        <p
          className="m-0 text-sm leading-(--line-normal) font-medium text-foreground"
          id="livekit-testing-language"
        >
          Show instructions for
        </p>
        <TabsList aria-labelledby="livekit-testing-language">
          <TabsTrigger value="python">Python</TabsTrigger>
          <TabsTrigger value="javascript">JavaScript</TabsTrigger>
        </TabsList>
        {language === "" ? null : (
          <>
            <TabsContent className="pt-3" value="python">
              <TestingSteps language="python" chat={chat} />
            </TabsContent>
            <TabsContent className="pt-3" value="javascript">
              <TestingSteps language="javascript" chat={chat} />
            </TabsContent>
          </>
        )}
      </Tabs>
      {language === "" ? null : (
        <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
          Production rooms keep the worker&apos;s existing behavior. Egma cannot
          see this change from here. The first simulation confirms it.
        </p>
      )}
    </section>
  );
}

function TestingSteps({
  language,
  chat,
}: {
  readonly language: LiveKitWorkerLanguage;
  readonly chat: boolean;
}) {
  const contract = testingContract(language, chat);
  const steps = [
    {
      title: "Give this to your coding agent",
      value: contract.prompt,
      copyLabel: "coding-agent prompt",
    },
    {
      title: "Install the latest Egma SDK",
      value: contract.install,
      copyLabel: "install command",
    },
    {
      title: `Apply the ${contract.languageLabel} testing contract`,
      value: contract.snippet,
      copyLabel: `${contract.languageLabel} testing code`,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        {chat
          ? `A ${contract.languageLabel} worker needs the Egma testing hook, silent chat-room options, and a registered dispatch name.`
          : `A ${contract.languageLabel} worker needs the Egma testing hook and a registered dispatch name.`}
        {language === "javascript"
          ? " This needs LiveKit Agents 1.5.0 or newer in the 1.x line."
          : null}
      </p>
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
    </div>
  );
}
