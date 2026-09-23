/** The agent platforms this CLI knows, in the order help and refusals name them. */

export const AGENT_PLATFORMS = ["retell", "livekit", "pipecat"] as const;

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** How the CLI names each platform in a sentence. */
export const AGENT_PLATFORM_LABELS: Readonly<Record<AgentPlatform, string>> = {
  retell: "Retell",
  livekit: "LiveKit",
  pipecat: "Pipecat",
};

export function isAgentPlatform(value: unknown): value is AgentPlatform {
  return (
    typeof value === "string" &&
    (AGENT_PLATFORMS as readonly string[]).includes(value)
  );
}

/** `retell, livekit or pipecat`, joined with a separator between the words. */
export function agentPlatformsSaid(prefix = ""): string {
  const words = AGENT_PLATFORMS.map((platform) => `${prefix}${platform}`);
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1) as string}`;
}

/** The one sentence every `--platform` refusal says. */
export const CHOOSE_PLATFORM = `Choose ${agentPlatformsSaid("--platform ")}.`;
