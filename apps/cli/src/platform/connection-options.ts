/**
 * The simulation connection forms this Egma instance accepts.
 *
 * The platform owns this catalog. The CLI reads it instead of carrying a
 * second list of fields, labels, or credential rules that can drift from the
 * platform that will check the finished connection.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import type { RegisterOptions } from "./agents.ts";
import { ask, saidBy, text } from "./wire.ts";

export const CONNECTION_OPTIONS_PATH = "/api/connection-options";

export type ConnectionFieldKind = "text" | "url" | "e164" | "json";
export type CredentialFieldKind = "secret" | "json";
export type CredentialRule = "required" | "forbidden" | "optional";

export type ConnectionField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ConnectionFieldKind;
  readonly required: boolean;
  readonly help: string;
  readonly afterCredentials: boolean;
};

export type CredentialField = {
  readonly field: string;
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly required: boolean;
  readonly help: string;
};

export type ConnectionOption = {
  readonly agentPlatform: string | null;
  readonly agentPlatformLabel: string;
  readonly connectionKind: string;
  readonly accessVariant: string;
  readonly accessVariantLabel: string;
  readonly modality: string;
  readonly productLabel: string;
  readonly topology: string;
  readonly simulatorAdapter: boolean;
  readonly capabilityDiscovery: boolean;
  readonly fields: readonly ConnectionField[];
  readonly credentialRule: CredentialRule;
  readonly credentialHelp: string;
  readonly credentialFields: readonly CredentialField[];
};

export type ConnectionOptionCatalog = {
  readonly items: readonly ConnectionOption[];
};

export type ConnectionOptionCatalogResult =
  | { readonly kind: "catalog"; readonly catalog: ConnectionOptionCatalog }
  | { readonly kind: "not-authenticated" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

const FIELD_KINDS: readonly string[] = ["text", "url", "e164", "json"];
const CREDENTIAL_FIELD_KINDS: readonly string[] = ["secret", "json"];
const CREDENTIAL_RULES: readonly string[] = ["required", "forbidden", "optional"];

function objectsIn(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function fieldIn(value: Record<string, unknown>): ConnectionField | null {
  const key = text(value.key);
  const kind = text(value.kind);
  if (key === "" || !FIELD_KINDS.includes(kind)) return null;
  return {
    key,
    label: text(value.label),
    kind: kind as ConnectionFieldKind,
    required: value.required === true,
    help: text(value.help),
    afterCredentials: value.after_credentials === true,
  };
}

function credentialFieldIn(value: Record<string, unknown>): CredentialField | null {
  const field = text(value.field);
  const kind = text(value.kind);
  if (field === "" || !CREDENTIAL_FIELD_KINDS.includes(kind)) return null;
  return {
    field,
    label: text(value.label),
    kind: kind as CredentialFieldKind,
    required: value.required === true,
    help: text(value.help),
  };
}

function optionIn(value: Record<string, unknown>): ConnectionOption | null {
  const connectionKind = text(value.connection_kind);
  const accessVariant = text(value.access_variant);
  const modality = text(value.modality);
  const productLabel = text(value.product_label);
  const rule = text(value.credential_rule);
  const rawPlatform = value.agent_platform;
  if (
    (rawPlatform !== null && typeof rawPlatform !== "string") ||
    connectionKind === "" ||
    accessVariant === "" ||
    modality === "" ||
    productLabel === "" ||
    !CREDENTIAL_RULES.includes(rule)
  ) {
    return null;
  }

  return {
    agentPlatform: rawPlatform === null ? null : text(rawPlatform),
    agentPlatformLabel: text(value.agent_platform_label),
    connectionKind,
    accessVariant,
    accessVariantLabel: text(value.access_variant_label),
    modality,
    productLabel,
    topology: text(value.topology),
    simulatorAdapter: value.simulator_adapter === true,
    capabilityDiscovery: value.capability_discovery === true,
    fields: objectsIn(value.fields).flatMap((field) => {
      const read = fieldIn(field);
      return read === null ? [] : [read];
    }),
    credentialRule: rule as CredentialRule,
    credentialHelp: text(value.credential_help),
    credentialFields: objectsIn(value.credential_fields).flatMap((field) => {
      const read = credentialFieldIn(field);
      return read === null ? [] : [read];
    }),
  };
}

/** The options for one agent platform, in the server's preferred order. */
export function connectionOptionsForPlatform(
  catalog: ConnectionOptionCatalog,
  agentPlatform: string | null,
): readonly ConnectionOption[] {
  return catalog.items.filter((option) => option.agentPlatform === agentPlatform);
}

/** Read the server-owned catalog used to draw connection questions. */
export async function readConnectionOptions(
  options: RegisterOptions,
): Promise<ConnectionOptionCatalogResult> {
  let answered: Awaited<ReturnType<typeof ask>>;
  try {
    answered = await ask({
      signedIn: { url: options.url.replace(/\/+$/u, ""), key: options.key },
      path: CONNECTION_OPTIONS_PATH,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl as Fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof PlatformUnreachableError) {
      return { kind: "unreachable", reason: error.message };
    }
    throw error;
  }

  if (answered.response.status === 401) return { kind: "not-authenticated" };
  if (!answered.response.ok) {
    return {
      kind: "refused",
      reason: saidBy(answered.body, answered.response.status),
    };
  }

  return {
    kind: "catalog",
    catalog: {
      items: objectsIn(answered.body.items).flatMap((entry) => {
        const read = optionIn(entry);
        return read === null ? [] : [read];
      }),
    },
  };
}
