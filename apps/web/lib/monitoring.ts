import type {
  DiscoverRetellVoiceAgentsResponse,
  StartMonitoringResponse,
} from "@egma/platform-api/client";

import { projectPath } from "./project-context.ts";

export type RetellAgentChoices = DiscoverRetellVoiceAgentsResponse;
export type RetellAgentChoice = RetellAgentChoices["agents"][number];
export type StartedMonitoring = StartMonitoringResponse["watching"][number];

/**
 * Where the start-monitoring flow lives.
 *
 * **The address says what happens there, and that is the whole rename.** It
 * used to be `monitoring/setup`, which named an object that no longer exists:
 * there is no monitoring setup row, no per-platform integration, and nothing
 * on that page to save. What a person does there is *start monitoring* one
 * agent — the only stored monitoring choice in the product (ADR-0015).
 */
export function startMonitoringPath(projectId: string): string {
  return projectPath(projectId, "monitoring", "start");
}

/**
 * Which platform a connection pins, where its type pins one at all.
 *
 * `connection.agentPlatform` was deleted with ticket 01: the connection type
 * answers the question where it can, and `phone_number` spans platforms so it
 * answers nothing. The agent's own `agentPlatform` is the other answer, and
 * neither one is guessed from the other.
 */
export function platformOfConnectionType(
  connectionType: string,
): "retell" | "livekit_agents" | null {
  if (connectionType === "retell_chat_api") return "retell";
  if (connectionType === "livekit_room") return "livekit_agents";
  return null;
}

/**
 * The Retell agent id a connection already knows, or nothing.
 *
 * A Retell chat connection holds `retellAgentId` in its config because that is
 * how the simulator reaches it, and it happens to be the same identity pull
 * asks Retell about — so it prefills the binding. A phone connection holds a
 * number and knows nothing about which Retell agent answers it, so it prefills
 * nothing, and this returns nothing rather than a guess.
 */
export function platformAgentIdIn(connection: {
  readonly connectionType: string;
  readonly config: Readonly<Record<string, string>>;
}): string | undefined {
  if (connection.connectionType !== "retell_chat_api") return undefined;
  const held = connection.config.retellAgentId;
  return held === undefined || held === "" ? undefined : held;
}
