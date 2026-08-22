import type { DiscoverRetellVoiceAgentsResponse } from "@egma/platform-api/client";

import { projectPath } from "./project-context.ts";

export type RetellAgentChoices = DiscoverRetellVoiceAgentsResponse;
export type RetellAgentChoice = RetellAgentChoices["agents"][number];

/** Where the start-monitoring flow lives. */
export function monitoringSetupPath(projectId: string): string {
  return projectPath(projectId, "monitoring", "setup");
}
