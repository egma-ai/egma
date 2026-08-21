import { productLabelOf } from "@egma/db";
import {
  listAgents,
  listNumbers,
  numbersAnswering,
  type Fetch as ProviderFetch,
  type RetellCredential,
} from "@egma/retell";

/**
 * The small, read-only Retell account seam used by provider setup.
 *
 * It accepts a key in memory, reads through the shared provider client, and
 * returns only normalized connection candidates. Product labels come from the
 * connection registry, so discovery cannot create a second naming rule.
 */

export type RetellConnectionCandidate =
  | {
      readonly agentPlatform: "retell";
      readonly connectionKind: "retell_chat_api";
      readonly accessVariant: "retell_chat_api.api_key";
      readonly modality: "chat";
      readonly productLabel: string;
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly agentPlatform: "retell";
      readonly connectionKind: "phone_number";
      readonly accessVariant: "phone_number.public_e164";
      readonly modality: "voice";
      readonly productLabel: string;
      readonly config: { readonly phoneNumber: string };
    };

export type RetellDiscoveredAgent = {
  readonly platformAgentId: string;
  readonly name: string;
  readonly connectionCandidates: readonly RetellConnectionCandidate[];
};

export type RetellAgentDiscovery =
  | { readonly kind: "ready"; readonly agents: readonly RetellDiscoveredAgent[] }
  | { readonly kind: "invalid_key" }
  | { readonly kind: "unavailable"; readonly message: string };

export type RetellDirectTargetCheck =
  | { readonly kind: "ready" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "retryable"; readonly message: string };

function credential(value: string): RetellCredential {
  return { reveal: () => value };
}

function discoveryFailure(
  result: { readonly kind: string },
): Exclude<RetellAgentDiscovery, { readonly kind: "ready" }> {
  return result.kind === "invalid-key"
    ? { kind: "invalid_key" }
    : {
        kind: "unavailable",
        message: "Retell could not read this account. Check its network and try again.",
      };
}

function chatCandidate(platformAgentId: string): RetellConnectionCandidate {
  return {
    agentPlatform: "retell",
    connectionKind: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: productLabelOf(
      "retell",
      "retell_chat_api",
      "retell_chat_api.api_key",
      "chat",
    ),
    config: { retellAgentId: platformAgentId },
  };
}

function phoneCandidate(phoneNumber: string): RetellConnectionCandidate {
  return {
    agentPlatform: "retell",
    connectionKind: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: productLabelOf(
      "retell",
      "phone_number",
      "phone_number.public_e164",
      "voice",
    ),
    config: { phoneNumber },
  };
}

export async function discoverRetellAgents(
  apiKey: string,
  fetchImpl: ProviderFetch = fetch,
): Promise<RetellAgentDiscovery> {
  const key = credential(apiKey);
  const reach = { fetchImpl, signal: AbortSignal.timeout(15_000) };
  const agents = await listAgents(key, reach);
  if (agents.kind !== "agents") return discoveryFailure(agents);

  // Chat setup is complete from the agent listing alone. Phone-number access
  // only adds candidates for voice agents, so its failure must not discard a
  // usable chat connection discovered by the successful account read.
  const listedNumbers = agents.agents.some((agent) => agent.modality === "voice")
    ? await listNumbers(key, reach)
    : undefined;
  const numbers = listedNumbers?.kind === "numbers" ? listedNumbers.numbers : [];

  return {
    kind: "ready",
    agents: agents.agents.map((agent) => ({
      platformAgentId: agent.id,
      name: agent.name,
      connectionCandidates:
        agent.modality === "chat"
          ? [chatCandidate(agent.id)]
          : numbersAnswering(numbers, agent.id).map(({ number }) =>
              phoneCandidate(number),
            ),
    })),
  };
}

/**
 * Prove that a Retell chat connection still points at a chat agent before its
 * credential is handed to the simulator.
 *
 * The connection contract fixes `retell_chat_api` to chat modality. Retell can
 * later reconfigure the platform agent as voice, so the provider listing is
 * the source of truth for the agent's current modality.
 */
export async function verifyRetellChatAgent(
  apiKey: string,
  agentId: string,
  fetchImpl: ProviderFetch = fetch,
  timeoutMilliseconds = 15_000,
): Promise<RetellDirectTargetCheck> {
  const wanted = agentId.trim();
  if (wanted === "") {
    return {
      kind: "blocked",
      message: "This Retell connection has no agent id and cannot be dispatched.",
    };
  }

  const listed = await listAgents(credential(apiKey), {
    fetchImpl,
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(15_000, timeoutMilliseconds)),
    ),
  });
  if (listed.kind === "invalid-key") {
    return {
      kind: "blocked",
      message:
        "Retell rejected this connection's stored API key. Update the connection through the API or CLI before starting another run.",
    };
  }
  if (listed.kind !== "agents") {
    return {
      kind: "retryable",
      message:
        "Retell did not answer while Egma checked this connection. Egma will try this simulation again on the next claim.",
    };
  }

  const target = listed.agents.find((agent) => agent.id === wanted);
  if (target === undefined) {
    return {
      kind: "blocked",
      message: `Retell no longer lists agent ${wanted}. Choose another agent before starting another run.`,
    };
  }
  if (target.modality === "voice") {
    return {
      kind: "blocked",
      message:
        `Retell agent ${wanted} is a voice agent, but this connection reaches Retell's Chat API and has chat modality. ` +
        "Add one of the agent's routed phone numbers as a Retell phone connection before starting another run.",
    };
  }
  return { kind: "ready" };
}
