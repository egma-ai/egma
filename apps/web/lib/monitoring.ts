import type {
  DiscoverRetellVoiceAgentsResponse,
  ListMonitoringSourcesResponse,
} from "@egma/platform-api/client";

import { projectPath } from "./project-context.ts";

export type MonitoringPlatform = "retell" | "livekit_agents";

export type MonitoringSetups = ListMonitoringSourcesResponse;
export type MonitoringSetup = MonitoringSetups["monitoringSources"][number];
export type RetellMonitoredAgent = MonitoringSetup["agents"][number];
export type RetellAgentChoices = DiscoverRetellVoiceAgentsResponse;
export type RetellAgentChoice = RetellAgentChoices["agents"][number];

export function monitoringSetupPath(projectId: string): string {
  return projectPath(projectId, "monitoring", "setup");
}
