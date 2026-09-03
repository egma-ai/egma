/** Provider Agent discovery through Egma's server-owned API contract. */

import {
  discoverAgents as discoverAgentsRequest,
  type DiscoverAgentsResponse,
} from "@egma/platform-api/client";

import {
  commonFailure,
  requestOptions,
  type CommonFailure,
  type RegisterOptions,
} from "./agents.ts";
import type { ConnectionCredentials } from "./connection-credentials.ts";
import { platformText } from "./client.ts";

type GeneratedAgent = DiscoverAgentsResponse["agents"][number];
type GeneratedCandidate = GeneratedAgent["connectionCandidates"][number];

export type DiscoveredConnection = {
  readonly agentPlatform: "retell";
  readonly connectionType: GeneratedCandidate["connectionType"];
  readonly accessVariant: GeneratedCandidate["accessVariant"];
  readonly modality: GeneratedCandidate["modality"];
  readonly productLabel: string;
  readonly config: Readonly<Record<string, string>>;
};

export type DiscoveredAgent = {
  readonly id: string;
  readonly name: string;
  readonly modality: GeneratedAgent["modality"];
  readonly connections: readonly DiscoveredConnection[];
};

export type DiscoveredAgents =
  | { readonly kind: "agents"; readonly agents: readonly DiscoveredAgent[] }
  | CommonFailure;

function cleanedAgent(raw: GeneratedAgent): DiscoveredAgent | null {
  const id = platformText(raw.platformAgentId);
  const name = platformText(raw.name);
  if (id === "" || name === "") return null;
  const connections: DiscoveredConnection[] = [];
  for (const candidate of raw.connectionCandidates) {
    const productLabel = platformText(candidate.productLabel);
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidate.config)) {
      if (typeof value !== "string") return null;
      config[key] = value;
    }
    connections.push({
      agentPlatform: "retell",
      connectionType: candidate.connectionType,
      accessVariant: candidate.accessVariant,
      modality: candidate.modality,
      productLabel,
      config,
    });
  }
  return { id, name, modality: raw.modality, connections };
}

/**
 * A first registration supplies credentials. A later Connection names the
 * Egma Agent whose sealed credential the server may reuse. Never send both.
 */
export async function discoverRetellAgents(
  input: {
    readonly projectId: string;
    readonly agentId?: string;
    readonly credentials?: ConnectionCredentials;
  },
  options: RegisterOptions,
): Promise<DiscoveredAgents> {
  const revealed = input.credentials?.reveal();
  const answer = await discoverAgentsRequest(
    {
      projectId: input.projectId,
      agentPlatform: "retell",
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(revealed === undefined
        ? {}
        : { credentials: { apiKey: revealed["apiKey"] ?? "" } }),
    },
    requestOptions(options),
  );

  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;
  if (answer.data === undefined || !Array.isArray(answer.data.agents)) {
    return {
      kind: "refused",
      reason:
        "Egma answered without a Retell Agent list. Check that this Egma platform is up to date.",
    };
  }
  const agents: DiscoveredAgent[] = [];
  for (const raw of answer.data.agents) {
    const agent = cleanedAgent(raw);
    if (agent === null) {
      return {
        kind: "refused",
        reason:
          "Egma answered with an incomplete Retell Agent. Check that this Egma platform is up to date.",
      };
    }
    agents.push(agent);
  }
  return { kind: "agents", agents };
}
