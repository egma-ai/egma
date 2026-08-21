import type {
  DiscoverAgentsResponse,
  ListConnectionOptionsResponse,
} from "@egma/platform-api/client";

/**
 * The simulation connection options that the server describes.
 *
 * This application keeps no list of its own. The registry decides which
 * technical tuple is supported, which fields it needs, and whether it takes a
 * credential. The browser only draws what the server sends.
 */

export type ConnectionOptionCatalog = ListConnectionOptionsResponse;
export type ConnectionOption = ConnectionOptionCatalog["items"][number];
export type ConfigField = ConnectionOption["fields"][number];
export type CredentialField = ConnectionOption["credentialFields"][number];
export type FieldKind = ConfigField["kind"];
export type CredentialFieldKind = CredentialField["kind"];
export type CredentialRule = ConnectionOption["credentialRule"];

export type AgentPlatformChoice = {
  readonly value: string;
  readonly platform: string | null;
  readonly label: string;
};

/** Agent platforms in server order, with null represented by a form value. */
export function agentPlatformChoices(
  catalog: ConnectionOptionCatalog | null,
): readonly AgentPlatformChoice[] {
  const seen = new Set<string>();
  const choices: AgentPlatformChoice[] = [];
  for (const option of catalog?.items ?? []) {
    const value = option.agentPlatform ?? "unknown";
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      platform: option.agentPlatform,
      label: option.agentPlatformLabel,
    });
  }
  return choices;
}

/** Connection options for one platform, in the server's preferred order. */
export function optionsForPlatform(
  catalog: ConnectionOptionCatalog | null,
  platform: string | null,
): readonly ConnectionOption[] {
  return catalog?.items.filter((option) => option.agentPlatform === platform) ?? [];
}

/** The metadata for one stored technical tuple. */
export function optionNamed(
  catalog: ConnectionOptionCatalog | null,
  connection: {
    readonly agentPlatform: string | null;
    readonly connectionKind: string;
    readonly accessVariant: string;
    readonly modality: string;
  },
): ConnectionOption | undefined {
  return catalog?.items.find(
    (option) =>
      option.agentPlatform === connection.agentPlatform &&
      option.connectionKind === connection.connectionKind &&
      option.accessVariant === connection.accessVariant &&
      option.modality === connection.modality,
  );
}

export type DiscoveredAgents = DiscoverAgentsResponse;
export type DiscoveredAgent = DiscoveredAgents["agents"][number];
export type ConnectionCandidate = DiscoveredAgent["connectionCandidates"][number];

/** Candidates that represent the explicit connection option on the form. */
export function candidatesForOption(
  agent: DiscoveredAgent,
  option: ConnectionOption | undefined,
): readonly ConnectionCandidate[] {
  if (option === undefined) return [];
  return agent.connectionCandidates.filter(
    (candidate) =>
      candidate.agentPlatform === option.agentPlatform &&
      candidate.connectionKind === option.connectionKind &&
      candidate.accessVariant === option.accessVariant &&
      candidate.modality === option.modality,
  );
}

/** Agents that offer at least one candidate for the selected access variant. */
export function agentsForOption(
  agents: readonly DiscoveredAgent[] | null,
  option: ConnectionOption | undefined,
): readonly DiscoveredAgent[] {
  return (
    agents?.filter((agent) => candidatesForOption(agent, option).length > 0) ?? []
  );
}
