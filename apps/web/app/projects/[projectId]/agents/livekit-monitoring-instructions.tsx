"use client";

import Link from "next/link";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import { CopyBlock } from "./copy-block.tsx";

// Pinned, because the floor is what makes the guard hold. `monitor_livekit`
// reads the job's room name to tell a simulation from a production call, and
// 0.2.0 is the first release that does. An unpinned install can resolve to a
// release that looks in dispatch metadata instead, where Egma writes
// nothing at all — so on every one of the three LiveKit dispatch paths a
// simulation's spans arrive here as a production conversation.
const PYTHON_INSTALL = "pip install 'egma>=0.2.0'";
const PYTHON_HOOK = `from egma import monitor_livekit

async def entrypoint(ctx):
    monitor_livekit(ctx)
    session = AgentSession(...)
    await session.start(...)`;
const JAVASCRIPT_INSTALL = "npm install @egma/livekit";
const JAVASCRIPT_HOOK = `import { monitorLiveKit } from "@egma/livekit";

export async function entrypoint(ctx: JobContext) {
  monitorLiveKit(ctx);
  const session = new voice.AgentSession(...);
  await session.start(...);
}`;
const EGMA_URL_PLACEHOLDER = "<your-public-egma-url>";
const API_KEY_PLACEHOLDER = "<your-project-api-key>";

function environmentValues(egmaUrl: string): string {
  return `EGMA_URL=${egmaUrl}\nEGMA_API_KEY=${API_KEY_PLACEHOLDER}`;
}

type WorkerLanguage = "python" | "javascript";

function WorkerSteps({ language }: { readonly language: WorkerLanguage }) {
  const steps = [
    {
      title: "Install the Egma SDK",
      value:
        language === "python" ? PYTHON_INSTALL : JAVASCRIPT_INSTALL,
    },
    {
      title: "Add the hook before AgentSession.start",
      value: language === "python" ? PYTHON_HOOK : JAVASCRIPT_HOOK,
    },
    {
      title: "Set the environment values",
      value: environmentValues(EGMA_URL_PLACEHOLDER),
    },
  ] as const;

  return (
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
}: {
  readonly projectId: string;
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

      <Tabs defaultValue="python">
        <TabsList aria-label="Worker language" variant="line">
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
