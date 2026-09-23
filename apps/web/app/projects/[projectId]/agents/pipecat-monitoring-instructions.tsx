"use client";

import {
  ENVIRONMENT_VALUES,
  InstructionSteps,
  ProjectKeyNote,
  type InstructionStep,
} from "./copy-block.tsx";
import { PIPECAT_INSTALL } from "./pipecat-testing-instructions.tsx";

export const PIPECAT_MONITORING_SNIPPET = `from egma.pipecat import monitor

worker = PipelineWorker(pipeline, ...)
await monitor(worker, runner_args)
await runner.add_workers(worker)`;

const STEPS = [
  {
    title: "Install the Egma SDK",
    value: PIPECAT_INSTALL,
    copyLabel: "install command",
  },
  {
    title: "Add the monitoring hook to bot()",
    value: PIPECAT_MONITORING_SNIPPET,
    copyLabel: "Python monitoring code",
  },
  {
    title: "Set the environment values where your bot runs",
    value: ENVIRONMENT_VALUES,
    copyLabel: "environment values",
  },
] satisfies readonly InstructionStep[];

/**
 * The Pipecat monitoring work the web can explain but cannot perform.
 *
 * The customer owns the bot and its deployment. This component therefore makes
 * no write and never claims that Monitoring is configured. A real production
 * trace is the only confirmation. Pipecat is Python only, so there is no
 * language choice.
 */
export function PipecatMonitoringInstructions({
  projectId,
}: {
  readonly projectId: string;
}) {
  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="pipecat-monitoring-title"
    >
      <h3
        className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
        data-setup-heading
        id="pipecat-monitoring-title"
        tabIndex={-1}
      >
        Add monitoring to your Pipecat agent
      </h3>
      <InstructionSteps steps={STEPS} />
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        This line sends production conversations. In an Egma simulation it does
        nothing, because the simulation line sends that conversation instead.
      </p>
      <ProjectKeyNote projectId={projectId} reachedBy="your deployed bot" />
    </section>
  );
}
