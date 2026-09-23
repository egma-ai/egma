"use client";

import {
  EgmaUrlNote,
  environmentValues,
  InstructionSteps,
  type InstructionStep,
} from "./copy-block.tsx";
import {
  MONITORING_KEY_PLACEHOLDER,
  monitoringKeyStep,
  PIPECAT_INSTALL,
} from "./pipecat-steps.ts";

export const PIPECAT_MONITORING_SNIPPET = `from egma.pipecat import monitor

worker = PipelineWorker(pipeline, ...)
await monitor(worker, runner_args)
await runner.add_workers(worker)`;

/** The numbered steps, in the order they are done. */
export function pipecatMonitoringSteps(
  agentId: string | null,
  registers: boolean,
): readonly InstructionStep[] {
  return [
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
    monitoringKeyStep(agentId, registers),
    {
      title: "Set the environment values where your bot runs",
      value: environmentValues(MONITORING_KEY_PLACEHOLDER),
      copyLabel: "environment values",
    },
  ];
}

/**
 * The Pipecat monitoring work the web can explain but cannot perform.
 *
 * The customer owns the bot and its deployment. This component therefore makes
 * no write and never claims that Monitoring is configured. A real production
 * trace is the only confirmation. Pipecat is Python only, so there is no
 * language choice.
 */
export function PipecatMonitoringInstructions({
  agentId,
  registers,
}: {
  /** The agent being set up, or null when the sheet has none yet. */
  readonly agentId: string | null;
  /** Whether the key step registers the agent too: a new, monitoring-only setup. */
  readonly registers: boolean;
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
      <InstructionSteps steps={pipecatMonitoringSteps(agentId, registers)} />
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        This line sends production conversations. In an Egma simulation it does
        nothing, because the simulation line sends that conversation instead.
      </p>
      <EgmaUrlNote reachedBy="your deployed bot" />
    </section>
  );
}
