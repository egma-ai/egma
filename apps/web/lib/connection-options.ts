/**
 * The simulation connection options that the server describes.
 *
 * This application keeps no list of its own. The registry decides which
 * technical tuple is supported, which fields it needs, and whether it takes a
 * credential. The browser only draws what the server sends.
 */

export type FieldKind = "text" | "url" | "e164" | "json";
export type CredentialFieldKind = "secret" | "json";
export type CredentialRule = "required" | "forbidden" | "optional";

export type ConfigField = {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly help: string;
  readonly after_credentials: boolean;
};

export type CredentialField = {
  readonly field: string;
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly required: boolean;
  readonly help: string;
};

export type ConnectionOption = {
  readonly agent_platform: string | null;
  readonly agent_platform_label: string;
  readonly connection_kind: string;
  readonly access_variant: string;
  readonly access_variant_label: string;
  readonly modality: string;
  readonly product_label: string;
  readonly topology: string;
  readonly simulator_adapter: boolean;
  readonly capability_discovery: boolean;
  readonly fields: readonly ConfigField[];
  readonly credential_rule: CredentialRule;
  readonly credential_help: string;
  readonly credential_fields: readonly CredentialField[];
};

export type ConnectionOptionCatalog = {
  readonly items: readonly ConnectionOption[];
};

export const CONNECTION_OPTIONS_PATH = "/api/connection-options";

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
    const value = option.agent_platform ?? "unknown";
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      platform: option.agent_platform,
      label: option.agent_platform_label,
    });
  }
  return choices;
}

/** Connection options for one platform, in the server's preferred order. */
export function optionsForPlatform(
  catalog: ConnectionOptionCatalog | null,
  platform: string | null,
): readonly ConnectionOption[] {
  return catalog?.items.filter((option) => option.agent_platform === platform) ?? [];
}

/** The metadata for one stored technical tuple. */
export function optionNamed(
  catalog: ConnectionOptionCatalog | null,
  connection: {
    readonly agent_platform: string | null;
    readonly connection_kind: string;
    readonly access_variant: string;
    readonly modality: string;
  },
): ConnectionOption | undefined {
  return catalog?.items.find(
    (option) =>
      option.agent_platform === connection.agent_platform &&
      option.connection_kind === connection.connection_kind &&
      option.access_variant === connection.access_variant &&
      option.modality === connection.modality,
  );
}

export type RetellRoutedNumber = {
  readonly number: string;
  readonly label: string;
};

export type RetellVoiceAgent = {
  readonly id: string;
  readonly name: string;
  readonly numbers: readonly RetellRoutedNumber[];
};

export type RetellVoiceAgents = {
  readonly agents: readonly RetellVoiceAgent[];
};

/** A read-only provider setup step. The key is never returned. */
export const RETELL_VOICE_AGENTS_PATH = "/api/providers/retell/voice-agents";

/** Confirm a selected Retell route and attach its public phone number. */
export function retellPhoneConnectionPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/connections/retell-phone`;
}

export type CapabilityEntry = {
  readonly key: string;
  readonly label: string;
  readonly description: string;
};

export type CapabilityCatalog = {
  readonly items: readonly CapabilityEntry[];
};

export const CAPABILITIES_PATH = "/api/capabilities";

/** What a person is told about a capability key, or the key itself. */
export function capabilityLabel(
  catalog: CapabilityCatalog | null,
  key: string,
): string {
  return catalog?.items.find((one) => one.key === key)?.label ?? key;
}
