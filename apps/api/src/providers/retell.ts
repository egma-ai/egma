import { productLabelOf } from "@egma/db";
import {
  confirmNumber,
  listAgents,
  listNumbers,
  numbersAnswering,
  type Fetch as ProviderFetch,
  type RetellCredential,
} from "@egma/retell";

import { readTextModeWorld } from "./retell-run-start.ts";

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
      readonly connectionType: "retell_text_mode";
      readonly accessVariant: "retell_text_mode.api_key";
      readonly modality: "chat";
      readonly productLabel: string;
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly agentPlatform: "retell";
      readonly connectionType: "retell_chat_api";
      readonly accessVariant: "retell_chat_api.api_key";
      readonly modality: "chat";
      readonly productLabel: string;
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly agentPlatform: "retell";
      readonly connectionType: "retell_web_call";
      readonly accessVariant: "retell_web_call.api_key";
      readonly modality: "voice";
      readonly productLabel: string;
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly agentPlatform: "retell";
      readonly connectionType: "phone_number";
      readonly accessVariant: "phone_number.public_e164";
      readonly modality: "voice";
      readonly productLabel: string;
      readonly config: { readonly phoneNumber: string };
    };

export type RetellDiscoveredAgent = {
  readonly platformAgentId: string;
  readonly name: string;
  /** Retell's own channel, even when this agent has no usable route yet. */
  readonly modality: "voice" | "chat";
  readonly connectionCandidates: readonly RetellConnectionCandidate[];
};

export type RetellAgentDiscovery =
  | { readonly kind: "ready"; readonly agents: readonly RetellDiscoveredAgent[] }
  | { readonly kind: "invalid_key" }
  | { readonly kind: "unavailable"; readonly message: string };

export type RetellCandidateConfirmation =
  | {
      readonly kind: "ready";
      readonly candidate: RetellConnectionCandidate;
    }
  | { readonly kind: "invalid_key" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

type RetellCandidateToConfirm =
  | {
      readonly connectionType: "retell_text_mode";
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly connectionType: "retell_chat_api";
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly connectionType: "retell_web_call";
      readonly config: { readonly retellAgentId: string };
    }
  | {
      readonly connectionType: "phone_number";
      readonly config: { readonly phoneNumber: string };
    };

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
    connectionType: "retell_chat_api",
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

/**
 * The web-call lane, offered for every Retell voice agent.
 *
 * **It is offered whether or not the agent has a telephone number**, and that
 * is the difference between it and the phone candidate beside it: Egma creates
 * this call itself against the agent, so there is nothing to be routed and
 * nothing to dial. It is also the lane a mocked run is conducted over — the
 * published number is never dialled for one — so an agent whose only candidate
 * was its phone number would be an agent the tick could do nothing for.
 *
 * A web call is WebRTC and not the phone band, so a simulation over it is a
 * different unit from a phone simulation of the same agent. The registry's
 * connection-band rule is what keeps the two from being compared; this only
 * offers the choice.
 */
function webCallCandidate(platformAgentId: string): RetellConnectionCandidate {
  return {
    agentPlatform: "retell",
    connectionType: "retell_web_call",
    accessVariant: "retell_web_call.api_key",
    modality: "voice",
    productLabel: productLabelOf(
      "retell",
      "retell_web_call",
      "retell_web_call.api_key",
      "voice",
    ),
    config: { retellAgentId: platformAgentId },
  };
}

function textModeCandidate(
  platformAgentId: string,
): RetellConnectionCandidate {
  return {
    agentPlatform: "retell",
    connectionType: "retell_text_mode",
    accessVariant: "retell_text_mode.api_key",
    modality: "chat",
    productLabel: productLabelOf(
      "retell",
      "retell_text_mode",
      "retell_text_mode.api_key",
      "chat",
    ),
    config: { retellAgentId: platformAgentId },
  };
}

function phoneCandidate(phoneNumber: string): RetellConnectionCandidate {
  return {
    agentPlatform: "retell",
    connectionType: "phone_number",
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
  const listed = await listAgents(key, reach);
  if (listed.kind !== "agents") return discoveryFailure(listed);

  // **Voice agents only.** Egma registers a Retell voice agent and asks how to
  // test it — in text, over a web call, or by dialling its number. A
  // chat-native Retell agent is a different product question, and offering one
  // here would put a door in front of a person that no part of the product is
  // built around. The `retell_chat_api` lane stays in the tree, dormant: rows
  // already written through it still read and still conduct.
  const agents = {
    ...listed,
    agents: listed.agents.filter((agent) => agent.modality === "voice"),
  };

  // A voice agent without a listed number is a real provider fact. Do not turn
  // a failed number listing into that fact: the UI would disable a routed
  // agent and tell the person it has no phone number. Discovery therefore
  // succeeds only after every provider read needed to describe the account
  // succeeds.
  const listedNumbers =
    agents.agents.length > 0 ? await listNumbers(key, reach) : undefined;
  if (listedNumbers !== undefined && listedNumbers.kind !== "numbers") {
    return discoveryFailure(listedNumbers);
  }
  const numbers = listedNumbers?.numbers ?? [];

  return {
    kind: "ready",
    agents: agents.agents.map((agent) => ({
      platformAgentId: agent.id,
      name: agent.name,
      modality: agent.modality,
      connectionCandidates: [
        // The chat door a voice agent otherwise has none of: text mode
        // conducts a chat simulation of it in text. Offered for every voice
        // agent, because whether its engine is one text mode can reach is a
        // question answered when the connection is confirmed, not one
        // discovery can answer from a listing.
        textModeCandidate(agent.id),
        // The web call: it needs nothing of the customer's to be routed, it is
        // what a mocked run is conducted over, and it is the one voice lane
        // every voice agent has.
        webCallCandidate(agent.id),
        ...numbersAnswering(numbers, agent.id).map(({ number }) =>
          phoneCandidate(number),
        ),
      ],
    })),
  };
}

/**
 * Re-read one candidate immediately before the generic connection write.
 *
 * Discovery is only a snapshot. This check keeps provider-specific routing
 * behind the provider seam while the public mutation remains the ordinary
 * agent-rooted connection create.
 */
export async function confirmRetellCandidate(
  apiKey: string,
  platformAgentId: string,
  candidate: RetellCandidateToConfirm,
  fetchImpl: ProviderFetch = fetch,
  /**
   * Where Retell answers for this connection, when its config names somewhere
   * other than Retell's own address.
   *
   * **The same address the run start will use.** The door and the run ask one
   * question — is this agent's engine one this lane can reach — and two
   * different servers could answer it two different ways: a connection
   * confirmed against Retell and then conducted against a proxy would have
   * been checked somewhere it never runs.
   */
  baseUrl?: string | undefined,
): Promise<RetellCandidateConfirmation> {
  const key = credential(apiKey);
  const reach = {
    ...(baseUrl === undefined ? {} : { url: baseUrl }),
    fetchImpl,
    signal: AbortSignal.timeout(15_000),
  };
  const agents = await listAgents(key, reach);
  if (agents.kind === "invalid-key") return { kind: "invalid_key" };
  if (agents.kind !== "agents") {
    return {
      kind: "unavailable",
      message: "Retell could not confirm this connection. Check its network and try again.",
    };
  }

  const agent = agents.agents.find((one) => one.id === platformAgentId);
  if (agent === undefined) {
    return {
      kind: "rejected",
      message:
        "Retell no longer lists that agent. Load the account again and choose another agent.",
    };
  }

  if (candidate.connectionType === "retell_text_mode") {
    if (
      candidate.config.retellAgentId !== platformAgentId ||
      agent.modality !== "voice"
    ) {
      return {
        kind: "rejected",
        message:
          "The Retell text mode tests a Retell **voice** agent in text. That " +
          "agent is not one; a Retell chat agent is reached through the Chat " +
          "API instead.",
      };
    }

    // **The engine is read here, beside the listing, because the engine is a
    // platform fact.** A custom LLM's brain and tools live on the customer's
    // own socket server, so this lane cannot reach it — and being told that
    // when the connection is registered is a sentence to act on, where being
    // told it at the first run is a suite that will not start for a reason
    // nobody expected. The run start asks the same question again through the
    // same read, so the two refusals are one sentence in one place.
    const world = await readTextModeWorld(
      {
        apiKey,
        agentId: platformAgentId,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      },
      fetchImpl,
    );
    if (world.kind === "refused") {
      return { kind: "rejected", message: world.message };
    }
    if (world.kind !== "world") {
      return { kind: "unavailable", message: world.message };
    }
    return { kind: "ready", candidate: textModeCandidate(platformAgentId) };
  }

  if (candidate.connectionType === "retell_chat_api") {
    if (
      candidate.config.retellAgentId !== platformAgentId ||
      agent.modality !== "chat"
    ) {
      return {
        kind: "rejected",
        message:
          "That Retell agent is no longer available through the Chat API. Load the account again and choose an available connection.",
      };
    }
    return { kind: "ready", candidate: chatCandidate(platformAgentId) };
  }

  if (agent.modality !== "voice") {
    return {
      kind: "rejected",
      message: "That Retell agent is chat-only. Choose a voice agent.",
    };
  }

  if (candidate.connectionType === "retell_web_call") {
    // Nothing else to confirm: Egma creates this call itself against the
    // agent, so the agent still being a listed voice agent is the whole of
    // what has to still be true.
    if (candidate.config.retellAgentId !== platformAgentId) {
      return {
        kind: "rejected",
        message:
          "That web-call connection names a different Retell agent. Load the account again and choose an available connection.",
      };
    }
    return { kind: "ready", candidate: webCallCandidate(platformAgentId) };
  }

  const number = await confirmNumber(key, candidate.config.phoneNumber, reach);
  if (number.kind === "invalid-key") return { kind: "invalid_key" };
  if (number.kind === "refused" || number.kind === "unreachable") {
    return {
      kind: "unavailable",
      message: "Retell could not confirm this route. Check its network and try again.",
    };
  }
  if (number.kind === "gone") {
    return {
      kind: "rejected",
      message:
        "Retell no longer lists that phone number. Load the account again and choose another number.",
    };
  }
  if (!number.number.answeredBy.includes(platformAgentId)) {
    return {
      kind: "rejected",
      message:
        "That phone number is no longer routed to the selected agent. Load the account again.",
    };
  }
  return { kind: "ready", candidate: phoneCandidate(number.number.number) };
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
