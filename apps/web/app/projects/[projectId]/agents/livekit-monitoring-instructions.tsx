"use client";

import Link from "next/link";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { LiveKitWorkerLanguage } from "@/lib/agent-setup-flow.ts";

import { CopyBlock } from "./copy-block.tsx";

// The repository's package manager resolves the latest SDK. The source URL is
// unpinned for the same reason the public integration skill is unpinned: the
// installed CLI owns the current LiveKit source contract.
const PYTHON_INSTALL =
  "pip install 'egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python'";
const PYTHON_HOOK = `from egma import monitor_livekit

async def entrypoint(ctx):
    monitor_livekit(ctx)
    await ctx.connect()
    session = AgentSession(...)
    await session.start(...)`;
const JAVASCRIPT_INSTALL = "npm install @egma/livekit";
const JAVASCRIPT_HOOK = `import { monitorLiveKit } from "@egma/livekit";

export async function entrypoint(ctx: JobContext) {
  monitorLiveKit(ctx);
  await ctx.connect();
  const session = new voice.AgentSession(...);
  await session.start(...);
}`;
const EGMA_URL_PLACEHOLDER = "<your-public-egma-url>";
const API_KEY_PLACEHOLDER = "<your-project-api-key>";

function environmentValues(egmaUrl: string): string {
  return `EGMA_URL=${egmaUrl}\nEGMA_API_KEY=${API_KEY_PLACEHOLDER}`;
}

function WorkerSteps({
  language,
}: {
  readonly language: LiveKitWorkerLanguage;
}) {
  const steps = [
    {
      title: "Install the Egma SDK",
      value:
        language === "python" ? PYTHON_INSTALL : JAVASCRIPT_INSTALL,
      copyLabel: `${language} install command`,
    },
    {
      title: "Make the hook the first line of entrypoint",
      value: language === "python" ? PYTHON_HOOK : JAVASCRIPT_HOOK,
      copyLabel: `${language} monitoring code`,
    },
    {
      title: "Set the environment values",
      value: environmentValues(EGMA_URL_PLACEHOLDER),
      copyLabel: "environment values",
    },
  ] as const;

  return (
    <div className="flex flex-col gap-4">
      {language === "javascript" ? (
        <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
          JavaScript monitoring needs LiveKit Agents 1.5.5 or newer in the 1.x
          line.
        </p>
      ) : null}
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

/**
 * The LiveKit monitoring work the web can explain but cannot perform.
 *
 * The customer owns the worker and its deployment. This component therefore
 * makes no write and never claims that Monitoring is configured. A real
 * production trace is the only confirmation.
 */
export function LiveKitMonitoringInstructions({
  projectId,
  language,
  onLanguageChange,
}: {
  readonly projectId: string;
  readonly language: LiveKitWorkerLanguage;
  readonly onLanguageChange: (language: LiveKitWorkerLanguage) => void;
}) {
  return (
    <section className="flex flex-col gap-5" aria-labelledby="livekit-monitoring-title">
      <div className="flex flex-col gap-2">
        <h3
          className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
          data-setup-heading
          id="livekit-monitoring-title"
          tabIndex={-1}
        >
          Add monitoring to your LiveKit agent
        </h3>
      </div>

      <Tabs
        className="flex flex-col gap-3"
        value={language}
        onValueChange={(value) =>
          onLanguageChange(value as LiveKitWorkerLanguage)
        }
      >
        <p
          className="m-0 text-sm leading-(--line-normal) font-medium text-foreground"
          id="livekit-worker-language"
        >
          What language is your LiveKit worker?
        </p>
        <TabsList aria-labelledby="livekit-worker-language">
          <TabsTrigger value="python">Python</TabsTrigger>
          <TabsTrigger value="javascript">JavaScript</TabsTrigger>
        </TabsList>
        <TabsContent className="pt-3" value="python">
          <WorkerSteps language="python" />
        </TabsContent>
        <TabsContent className="pt-3" value="javascript">
          <WorkerSteps language="javascript" />
        </TabsContent>
      </Tabs>
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        Create a project key in{" "}
        <Link
          className="text-foreground underline underline-offset-2 pointer-hover:text-brand"
          href={`/projects/${encodeURIComponent(projectId)}/settings/keys`}
        >
          API keys
        </Link>
        , then replace {API_KEY_PLACEHOLDER}. Set {EGMA_URL_PLACEHOLDER} to the
        public Egma API URL that your deployed LiveKit worker can reach.
      </p>
    </section>
  );
}
