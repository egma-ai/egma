/**
 * What egma can connect to, as the server describes it.
 *
 * **This application keeps no list of its own, and that is the whole point of
 * this module.** The server's registry decides which config keys a shape holds,
 * which modalities a type speaks, and whether a credential is required,
 * forbidden or optional. A second handwritten copy here would be a second
 * opinion able to disagree with the gate — and the disagreement would show up
 * as a form that asks for the wrong things and a create that then refuses for a
 * reason the form cannot explain.
 *
 * So the connection form is drawn from this read. A type added on the server
 * appears in the form with nothing edited here.
 */

export type FieldKind = "text" | "url" | "e164" | "json";
export type CredentialFieldKind = "secret" | "json";

/** The three answers to "does this shape take a customer credential". */
export type CredentialRule = "required" | "forbidden" | "optional";

export type ConfigField = {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly help: string;
};

export type CredentialField = {
  readonly field: string;
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly required: boolean;
  readonly help: string;
};

export type ConnectionVariant = {
  readonly id: string;
  readonly label: string;
  /** The config key whose presence chooses this shape, or null for the first. */
  readonly chosen_by: string | null;
  readonly fields: readonly ConfigField[];
  readonly credential_rule: CredentialRule;
  readonly credential_help: string;
  readonly credential_fields: readonly CredentialField[];
};

export type ConnectionTypeDescription = {
  readonly type: string;
  readonly label: string;
  readonly modalities: readonly string[];
  readonly topology: string;
  /** Whether egma can conduct a simulation over this type at all. */
  readonly simulator_adapter: boolean;
  /** Whether egma ships anything that can measure this type's targets. */
  readonly capability_discovery: boolean;
  readonly variants: readonly ConnectionVariant[];
};

export type ConnectionTypeCatalog = {
  readonly items: readonly ConnectionTypeDescription[];
};

export const CONNECTION_TYPES_PATH = "/api/connection-types";

export type CapabilityEntry = {
  readonly key: string;
  readonly label: string;
  readonly description: string;
};

export type CapabilityCatalog = {
  readonly items: readonly CapabilityEntry[];
};

export const CAPABILITIES_PATH = "/api/capabilities";

/** One type by name, or nothing when the catalog does not hold it. */
export function typeNamed(
  catalog: ConnectionTypeCatalog | null,
  type: string,
): ConnectionTypeDescription | undefined {
  return catalog?.items.find((one) => one.type === type);
}

/** One shape by its stable id, wherever in the catalog it lives. */
export function variantNamed(
  catalog: ConnectionTypeCatalog | null,
  type: string,
  variantId: string,
): ConnectionVariant | undefined {
  return typeNamed(catalog, type)?.variants.find(
    (one) => one.id === variantId,
  );
}

/**
 * What a person is told about a capability key, or the key itself.
 *
 * The key is the fallback rather than a blank, because a connection measured
 * under a later release can hold a key this browser's catalog has not heard of
 * — and showing nothing there would quietly drop a measured fact.
 */
export function capabilityLabel(
  catalog: CapabilityCatalog | null,
  key: string,
): string {
  return catalog?.items.find((one) => one.key === key)?.label ?? key;
}
