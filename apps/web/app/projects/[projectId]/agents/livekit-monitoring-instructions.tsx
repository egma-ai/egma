"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const INSTALL = "pip install egma";
const HOOK = `from egma import monitor_livekit

async def entrypoint(ctx):
    monitor_livekit(ctx)
    session = AgentSession(...)
    await session.start(...)`;
const EGMA_URL_PLACEHOLDER = "<your-public-egma-url>";
const API_KEY_PLACEHOLDER = "<your-project-api-key>";

function environmentValues(egmaUrl: string): string {
  return `EGMA_URL=${egmaUrl}\nEGMA_API_KEY=${API_KEY_PLACEHOLDER}`;
}

function CopyBlock({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    if (navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="flex items-start justify-between gap-3 border border-border bg-surface-soft p-3">
      <pre className="m-0 min-w-0 overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-(--line-normal) text-foreground">
        {value}
      </pre>
      <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
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
}: {
  readonly projectId: string;
}) {
  const steps = [
    { title: "Install the Egma SDK", value: INSTALL },
    { title: "Add the hook before AgentSession.start", value: HOOK },
    {
      title: "Set the environment values",
      value: environmentValues(EGMA_URL_PLACEHOLDER),
    },
  ] as const;

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
