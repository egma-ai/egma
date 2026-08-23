/**
 * The agent platform the repository evidence names.
 *
 * Discovery reports a free-text framework value because coding agents meet
 * many SDK names in the wild. This module is the one place that turns those
 * names into wizard routes. A platform not named here is still a valid find;
 * it simply has no connection setup in this CLI release.
 */

import type { Facts } from "./discovery.ts";

export type KnownAgentPlatform = "retell" | "livekit" | "pipecat" | "vapi";
export type SupportedAgentPlatform = Extract<KnownAgentPlatform, "retell" | "livekit">;

const PLATFORM_SIGNS: Readonly<Record<KnownAgentPlatform, readonly RegExp[]>> = {
  retell: [/\bretell(?:-sdk)?\b/iu],
  livekit: [/\blivekit(?:-agents)?\b/iu, /@livekit\/agents/iu],
  pipecat: [/\bpipecat(?:-ai)?\b/iu],
  vapi: [/\bvapi\b/iu],
};

/** The known platform in the discovery fact, or `null` when it is not clear. */
export function agentPlatformIn(facts: Facts): KnownAgentPlatform | null {
  const reported = facts.get("framework")?.trim() ?? "";
  if (reported === "") return null;

  const matched = (Object.entries(PLATFORM_SIGNS) as readonly [
    KnownAgentPlatform,
    readonly RegExp[],
  ][]).filter(([, signs]) => signs.some((sign) => sign.test(reported)));

  // One wizard setup must never combine evidence from two platforms. The
  // public finder can report both, but the CLI needs one unambiguous route.
  return matched.length === 1 ? matched[0]![0] : null;
}

export function isSupportedAgentPlatform(
  platform: KnownAgentPlatform,
): platform is SupportedAgentPlatform {
  return platform === "retell" || platform === "livekit";
}

/**
 * What a developer calls each agent platform, for the screens that name one.
 *
 * The vendors' own spellings, so a sentence about the repository reads the way
 * the repository's own dependency list does.
 */
const PLATFORM_LABELS: Readonly<Record<KnownAgentPlatform, string>> = {
  retell: "Retell",
  livekit: "LiveKit Agents",
  pipecat: "Pipecat",
  vapi: "Vapi",
};

export function agentPlatformLabel(platform: KnownAgentPlatform): string {
  return PLATFORM_LABELS[platform];
}
