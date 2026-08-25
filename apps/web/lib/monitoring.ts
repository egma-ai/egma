import type {
  DiscoverRetellVoiceAgentsResponse,
  StartMonitoringResponse,
} from "@egma/platform-api/client";

import type { ListedAgentWithConnections } from "./agents.ts";
import { projectPath } from "./project-context.ts";
import { agentPlatformLabel, transcriptsPath } from "./transcripts.ts";

export type RetellAgentChoices = DiscoverRetellVoiceAgentsResponse;
export type RetellAgentChoice = RetellAgentChoices["agents"][number];
export type StartedMonitoring = StartMonitoringResponse["watching"][number];

/**
 * What one start commit turned out to be, tick by tick.
 *
 * Two lists rather than one answer, because starting an agent is a whole act
 * on its own: one tick can lose the one-switched-on-agent rule while the ticks
 * beside it start, and both facts have to reach the person.
 */
export type StartOutcome = StartMonitoringResponse;
export type RefusedWatch = StartMonitoringResponse["refused"][number];

/**
 * The old Start-monitoring address, kept as a deep link and nothing else.
 *
 * The full page it named is retired: monitoring is one verb on the Transcripts
 * screen now, and the route that survives renders that screen with the picker
 * already open. Anything already pointing here — the CLI, the docs, somebody's
 * notes — still lands where it meant to, and carries its `?agent=` through.
 */
export function startMonitoringPath(projectId: string, agentId?: string): string {
  const path = projectPath(projectId, "monitoring", "start");
  return agentId === undefined
    ? path
    : `${path}?agent=${encodeURIComponent(agentId)}`;
}

/** The query the Transcripts screen reads a sheet out of, and its one value. */
export const SHEET_PARAMETER = "sheet";
export const MONITOR_SHEET = "monitor";
export const AGENT_PARAMETER = "agent";

/**
 * Where "Monitor an agent" leads: **the address the person is already on**,
 * with the picker asked for in the query.
 *
 * That is the whole of the blanket rule made concrete. A sheet is a state of
 * the Transcripts screen rather than a page of its own, so opening one is a
 * push onto the same path: nothing reloads, Back closes it, and a copied link
 * reopens exactly what the sender was looking at.
 */
export function monitorAgentPath(projectId: string, agentId?: string): string {
  const asked = new URLSearchParams({ [SHEET_PARAMETER]: MONITOR_SHEET });
  if (agentId !== undefined) asked.set(AGENT_PARAMETER, agentId);
  return `${transcriptsPath(projectId)}?${asked.toString()}`;
}

/**
 * Which platform the picker treats an agent as being on.
 *
 * The agent's own binding is the answer wherever it has one, because that is
 * the fact monitoring is stored against. A connection answers only where its
 * type pins one platform, and `phone_number` pins none.
 *
 * **An agent that answers neither is treated as Retell**, and that is a
 * decision rather than a guess: Retell is the pull platform, so it is the only
 * branch with anything to do, and starting pull is exactly the act that writes
 * the binding this agent is missing. The board draws no platform control, so
 * there is nowhere to ask.
 */
export function pickerPlatformOf(
  agent: Pick<ListedAgentWithConnections, "agentPlatform" | "connections">,
): "retell" | "livekit" {
  if (agent.agentPlatform === "retell" || agent.agentPlatform === "livekit") {
    return agent.agentPlatform;
  }
  for (const connection of agent.connections) {
    const named = platformOfConnectionType(connection.connectionType);
    if (named !== null) return named;
  }
  return "retell";
}

/**
 * Whether an agent belongs in the picker at all.
 *
 * **Retell-precise and LiveKit-approximate, on purpose.** A Retell agent
 * leaves the list the moment its pull switch is on, because that switch is a
 * stored fact. A LiveKit agent stays listed always, because there is no
 * LiveKit monitored-state to read — push stores nothing, and inventing a row
 * to remember that somebody once read the instructions would contradict the
 * stores-nothing ruling. Re-opening idempotent instructions is harmless.
 */
export function notYetMonitored(
  agent: Pick<
    ListedAgentWithConnections,
    "agentPlatform" | "connections" | "pullProductionCalls"
  >,
): boolean {
  return pickerPlatformOf(agent) === "livekit" || !agent.pullProductionCalls;
}

/**
 * How one agent reads in the picker: its name, then the platform that decides
 * which half of the sheet it opens. Board `JN2-0` draws `Support line · Retell`.
 */
export function pickerAgentLabel(
  agent: Pick<ListedAgentWithConnections, "name" | "agentPlatform" | "connections">,
): string {
  return `${agent.name} · ${agentPlatformLabel(pickerPlatformOf(agent))}`;
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
): "retell" | "livekit" | null {
  if (connectionType === "retell_chat_api") return "retell";
  if (connectionType === "livekit_room") return "livekit";
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
