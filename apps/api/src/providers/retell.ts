import {
  confirmNumber,
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
 * returns only the identities and routed numbers the setup screen needs.
 */

export type RetellRoutedNumber = {
  readonly number: string;
  readonly label: string;
};

export type RetellVoiceAgent = {
  readonly id: string;
  readonly name: string;
  readonly numbers: readonly RetellRoutedNumber[];
};

export type RetellVoiceDiscovery =
  | { readonly kind: "ready"; readonly agents: readonly RetellVoiceAgent[] }
  | { readonly kind: "invalid_key" }
  | { readonly kind: "unavailable"; readonly message: string };

export type RetellDirectTargetCheck =
  | { readonly kind: "ready" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "retryable"; readonly message: string };

export type RetellVoiceRouteCheck =
  | { readonly kind: "ready"; readonly number: string }
  | { readonly kind: "invalid_key" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

function credential(value: string): RetellCredential {
  return { reveal: () => value };
}

function discoveryFailure(
  result: { readonly kind: string },
): Exclude<RetellVoiceDiscovery, { readonly kind: "ready" }> {
  return result.kind === "invalid-key"
    ? { kind: "invalid_key" }
    : {
        kind: "unavailable",
        message: "Retell could not read this account. Check its network and try again.",
      };
}

export async function discoverRetellVoiceAgents(
  apiKey: string,
  fetchImpl: ProviderFetch = fetch,
): Promise<RetellVoiceDiscovery> {
  const key = credential(apiKey);
  const reach = { fetchImpl, signal: AbortSignal.timeout(15_000) };
  const [agents, numbers] = await Promise.all([
    listAgents(key, reach),
    listNumbers(key, reach),
  ]);
  if (agents.kind !== "agents") return discoveryFailure(agents);
  if (numbers.kind !== "numbers") return discoveryFailure(numbers);

  return {
    kind: "ready",
    agents: agents.agents
      .filter((agent) => agent.modality === "voice")
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        numbers: numbersAnswering(numbers.numbers, agent.id).map(
          ({ number, label }) => ({ number, label }),
        ),
      })),
  };
}

/**
 * Re-read the chosen agent and the chosen number immediately before Egma
 * writes a provider-blind phone connection.
 */
export async function verifyRetellVoiceRoute(
  apiKey: string,
  agentId: string,
  phoneNumber: string,
  fetchImpl: ProviderFetch = fetch,
): Promise<RetellVoiceRouteCheck> {
  const key = credential(apiKey);
  const reach = { fetchImpl, signal: AbortSignal.timeout(15_000) };
  const [agents, number] = await Promise.all([
    listAgents(key, reach),
    confirmNumber(key, phoneNumber, reach),
  ]);
  if (agents.kind === "invalid-key" || number.kind === "invalid-key") {
    return { kind: "invalid_key" };
  }
  if (agents.kind !== "agents" || number.kind === "refused" || number.kind === "unreachable") {
    return {
      kind: "unavailable",
      message: "Retell could not confirm this route. Check its network and try again.",
    };
  }

  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) {
    return {
      kind: "rejected",
      message: "Retell no longer lists that agent. Load the account again and choose another agent.",
    };
  }
  if (agent.modality !== "voice") {
    return {
      kind: "rejected",
      message: "That Retell agent is text-only. Choose a voice agent.",
    };
  }
  if (number.kind === "gone") {
    return {
      kind: "rejected",
      message: "Retell no longer lists that phone number. Load the account again and choose another number.",
    };
  }
  if (!number.number.answeredBy.includes(agent.id)) {
    return {
      kind: "rejected",
      message: "That phone number is no longer routed to the selected agent. Load the account again.",
    };
  }
  return { kind: "ready", number: number.number.number };
}

/**
 * Prove that a legacy direct Retell row points at a chat agent before its
 * credential is handed to the simulator.
 *
 * Old rows store the requested Egma modality, not the provider agent channel.
 * The registry pair check therefore cannot catch a voice agent id in a row
 * labelled chat. The shared provider listing is the source of truth here.
 */
export async function verifyRetellDirectChatAgent(
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
        `Retell agent ${wanted} is a voice agent, but this legacy direct connection is marked as text. ` +
        "Add one of the agent's routed phone numbers as a Phone connection before starting another run.",
    };
  }
  return { kind: "ready" };
}
