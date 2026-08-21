/** The connection forms supported by the selected Egma platform. */

import {
  listConnectionOptions,
  type ListConnectionOptionsResponse,
} from "@egma/platform-api/client";

import type { RegisterOptions } from "./agents.ts";
import {
  platformClient,
  platformRefusalMessage,
  platformText,
  platformUnreachableMessage,
} from "./client.ts";

type GeneratedOption = ListConnectionOptionsResponse["items"][number];

export type ConnectionFieldKind = GeneratedOption["fields"][number]["kind"];
export type CredentialFieldKind = GeneratedOption["credentialFields"][number]["kind"];
export type CredentialRule = GeneratedOption["credentialRule"];

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
  readonly agentPlatform: GeneratedOption["agentPlatform"];
  readonly agentPlatformLabel: string;
  readonly connectionKind: GeneratedOption["connectionKind"];
  readonly accessVariant: GeneratedOption["accessVariant"];
  readonly accessVariantLabel: string;
  readonly modality: GeneratedOption["modality"];
  readonly productLabel: string;
  readonly topology: GeneratedOption["topology"];
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

function cleanOption(option: GeneratedOption): ConnectionOption {
  return {
    agentPlatform: option.agentPlatform,
    agentPlatformLabel: platformText(option.agentPlatformLabel),
    connectionKind: option.connectionKind,
    accessVariant: option.accessVariant,
    accessVariantLabel: platformText(option.accessVariantLabel),
    modality: option.modality,
    productLabel: platformText(option.productLabel),
    topology: option.topology,
    simulatorAdapter: option.simulatorAdapter,
    capabilityDiscovery: option.capabilityDiscovery,
    fields: option.fields.map((field) => ({
      key: platformText(field.key),
      label: platformText(field.label),
      kind: field.kind,
      required: field.required,
      help: platformText(field.help),
      afterCredentials: field.afterCredentials,
    })),
    credentialRule: option.credentialRule,
    credentialHelp: platformText(option.credentialHelp),
    credentialFields: option.credentialFields.map((field) => ({
      field: platformText(field.field),
      label: platformText(field.label),
      kind: field.kind,
      required: field.required,
      help: platformText(field.help),
    })),
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
  const signedIn = { url: options.url.replace(/\/+$/u, ""), key: options.key };
  const answer = await listConnectionOptions({
    client: platformClient(signedIn, options.fetchImpl),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (answer.response === undefined) {
    return { kind: "unreachable", reason: platformUnreachableMessage(options.url) };
  }
  if (answer.response.status === 401) return { kind: "not-authenticated" };
  if (!answer.response.ok) {
    return {
      kind: "refused",
      reason: platformRefusalMessage(answer.error, answer.response.status),
    };
  }
  return {
    kind: "catalog",
    catalog: { items: (answer.data?.items ?? []).map(cleanOption) },
  };
}
