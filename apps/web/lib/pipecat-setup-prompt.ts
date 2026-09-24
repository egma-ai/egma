import type { AgentSetupGoal } from "./agent-setup-flow.ts";

/** The agent the prompt names, when the sheet opened from one. */
export type PipecatPromptAgent = {
  readonly id: string;
  readonly name: string;
};

/**
 * What each goal asks the coding agent to do.
 *
 * The integrate-egma skill does the work: it installs the SDK, asks where the
 * bot runs, sets the connections and keys, and asks before any production
 * change. The prompt names the goal, and the facts only the web app knows.
 */
const GOALS: Readonly<
  Record<
    AgentSetupGoal,
    { readonly opening: string; readonly steps: readonly string[] }
  >
> = {
  simulation: {
    opening:
      "Set up Egma simulation testing for the Pipecat bot in this repository.",
    steps: [
      "Ask me where the bot should run for the simulations: on this machine, on Pipecat Cloud, or on my own servers.",
      "Run one test suite and send me the run link.",
    ],
  },
  monitoring: {
    opening:
      "Set up Egma production monitoring for the Pipecat bot in this repository.",
    steps: [
      "Ask me where the bot runs in production: on Pipecat Cloud, on my own servers, or not deployed yet.",
      "Tell me how to check that my production calls arrive in Egma.",
    ],
  },
  both: {
    opening:
      "Set up Egma simulation testing and production monitoring for the Pipecat bot in this repository.",
    steps: [
      "Ask me where the bot should run for the simulations, and where it runs in production.",
      "Run one test suite and send me the run link. Then tell me how to check that my production calls arrive in Egma.",
    ],
  },
};

/** The one prompt a coding agent sets a Pipecat agent up from. */
export function pipecatSetupPrompt({
  goal,
  egmaUrl,
  projectId,
  agent,
}: {
  readonly goal: AgentSetupGoal;
  readonly egmaUrl: string;
  readonly projectId: string;
  readonly agent: PipecatPromptAgent | null;
}): string {
  const { opening, steps } = GOALS[goal];
  const facts = [
    `Egma: ${egmaUrl}`,
    `Project: ${projectId}`,
    ...(agent === null ? [] : [`Agent: ${agent.name} (${agent.id})`]),
  ];
  const numbered = [
    "Install the Egma skills: npx --yes skills add egma-ai/egma",
    "Follow the integrate-egma skill. Sign in with egma login; I will approve it in my browser.",
    ...steps,
  ].map((step, index) => `${String(index + 1)}. ${step}`);
  return [
    opening,
    "",
    ...facts,
    "",
    ...numbered,
    "",
    "Ask me before you change anything in production. Never print or commit a key.",
  ].join("\n");
}
