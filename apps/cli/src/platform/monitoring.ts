/**
 * Watching an agent's production traffic, from the terminal.
 *
 * Four operations and no fifth: discover the Retell account a key opens, start
 * watching, stop watching, and read what an agent says about itself. They are
 * the shipped public contract and this module is a wrapper over the generated
 * client — the CLI adds workflow, never protocol.
 *
 * **Discovery is server-side, and that is the point.** Egma asks Retell; the
 * terminal never does. So the list that comes back is the only one that knows
 * which of the account's agents this project already registers and which of
 * those already pull — which is what makes it a picker rather than a catalogue,
 * and why the CLI has no Retell client on this path at all.
 *
 * **Starting is one commit.** The same request seals the key onto the agent's
 * row, turns the switch on, and — for a platform agent this project does not
 * register yet — writes the agent row, because watching an unregistered
 * platform agent *means* registering it (ADR-0015). There is no per-agent
 * start, no 404 and no 409: a request naming at least one platform agent is
 * answered entry by entry, and an entry that could not start is a refusal
 * beside the ones that did.
 *
 * **The key passes through and is never held.** It arrives as something that
 * has to be asked for its value, goes into one request body, and this module
 * writes it nowhere — no field, no log line, no error message.
 */

import {
  discoverRetellVoiceAgents as discoverRequest,
  getAgent as getAgentRequest,
  startMonitoring as startRequest,
  stopMonitoring as stopRequest,
} from "@egma/platform-api/client";

import {
  commonFailure,
  requestOptions,
  type CommonFailure,
  type RegisterOptions,
} from "./agents.ts";
import { platformText } from "./client.ts";

/** Something holding a platform key, which has to be asked for its value. */
export type RevealableKey = { reveal(): string };

/** One voice agent on the Retell account a pasted key opens. */
export type DiscoveredAgent = {
  /** Retell's own id for it, which is what a watch entry names. */
  readonly platformAgentId: string;
  readonly name: string;
  /** The Egma agent already bound to it, or `null`. */
  readonly registeredAgentId: string | null;
  readonly registeredAgentName: string | null;
  /** Whether that Egma agent already pulls this platform agent's calls. */
  readonly pullProductionCalls: boolean;
};

export type Discovered =
  | { readonly kind: "agents"; readonly agents: readonly DiscoveredAgent[] }
  /**
   * Egma asked Retell with that key and Retell said no.
   *
   * Its own kind, because it is the one refusal worth offering the box again
   * for: the developer can fix it by pasting a different key. Retell being
   * unreachable is not that, and comes back as an ordinary refusal.
   */
  | { readonly kind: "refused-key"; readonly reason: string }
  | CommonFailure;

/** One platform agent a start is asked to watch. */
export type Watch = {
  readonly platformAgentId: string;
  /**
   * What to call the agent row this creates, when it creates one.
   *
   * Left out for a platform agent Egma already registers: naming an existing
   * row would be renaming somebody's agent because a second surface spells it
   * differently.
   */
  readonly name?: string | undefined;
  /** The Egma agent to watch it from, when the flow started from one. */
  readonly agentId?: string | undefined;
};

/** One platform agent now pulling its production calls. */
export type Watching = {
  readonly agentId: string;
  readonly agentName: string;
  readonly platformAgentId: string;
  /** Whether this commit brought the agent row into existence. */
  readonly created: boolean;
  readonly pullProductionCalls: boolean;
};

/** Why one ticked platform agent did not start. */
export type StartRefusalReason =
  | "contested"
  | "name_taken"
  | "not_found"
  | "archived";

export type StartRefusal = {
  readonly platformAgentId: string;
  readonly reason: StartRefusalReason;
  /** The platform's own sentence, relayed word for word for whatever reads. */
  readonly message: string;
};

export type Started =
  | {
      readonly kind: "started";
      readonly watching: readonly Watching[];
      readonly refused: readonly StartRefusal[];
    }
  | CommonFailure;

/** What an agent says about its own monitoring, and how Egma reaches it. */
export type AgentMonitoring = {
  readonly agentId: string;
  readonly agentName: string;
  readonly projectId: string;
  /** An archived agent is not a living monitoring target. */
  readonly archived: boolean;
  /** Which platform runs this agent, or `null` while nobody has bound it. */
  readonly agentPlatform: string | null;
  readonly platformAgentId: string | null;
  /** The last characters of the sealed monitoring key, or `null`. */
  readonly monitoringApiKeyHint: string | null;
  readonly pullProductionCalls: boolean;
  /** When a production call last arrived, or `null` while none has. */
  readonly lastReceivedAt: string | null;
  /**
   * The platforms this agent's living connections reach.
   *
   * Read because an agent registered by `egma connect` holds no binding of its
   * own — the binding arrived with monitoring, which is the decision that
   * needs it — while its connections have always known which platform they
   * reach. It is what lets a verb work out the platform instead of asking.
   */
  readonly connectionPlatforms: readonly string[];
  /** Retell's own id for the agent, as a living connection names it. */
  readonly connectionPlatformAgentIds: readonly string[];
};

export type ReadMonitoring =
  | { readonly kind: "monitoring"; readonly monitoring: AgentMonitoring }
  | { readonly kind: "not-found" }
  | CommonFailure;

export type Stopped =
  | { readonly kind: "stopped"; readonly monitoring: AgentPullState }
  | { readonly kind: "not-found" }
  | CommonFailure;

/** What stopping answers: the switch, the binding, the hint, the last arrival. */
export type AgentPullState = {
  readonly agentId: string;
  readonly pullProductionCalls: boolean;
  readonly agentPlatform: string | null;
  readonly platformAgentId: string | null;
  readonly monitoringApiKeyHint: string | null;
  readonly lastReceivedAt: string | null;
};

const NOTHING_SAID =
  "Egma answered without saying what it holds. Check that this Egma platform is up to date.";

/**
 * The Retell account this key opens, with what this project already knows
 * about each of its agents.
 *
 * The key goes into one request body and nowhere else. A key Retell will not
 * take comes back as a refusal carrying Egma's own sentence, which is what a
 * screen shows above the box when it asks again.
 */
export async function discoverRetellAgents(
  apiKey: RevealableKey,
  options: RegisterOptions,
): Promise<Discovered> {
  const answer = await discoverRequest(
    { apiKey: apiKey.reveal() },
    requestOptions(options),
  );

  // 422 is the key: Egma reached Retell and Retell would not take it. Every
  // other refusal — including Retell not answering at all — is the platform's
  // to explain and nobody's to fix by typing again.
  if (answer.response?.status === 422) {
    return {
      kind: "refused-key",
      reason: platformText(
        (answer.error as { message?: unknown } | undefined)?.message,
      ),
    };
  }
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  if (answer.data === undefined) {
    return { kind: "refused", reason: NOTHING_SAID };
  }

  return {
    kind: "agents",
    agents: answer.data.agents.map((one) => ({
      platformAgentId: platformText(one.id),
      name: platformText(one.name),
      registeredAgentId:
        one.registeredAgentId === null ? null : platformText(one.registeredAgentId),
      registeredAgentName:
        one.registeredAgentName === null
          ? null
          : platformText(one.registeredAgentName),
      pullProductionCalls: one.pullProductionCalls,
    })),
  };
}

/**
 * Start pulling one or more platform agents' production calls.
 *
 * Every entry is attempted and every entry is answered, so the result carries
 * both lists. A caller watching one agent reads the one entry it sent; nothing
 * about the shape changes for the day a caller ticks several.
 */
export async function startMonitoring(
  input: {
    readonly agentPlatform: "retell";
    readonly apiKey: RevealableKey;
    readonly watch: readonly Watch[];
    /** Which project the agents land in. Omit for the key's own. */
    readonly projectId?: string | undefined;
  },
  options: RegisterOptions,
): Promise<Started> {
  const answer = await startRequest(
    {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      agentPlatform: input.agentPlatform,
      apiKey: input.apiKey.reveal(),
      watch: input.watch.map((one) => ({
        platformAgentId: one.platformAgentId,
        ...(one.name === undefined ? {} : { name: one.name }),
        ...(one.agentId === undefined ? {} : { agentId: one.agentId }),
      })),
    },
    requestOptions(options),
  );

  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  if (answer.data === undefined) {
    return { kind: "refused", reason: NOTHING_SAID };
  }

  return {
    kind: "started",
    watching: answer.data.watching.map((one) => ({
      agentId: platformText(one.agentId),
      agentName: platformText(one.agentName),
      platformAgentId: platformText(one.platformAgentId),
      created: one.created,
      pullProductionCalls: one.pullProductionCalls,
    })),
    refused: answer.data.refused.map((one) => ({
      platformAgentId: platformText(one.platformAgentId),
      reason: one.reason,
      message: platformText(one.message),
    })),
  };
}

/**
 * Stop pulling one agent's production calls.
 *
 * Everything stored stays stored — the transcripts, the binding, the sealed
 * key — because the switch is what makes an agent due, so turning it off is the
 * whole of stopping.
 */
export async function stopMonitoring(
  agentId: string,
  options: RegisterOptions,
): Promise<Stopped> {
  const answer = await stopRequest({ agentId }, requestOptions(options));

  if (answer.response?.status === 404) return { kind: "not-found" };
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  if (answer.data === undefined) {
    return { kind: "refused", reason: NOTHING_SAID };
  }

  const state = answer.data.monitoring;
  return {
    kind: "stopped",
    monitoring: {
      agentId: platformText(state.agentId),
      pullProductionCalls: state.pullProductionCalls,
      agentPlatform:
        state.agentPlatform === null ? null : platformText(state.agentPlatform),
      platformAgentId:
        state.platformAgentId === null ? null : platformText(state.platformAgentId),
      monitoringApiKeyHint:
        state.monitoringApiKeyHint === null
          ? null
          : platformText(state.monitoringApiKeyHint),
      lastReceivedAt: state.lastReceivedAt,
    },
  };
}

/**
 * What one agent says about its own monitoring, plus how Egma reaches it.
 *
 * The agent read is the one that carries every fact a status line prints and
 * the one a brief wait polls: whether it pulls, what it is bound to, the hint
 * for its sealed key, and when a production call last arrived.
 */
export async function readAgentMonitoring(
  agentId: string,
  options: RegisterOptions,
): Promise<ReadMonitoring> {
  const answer = await getAgentRequest({ agentId }, requestOptions(options));

  if (answer.response?.status === 404) return { kind: "not-found" };
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  if (answer.data === undefined) {
    return { kind: "refused", reason: NOTHING_SAID };
  }

  const agent = answer.data.agent;
  const connections = answer.data.connections;
  return {
    kind: "monitoring",
    monitoring: {
      agentId: platformText(agent.id),
      agentName: platformText(agent.name),
      projectId: platformText(agent.projectId),
      archived: agent.archived,
      agentPlatform:
        agent.agentPlatform === null ? null : platformText(agent.agentPlatform),
      platformAgentId:
        agent.platformAgentId === null ? null : platformText(agent.platformAgentId),
      monitoringApiKeyHint:
        agent.monitoringApiKeyHint === null
          ? null
          : platformText(agent.monitoringApiKeyHint),
      pullProductionCalls: agent.pullProductionCalls,
      lastReceivedAt: agent.lastReceivedAt ?? null,
      connectionPlatforms: [
        ...new Set(
          connections.flatMap((one) =>
            one.agentPlatform === null ? [] : [platformText(one.agentPlatform)],
          ),
        ),
      ],
      connectionPlatformAgentIds: [
        ...new Set(
          connections.flatMap((one) => {
            const named = one.config["retellAgentId"];
            return named === undefined || named === "" ? [] : [named];
          }),
        ),
      ],
    },
  };
}
