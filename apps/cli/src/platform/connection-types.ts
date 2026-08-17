/**
 * The connection forms this Egma instance knows how to accept.
 *
 * The platform owns this catalog. The CLI reads it instead of carrying a
 * second list of fields, labels, or credential rules that can drift from the
 * platform that will check the finished connection.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import type { RegisterOptions } from "./agents.ts";
import { ask, saidBy, text, textList } from "./wire.ts";

export const CONNECTION_TYPES_PATH = "/api/connection-types";

export type ConnectionFieldKind = "text" | "url" | "e164" | "json";
export type CredentialFieldKind = "secret" | "json";
export type CredentialRule = "required" | "forbidden" | "optional";

export type ConnectionField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ConnectionFieldKind;
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
  readonly chosenBy: string | null;
  readonly fields: readonly ConnectionField[];
  readonly credentialRule: CredentialRule;
  readonly credentialHelp: string;
  readonly credentialFields: readonly CredentialField[];
};

export type ConnectionTypeDescription = {
  readonly type: string;
  readonly label: string;
  readonly modalities: readonly string[];
  readonly topology: string;
  readonly simulatorAdapter: boolean;
  readonly capabilityDiscovery: boolean;
  readonly variants: readonly ConnectionVariant[];
};

export type ConnectionTypeCatalog = {
  readonly items: readonly ConnectionTypeDescription[];
};

export type ConnectionTypeCatalogResult =
  | { readonly kind: "catalog"; readonly catalog: ConnectionTypeCatalog }
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

function variantIn(value: Record<string, unknown>): ConnectionVariant | null {
  const id = text(value.id);
  const rule = text(value.credential_rule);
  if (id === "" || !CREDENTIAL_RULES.includes(rule)) return null;

  return {
    id,
    label: text(value.label),
    chosenBy: value.chosen_by === null ? null : (text(value.chosen_by) || null),
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

function typeIn(value: Record<string, unknown>): ConnectionTypeDescription | null {
  const type = text(value.type);
  if (type === "") return null;
  return {
    type,
    label: text(value.label),
    modalities: textList(value.modalities),
    topology: text(value.topology),
    simulatorAdapter: value.simulator_adapter === true,
    capabilityDiscovery: value.capability_discovery === true,
    variants: objectsIn(value.variants).flatMap((variant) => {
      const read = variantIn(variant);
      return read === null ? [] : [read];
    }),
  };
}

/** One type by name, or nothing when the catalog does not hold it. */
export function connectionTypeNamed(
  catalog: ConnectionTypeCatalog,
  type: string,
): ConnectionTypeDescription | undefined {
  return catalog.items.find((entry) => entry.type === type);
}

/** Read the server-owned catalog used to draw connection questions. */
export async function readConnectionTypes(
  options: RegisterOptions,
): Promise<ConnectionTypeCatalogResult> {
  let answered: Awaited<ReturnType<typeof ask>>;
  try {
    answered = await ask({
      signedIn: { url: options.url.replace(/\/+$/u, ""), key: options.key },
      path: CONNECTION_TYPES_PATH,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl as Fetch }),
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
        const read = typeIn(entry);
        return read === null ? [] : [read];
      }),
    },
  };
}
