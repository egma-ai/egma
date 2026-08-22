import type { DiscoverRetellVoiceAgentsResponse } from "@egma/platform-api/client";

import { projectPath } from "./project-context.ts";

export type AgentPlatform = "retell" | "livekit_agents";

export type RetellAgentChoices = DiscoverRetellVoiceAgentsResponse;
export type RetellAgentChoice = RetellAgentChoices["agents"][number];

/**
 * Where somebody goes to start monitoring an agent.
 *
 * Monitoring is configured on the agent now, so the roster is the surface: the
 * pull switch lives on an agent's own page, and push needs no configuration at
 * all.
 */
export function agentRosterPath(projectId: string): string {
  return projectPath(projectId, "agents");
}
