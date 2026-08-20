import { projectPath } from "./project-context.ts";

export const MONITORING_API_PATH = "/api/monitoring";
export const RETELL_DISCOVERY_PATH = `${MONITORING_API_PATH}/retell/discover`;
export const RETELL_MONITORING_PATH = `${MONITORING_API_PATH}/retell`;
export const LIVEKIT_MONITORING_PATH = `${MONITORING_API_PATH}/livekit-agents`;

export type MonitoringPlatform = "retell" | "livekit_agents";

export type MonitoringHealth = {
  readonly state:
    | "healthy"
    | "invalid_credential"
    | "rate_limited"
    | "provider_unavailable";
  readonly blocked_until: string | null;
  readonly consecutive_failures: number;
  readonly last_error_at: string | null;
  readonly last_recovered_at: string | null;
  readonly last_received_at: string | null;
};

export type RetellMonitoredAgent = {
  readonly id: string;
  readonly platform_agent_id: string;
  readonly platform_agent_name: string;
  readonly state: "importing" | "active" | "degraded";
  readonly scan_kind: "historical_import" | "regular" | "reconciliation" | null;
  readonly last_success_at: string | null;
  readonly last_conversation_at: string | null;
  readonly last_error_kind: string | null;
  readonly last_error_at: string | null;
  readonly consecutive_failures: number;
  readonly failures: readonly RetellIngestionFailure[];
};

export type RetellIngestionFailure = {
  readonly id: string;
  readonly provider_call_id: string;
  readonly error_kind: string;
  readonly attempts: number;
  readonly status: "open";
  readonly last_attempt_at: string;
  readonly created_at: string;
};

export type MonitoringSetup = {
  readonly id: string;
  readonly project_id: string;
  readonly agent_platform: MonitoringPlatform;
  readonly strategy: "retell_api_polling" | "livekit_otlp";
  readonly credentials_hint: string | null;
  readonly health: MonitoringHealth;
  readonly agents: readonly RetellMonitoredAgent[];
};

export type MonitoringSetups = {
  readonly setups: readonly MonitoringSetup[];
};

export type RetellAgentChoice = {
  readonly id: string;
  readonly name: string;
};

export type RetellAgentChoices = {
  readonly agents: readonly RetellAgentChoice[];
};

export function monitoringSetupPath(projectId: string): string {
  return projectPath(projectId, "monitoring", "setup");
}

export function removeMonitoringPath(platform: MonitoringPlatform): string {
  return `${MONITORING_API_PATH}/${platform.replaceAll("_", "-")}`;
}

export function replayRetellFailurePath(failureId: string): string {
  return `${MONITORING_API_PATH}/retell/failures/${encodeURIComponent(failureId)}/replay`;
}
