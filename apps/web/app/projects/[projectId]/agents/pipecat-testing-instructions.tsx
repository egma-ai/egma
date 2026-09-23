"use client";

import {
  ENVIRONMENT_VALUES,
  InstructionSteps,
  ProjectKeyNote,
  type InstructionStep,
} from "./copy-block.tsx";

/** Which Pipecat connection the instructions follow. */
export type PipecatAccess = "pipecat_cloud" | "self_hosted";

export const PIPECAT_INSTALL = 'pip install "egma[pipecat]"';

export const PIPECAT_TESTING_SNIPPET = `from egma.pipecat import simulation

worker = PipelineWorker(pipeline, ...)
await simulation(worker, runner_args)
await runner.add_workers(worker)`;

/** Recommended: one warm instance, so a cold start never fails a simulation. */
export const PIPECAT_WARM_INSTANCE = `[scaling]
min_agents = 1`;

export const PIPECAT_CLOUD_SECRETS = `pipecat cloud secrets set <your-secret-set> EGMA_URL=<your-public-egma-url> EGMA_API_KEY=<your-project-api-key>
pipecat cloud deploy`;

/** The development runner's default port, which `egma agent dev` fronts. */
const DEV_RUNNER_PORT = 7860;

export function pipecatDevCommand(agentId: string): string {
  return `egma agent dev --agent ${agentId} --port ${String(DEV_RUNNER_PORT)}`;
}

const PROMPT_START = `Set up Egma simulation testing for this repository's Pipecat bot.

Use the repository's existing dependency file and package manager to add the latest egma package with its pipecat extra, egma[pipecat]. Do not pin a version.

Where bot() builds its PipelineWorker, import simulation from egma.pipecat. After the PipelineWorker exists, and before the runner starts it with add_workers, call await simulation(worker, runner_args), passing the runner_args that bot() received down to that point.

This call is required for a Pipecat simulation and it fails closed: it raises egma.NotReported when the bot cannot report to Egma. Let that error stop the bot. Do not catch it, and do not start the worker without it.`;

const PROMPT_CLOUD = `Tell me the agent_name that pcc-deploy.toml deploys. If pcc-deploy.toml does not keep one instance warm, recommend min_agents = 1 under [scaling], so a cold start cannot fail a simulation; change it only if I agree.`;

const PROMPT_SELF_HOSTED = `Tell me the URL of the endpoint that starts the bot.`;

const PROMPT_END = `Preserve the production path, run the repository's focused checks, change nothing else, and leave every environment file unread.`;

export const PIPECAT_CLOUD_TESTING_PROMPT = `${PROMPT_START}

${PROMPT_CLOUD}

${PROMPT_END}`;

export const PIPECAT_SELF_HOSTED_TESTING_PROMPT = `${PROMPT_START}

${PROMPT_SELF_HOSTED}

${PROMPT_END}`;

/** The numbered steps for one Pipecat connection, in the order they are done. */
export function pipecatTestingSteps(
  access: PipecatAccess,
  agentId: string,
): readonly InstructionStep[] {
  const shared = [
    {
      title: "Give this to your coding agent",
      value:
        access === "pipecat_cloud"
          ? PIPECAT_CLOUD_TESTING_PROMPT
          : PIPECAT_SELF_HOSTED_TESTING_PROMPT,
      copyLabel: "coding-agent prompt",
    },
    {
      title: "Install the Egma SDK",
      value: PIPECAT_INSTALL,
      copyLabel: "install command",
    },
    {
      title: "Add the testing hook to bot()",
      value: PIPECAT_TESTING_SNIPPET,
      copyLabel: "Python testing code",
    },
  ] satisfies readonly InstructionStep[];
  if (access === "pipecat_cloud") {
    return [
      ...shared,
      {
        title: "Recommended: keep one instance warm in pcc-deploy.toml",
        value: PIPECAT_WARM_INSTANCE,
        copyLabel: "scaling settings",
      },
      {
        title: "Add the Egma values to your secret set and redeploy",
        value: PIPECAT_CLOUD_SECRETS,
        copyLabel: "secret set commands",
      },
    ];
  }
  return [
    ...shared,
    {
      title: "Set the environment values where your bot runs",
      value: ENVIRONMENT_VALUES,
      copyLabel: "environment values",
    },
    {
      title: "Test a bot running on this machine",
      value: pipecatDevCommand(agentId),
      copyLabel: "egma agent dev command",
    },
  ];
}

/**
 * The Pipecat testing work the web can explain but cannot perform.
 *
 * The customer owns the bot and its deployment. This component makes no write
 * and never claims that testing is ready. The first simulation is the
 * confirmation that the source integration works. Pipecat is Python only, so
 * there is no language choice.
 */
export function PipecatTestingInstructions({
  projectId,
  agentId,
  access,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly access: PipecatAccess;
}) {
  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="pipecat-testing-title"
    >
      <h3
        className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
        data-setup-heading
        id="pipecat-testing-title"
        tabIndex={-1}
      >
        Add simulation testing to your Pipecat agent
      </h3>
      <InstructionSteps steps={pipecatTestingSteps(access, agentId)} />
      <ProjectKeyNote projectId={projectId} reachedBy="your bot" />
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        Egma answers exactly the tools the running test names. Every other tool
        runs for real, and every call is on the simulation transcript.
      </p>
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        The Egma SDK is required for a Pipecat simulation, and it fails closed.
        A bot that cannot report to Egma raises NotReported and does not start.
        Production sessions keep the bot&apos;s existing behavior.
      </p>
    </section>
  );
}
