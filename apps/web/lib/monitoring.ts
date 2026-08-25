import type { StartMonitoringResponse } from "@egma/platform-api/client";

import type { ListedAgentWithConnections } from "./agents.ts";
import { projectPath } from "./project-context.ts";
import { agentPlatformLabel, transcriptsPath } from "./transcripts.ts";

/**
 * One entry a start commit was asked for and did not start, and why.
 *
 * **A refusal is per entry, not per request.** Starting one agent is a whole
 * act on its own, so an entry that loses the one-switched-on-agent rule is
 * reported as itself — and the sentence that comes back is the database's rule
 * in words, which the picker relays rather than paraphrases.
 *
 * The other shapes this file used to publish — the discovery listing, the
 * started-watch row, the whole two-list outcome — went with the page that read
 * them. The picker asks for one entry and shows what came back; a type nothing
 * names is a type nothing keeps true.
 */
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
 *
 * **`from` is the query the person is already on, and it is merged rather than
 * replaced.** Building a fresh one would drop the window they had chosen — the
 * list behind the sheet would jump from the last thirty days back to the last
 * day the moment the sheet opened, and closing it would leave them there. "On
 * the URL the person is already on" has to mean the whole of that URL.
 */
export function monitorAgentPath(
  projectId: string,
  from?: URLSearchParams | string,
  agentId?: string,
): string {
  const asked = new URLSearchParams(
    typeof from === "string" ? from : (from?.toString() ?? ""),
  );
  asked.set(SHEET_PARAMETER, MONITOR_SHEET);
  if (agentId === undefined) asked.delete(AGENT_PARAMETER);
  else asked.set(AGENT_PARAMETER, agentId);
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
 * **This reads the connection's *type*, not its `agentPlatform` field.** That
 * field exists and other screens read it; what it cannot always answer is this
 * question, because a connection may carry the platform its agent declared
 * rather than one its own shape proves. The type is the proof: a Retell chat
 * connection can only be Retell, a LiveKit room can only be LiveKit, and
 * `phone_number` spans both so it answers nothing rather than guessing. Where
 * it answers nothing the agent's own `agentPlatform` decides, above.
 */
export function platformOfConnectionType(
  connectionType: string,
): "retell" | "livekit" | null {
  if (connectionType === "retell_chat_api") return "retell";
  if (connectionType === "livekit_room") return "livekit";
  return null;
}
