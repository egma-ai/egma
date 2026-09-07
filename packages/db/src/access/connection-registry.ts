import { isIP } from "node:net";

import {
  CONNECTION_TYPES,
  MODALITIES,
  type AccessVariant,
  type AgentPlatform,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { AgentWriteRefusedError } from "./errors.ts";

/**
 * Connection types define supported modalities, topology, access variants, and
 * validation rules. Keep simulatorAdapter in step with the shipped simulator.
 * Record<ConnectionType, …> requires an entry for every schema connection type.
 */

/**
 * One config key's gate. Takes what the caller sent under `key` — absent
 * arrives as `undefined` — and answers the value as it will be stored, or
 * throws naming the key.
 */
type ConfigGate = (key: string, value: unknown) => string;

/** Allow an absent config key; validate a supplied value with the same gate. */
type OptionalGate = { readonly optional: true; readonly gate: ConfigGate };

/** What a descriptor holds against one config key. */
type ConfigDemand = ConfigGate | OptionalGate;

/**
 * What a config field *is*, for whoever has to fill it in — never how it is
 * checked.
 *
 * `kind` is a hint about the control a form draws and about nothing else. The
 * gate beside it is still the only thing that decides whether a value is
 * admitted, so a browser that drew a plain box for a `url` cannot get a bad URL
 * past anything.
 */
export const CONFIG_FIELD_KINDS = ["text", "url", "e164", "json"] as const;
export type ConfigFieldKind = (typeof CONFIG_FIELD_KINDS)[number];

export type ConfigFieldMetadata = {
  readonly key: string;
  readonly label: string;
  readonly kind: ConfigFieldKind;
  /** One sentence a person can act on. Never names a validator or a rule id. */
  readonly help: string;
  /** Place this supporting field after credentials when the form requests that order. */
  readonly afterCredentials?: true;
};

/**
 * The two shapes a credential field comes in.
 *
 * `secret` is a value with no public half at all; `json` is an object of names
 * to values, where the names are ordinary and the values are the secret. The
 * distinction reaches a form — one draws a password box, the other a text area
 * — and it reaches the hint a read shows, which is why it is described rather
 * than guessed from the field's name.
 */
export const CREDENTIAL_FIELD_KINDS = ["secret", "json"] as const;
export type CredentialFieldKind = (typeof CREDENTIAL_FIELD_KINDS)[number];

export type CredentialFieldMetadata = {
  readonly field: string;
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly help: string;
};

/** Public names for credential rules, shared by forms and restore validation. */
export const CREDENTIAL_RULES = ["required", "forbidden", "optional"] as const;
export type CredentialRuleName = (typeof CREDENTIAL_RULES)[number];

/** Marks a gate optional: absence is admitted, a value still faces the gate. */
export function optional(gate: ConfigGate): OptionalGate {
  return { optional: true, gate };
}

function gateOf(demand: ConfigDemand): ConfigGate {
  return typeof demand === "function" ? demand : demand.gate;
}

function isDemanded(demand: ConfigDemand): boolean {
  return typeof demand === "function";
}

/**
 * One credential field's gate. Takes the field's value and answers it as it
 * will be sealed, or throws a sentence built from `what` — the access variant
 * being described — and the field's own name. It never quotes the value: a refusal
 * about a secret must not carry one.
 */
export type CredentialGate = (
  what: string,
  field: string,
  value: unknown,
) => string;

/**
 * How a sealed credential is described in a read.
 *
 * A hint exists so a person can tell two connections apart without egma
 * handing back what it sealed, so what it may show is decided per rule rather
 * than fixed: some credentials have a public half whose tail is safe to print,
 * and some are secret all the way through.
 */
export type CredentialHint = (sealed: Record<string, string>) => string;

/**
 * Require, reject, or optionally accept credentials for an access variant.
 * When supplied, credentials must contain the complete set of required fields.
 */
export type CredentialRule =
  | {
      readonly required: true | "if-sent";
      /** Exactly these keys, each checked by `gate`. */
      readonly fields: readonly string[];
      /** How each field is checked. Left out: an ordinary credential string. */
      readonly gate?: CredentialGate;
      /** What a read shows of them, which is never enough to be one. */
      readonly hint: CredentialHint;
    }
  | {
      readonly required: false;
      /** Why not, told to the caller who supplied one anyway. */
      readonly refusal: string;
    };

/**
 * Config and credential rules for one access variant. Validate them together
 * to prevent mixing a token endpoint config with a project key pair.
 */
export type AccessVariantDescriptor = {
  /**
   * How a refusal names this access variant, as the subject of a sentence.
   */
  readonly named?: string;
  /**
   * The stable name of this access variant, stored on every connection written in it
   * and never rewritten. It is contract twice over: a row carries it, and a
   * browser form is drawn from the entry it points at. Renaming one is a
   * migration, exactly as renaming a column would be.
   */
  readonly id: string;
  /** What a person choosing between access variants reads. Safe to send to a browser. */
  readonly label: string;
  readonly config: Readonly<Record<string, ConfigDemand>>;
  /**
   * Config field labels in form order. The catalog checks that these keys match
   * config. Keep presentation metadata separate from validators sent only to the server.
   */
  readonly fields: readonly ConfigFieldMetadata[];
  readonly credentials: CredentialRule;
  /**
   * What a person is told about this access variant's credential, in words safe to put
   * on a screen. Never the refusal sentences: those name egma's internals and
   * are written for a terminal.
   */
  readonly credentialHelp: string;
  /** The credential's fields, in the order a form asks for them. */
  readonly credentialFields: readonly CredentialFieldMetadata[];
  /**
   * What a caller is told when the credentials they sent are the kind's *other*
   * access variant's — the pair where endpoint headers belong, or the other way
   * round. Written out rather than derived, because the useful sentence names
   * both doors and how to get through either, and that is about what the two
   * access variants are rather than about the machinery that tells them apart.
   */
  readonly mixedUp?: string;
  /**
   * Optionally restrict the connection type's modalities and explain the restriction.
   * Omit to use all modalities supported by the connection type.
   */
  readonly modalities?: {
    readonly speaks: readonly Modality[];
    readonly refusal: string;
  };
};

export type ConnectionDescriptor = {
  /** What a person choosing a connection type reads. Safe to send to a browser. */
  readonly label: string;
  /** Which agent platforms this direct path can reach, or every platform. */
  readonly agentPlatforms: readonly AgentPlatform[] | "any";
  readonly modalities: readonly Modality[];
  readonly topology: Topology;
  /**
   * The access variants supported inside this connection type. The request
   * names one explicitly; config never selects one.
   */
  readonly accessVariants: readonly [
    AccessVariantDescriptor,
    ...AccessVariantDescriptor[],
  ];
  /**
   * Whether the shipped simulator can run this connection type.
   * Run creation rejects types without an adapter; deployment setup is checked separately.
   */
  readonly simulatorAdapter: boolean;
  /** Whether conducting this kind spends the deployment's shared carrier. */
  readonly usesPlatformCarrier: boolean;
  /**
   * Optional agent identity rule for registration retries. Without it, always create
   * an agent; a shared phone number, for example, does not identify one agent.
   */
  readonly reuse?: ReuseRule;
};

/**
 * matchedKeys narrows database candidates; identityOf compares normalized identities.
 * A raw config comparison cannot match equivalent LiveKit server URL forms.
 */
export type ReuseRule = {
  /**
   * Config keys a query can narrow candidates by. Every one of them must be
   * equal for two configs to stand a chance of being one identity — they are a
   * filter and never the answer.
   */
  readonly matchedKeys: readonly string[];
  /**
   * What one config stands for, as a single comparable string, or `undefined`
   * when the config holds no identity at all. Undefined is what makes an access
   * variant that carries none of the keys create every time rather than reuse
   * its way onto somebody else's agent.
   */
  readonly identityOf: (
    config: Readonly<Record<string, string>>,
  ) => string | undefined;
  /**
   * Shared identity namespace for connection types that reach the same agent platform
   * identity. Family members must use comparable matchedKeys and identityOf rules.
   * Omit to match only this connection type.
   */
  readonly family?: string;
};

/**
 * The credential rule of one access variant, in the product's three words.
 *
 * `"if-sent"` is `optional` and that is not a softening: it is the access variant that
 * genuinely works either way, and Restore holds it to an explicit choice rather
 * than to a guess, because "left out" cannot be told from "meant to clear it".
 */
export function credentialRuleOf(
  variant: AccessVariantDescriptor,
): CredentialRuleName {
  const { required } = variant.credentials;
  if (required === false) return "forbidden";
  return required === true ? "required" : "optional";
}

/**
 * Look up the stored access variant ID without inferring it from config.
 * Throw for unknown IDs, which indicate a stored-data or deployment mismatch.
 */
export function accessVariantById(
  connectionType: ConnectionType,
  accessVariant: string,
): AccessVariantDescriptor {
  const found = descriptorOf(connectionType).accessVariants.find(
    (variant) => variant.id === accessVariant,
  );
  if (found === undefined) {
    throw new Error(
      `access variant "${accessVariant}" is not one this Egma instance knows for a ` +
        `${connectionType} connection; the access variants it holds are ` +
        descriptorOf(connectionType)
          .accessVariants.map((variant) => variant.id)
          .join(", "),
    );
  }
  return found;
}

/**
 * Browser-safe connection options from the registry: labels, field metadata,
 * credential rules, and simulator capabilities. Exclude validators and secrets.
 * The catalog checks field lists and offered modalities against each access variant.
 */
export type ConnectionOptionMetadata = {
  readonly agentPlatform: AgentPlatform | null;
  readonly agentPlatformLabel: string;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly accessVariantLabel: string;
  readonly modality: Modality;
  readonly productLabel: string;
  readonly topology: Topology;
  /** Whether egma can conduct a simulation over this connection today. */
  readonly simulatorAdapter: boolean;
  /** Whether a claimed work order for this kind needs the platform carrier. */
  readonly usesPlatformCarrier: boolean;
  /** Configuration field metadata for this access variant. */
  readonly fields: AccessVariantMetadata["fields"];
  readonly credentialRule: CredentialRuleName;
  readonly credentialHelp: string;
  readonly credentialFields: AccessVariantMetadata["credentialFields"];
};

export type AccessVariantMetadata = {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly (ConfigFieldMetadata & {
    readonly required: boolean;
  })[];
  readonly credentialRule: CredentialRuleName;
  readonly credentialHelp: string;
  readonly credentialFields: readonly (CredentialFieldMetadata & {
    readonly required: boolean;
  })[];
};

function accessVariantMetadata(
  variant: AccessVariantDescriptor,
): AccessVariantMetadata {
  const gated = Object.keys(variant.config);
  const described = variant.fields.map((field) => field.key);

  const missing = gated.filter((key) => !described.includes(key));
  const invented = described.filter((key) => !gated.includes(key));
  if (missing.length > 0 || invented.length > 0) {
    throw new Error(
      `connection access variant ${variant.id} describes ${described.length} config ` +
        `fields and gates ${gated.length}: ` +
        (missing.length > 0
          ? `${missing.join(", ")} is gated and undescribed`
          : "") +
        (missing.length > 0 && invented.length > 0 ? "; " : "") +
        (invented.length > 0
          ? `${invented.join(", ")} is described and ungated`
          : ""),
    );
  }

  const rule = credentialRuleOf(variant);
  const credentialFields =
    variant.credentials.required === false ? [] : variant.credentials.fields;
  const describedCredentials = variant.credentialFields.map(
    (field) => field.field,
  );
  if (
    credentialFields.length !== describedCredentials.length ||
    credentialFields.some((field) => !describedCredentials.includes(field))
  ) {
    throw new Error(
      `connection access variant ${variant.id} gates credential fields ` +
        `${credentialFields.join(", ") || "(none)"} and describes ` +
        `${describedCredentials.join(", ") || "(none)"}`,
    );
  }

  return {
    id: variant.id,
    label: variant.label,
    fields: variant.fields.map((field) => ({
      ...field,
      required: isDemanded(variant.config[field.key] as ConfigDemand),
    })),
    credentialRule: rule,
    credentialHelp: variant.credentialHelp,
    credentialFields: variant.credentialFields.map((field) => ({
      ...field,
      // A field of an optional credential is demanded once the credential is
      // being supplied at all — the choice is whether to send one, never which
      // half of one.
      required: rule !== "forbidden",
    })),
  };
}

const PLATFORM_LABELS: Readonly<Record<AgentPlatform, string>> = {
  retell: "Retell",
  livekit: "LiveKit",
};

type ConnectionOption = {
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  readonly productLabel: string;
  /**
   * Hide this option from connection setup while preserving labels for stored rows.
   * Retell chat-native connections remain readable and runnable.
   */
  readonly dormant?: true;
};

const CONNECTION_OPTIONS: readonly ConnectionOption[] = [
  {
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
    dormant: true,
  },
  {
    agentPlatform: "retell",
    connectionType: "retell_text_mode",
    accessVariant: "retell_text_mode.api_key",
    modality: "chat",
    productLabel: "Retell text mode",
  },
  {
    agentPlatform: "retell",
    connectionType: "retell_web_call",
    accessVariant: "retell_web_call.api_key",
    modality: "voice",
    productLabel: "Retell web call",
  },
  {
    agentPlatform: "retell",
    connectionType: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Retell phone",
  },
  {
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    modality: "voice",
    productLabel: "LiveKit project credentials",
  },
  {
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    modality: "chat",
    productLabel: "LiveKit chat",
  },
  {
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.customer_token_endpoint",
    modality: "voice",
    productLabel: "LiveKit token endpoint",
  },
  {
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.customer_token_endpoint",
    modality: "chat",
    productLabel: "LiveKit chat token endpoint",
  },
  {
    agentPlatform: "livekit",
    connectionType: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
    dormant: true,
  },
  {
    agentPlatform: null,
    connectionType: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
    dormant: true,
  },
] as const;

export function connectionOptionMetadata(): readonly ConnectionOptionMetadata[] {
  return CONNECTION_OPTIONS.filter((option) => option.dormant !== true).map((option) => {
    const descriptor = descriptorOf(option.connectionType);
    const described = accessVariantById(
      option.connectionType,
      option.accessVariant,
    );
    const speaks = modalitiesOf(descriptor, described);
    if (!speaks.includes(option.modality)) {
      throw new Error(
        `connection option ${option.productLabel} offers ${option.modality} ` +
          `on ${option.accessVariant}, which speaks ${speaks.join(" or ")}`,
      );
    }
    const variant = accessVariantMetadata(described);
    const { dormant, ...offered } = option;
    void dormant;
    return {
      ...offered,
      agentPlatformLabel:
        option.agentPlatform === null
          ? "Any or unknown"
          : PLATFORM_LABELS[option.agentPlatform],
      topology: descriptor.topology,
      accessVariantLabel: variant.label,
      simulatorAdapter: descriptor.simulatorAdapter,
      usesPlatformCarrier: descriptor.usesPlatformCarrier,
      fields: variant.fields,
      credentialRule: variant.credentialRule,
      credentialHelp: variant.credentialHelp,
      credentialFields: variant.credentialFields,
    };
  });
}

export function productLabelOf(
  agentPlatform: AgentPlatform | null,
  connectionType: ConnectionType,
  accessVariant: AccessVariant,
  modality: Modality,
): string {
  const exact = CONNECTION_OPTIONS.find(
    (option) =>
      option.agentPlatform === agentPlatform &&
      option.connectionType === connectionType &&
      option.accessVariant === accessVariant &&
      option.modality === modality,
  );
  if (exact !== undefined) return exact.productLabel;

  throw new AgentWriteRefusedError(
    "not_admitted",
    "agent platform, connection type, access variant, and modality do not form a supported simulation connection",
  );
}

function nonEmptyString(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be a non-empty string`,
    );
  }
  return value.trim();
}

/**
 * E.164: a plus, then up to fifteen digits with no leading zero. The strictest
 * format every telephony provider agrees on, checked here so a run never dials
 * a number that could not exist.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

/** The floor under a credential field, so the last-4 hint stays a hint. */
const SHORTEST_CREDENTIAL = 8;

/**
 * The ordinary credential field: one non-empty string, stored trimmed.
 *
 * Trimmed like every config gate, because a key pasted with whitespace would
 * pass the checks, seal the padding, and fail at the provider with nothing to
 * say the stored value was the problem.
 */
function credentialString(what: string, field: string, value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `${what}'s credentials need ${field} to be a non-empty string`,
    );
  }
  // Real provider keys are tens of characters, so anything this short is a
  // paste gone wrong — and the stored last-4 hint must stay a hint, never
  // most of the secret it hints at.
  if (trimmed.length < SHORTEST_CREDENTIAL) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `${what}'s credentials need ${field} to be at least ` +
        `${SHORTEST_CREDENTIAL} characters`,
    );
  }
  return trimmed;
}

/**
 * The last four characters of one field.
 *
 * Only ever pointed at a credential's *public* half — the half a customer can
 * read back off their own dashboard to tell two projects apart. A tail is a
 * safe hint exactly when the whole value was never a secret.
 */
export function lastFourOf(field: string): CredentialHint {
  return (sealed) => sealed[field]?.slice(-4) ?? "";
}

/**
 * Show JSON credential field names only. Even a suffix of a header value could
 * expose part of a secret.
 */
export function namesIn(field: string): CredentialHint {
  return (sealed) => {
    try {
      const held: unknown = JSON.parse(sealed[field] ?? "");
      if (typeof held !== "object" || held === null || Array.isArray(held)) {
        return "";
      }
      return Object.keys(held).join(", ");
    } catch {
      return "";
    }
  };
}

function e164PhoneNumber(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!E164.test(candidate)) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be an E.164 phone number, which looks like ` +
        `+15551234567`,
    );
  }
  return candidate;
}

/**
 * The four schemes a LiveKit server URL is written in. All four are accepted
 * because all four are correct: the SDKs normalise between the websocket pair
 * and the HTTP pair themselves, so refusing the one a customer copied out of
 * their dashboard would be egma inventing a rule LiveKit does not have.
 */
const LIVEKIT_URL_SCHEMES = ["ws:", "wss:", "http:", "https:"];

/**
 * Stored as it was written rather than as `URL` would rewrite it: what goes to
 * the SDK should be what the customer pasted, so a support conversation is
 * about the string they can see in their own dashboard.
 */
function livekitServerUrl(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  let scheme: string | undefined;
  try {
    scheme = new URL(candidate).protocol;
  } catch {
    scheme = undefined;
  }

  if (
    scheme === undefined ||
    !LIVEKIT_URL_SCHEMES.includes(scheme) ||
    // `wss:acme.livekit.cloud` parses — a special scheme takes the rest as a
    // host — and then reaches nothing, because it is not the form the SDKs
    // are handed. The stored string is what they get, so the slashes are
    // demanded here rather than missed at dial time.
    !candidate.toLowerCase().startsWith(`${scheme}//`)
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be a ws, wss, http or https URL, which looks ` +
        `like wss://example.livekit.cloud`,
    );
  }
  return candidate;
}

/**
 * Compare LiveKit servers by lowercase host and non-default port, ignoring scheme
 * and a trailing root dot. URL removes scheme-default ports. Keep the stored URL
 * unchanged for the SDK; return trimmed lowercase input if parsing fails.
 */
export function livekitServerOrigin(url: string): string {
  const written = url.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(written);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return written.toLowerCase();

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return parsed.port === "" ? host : `${host}:${parsed.port}`;
}

/**
 * Compare token endpoints by host, port, path, and query. Paths and queries may
 * select different projects on one service. Drop the scheme and trailing host dot;
 * return trimmed input if parsing fails. This key does not replace the stored URL.
 */
export function tokenEndpointIdentity(endpoint: string): string {
  const written = endpoint.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(written);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return written;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const origin = parsed.port === "" ? host : `${host}:${parsed.port}`;
  return `${origin}${parsed.pathname}${parsed.search}`;
}

/*
 * LiveKit dispatch metadata belongs to each test: env.job_dispatch_metadata.
 * Its size limit is LARGEST_JOB_DISPATCH_METADATA_BYTES in test validation.
 */

/**
 * Validate the per-simulation token endpoint before storage. The simulator must
 * also check resolved addresses at request time because DNS can change.
 */
function tokenEndpointUrl(key: string, value: unknown): string {
  return publicHttpsUrl(key, value, "https://example.com/egma/livekit-token");
}

/**
 * Accept HTTPS hostnames without credentials, IP literals, localhost names,
 * backslashes, or control characters. This check does not resolve DNS; outbound
 * request code must reject private addresses after resolution.
 */
function publicHttpsUrl(key: string, value: unknown, example: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  let parsed: URL | undefined;
  try {
    parsed = new URL(candidate);
  } catch {
    parsed = undefined;
  }

  const rawHostname = parsed?.hostname ?? "";
  const hostname = rawHostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const hasAmbiguousSyntax =
    candidate.includes("\\") || /[\u0000-\u001F\u007F]/u.test(candidate);

  if (
    parsed === undefined ||
    hasAmbiguousSyntax ||
    parsed.protocol !== "https:" ||
    !candidate.toLowerCase().startsWith("https://") ||
    hostname === "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(hostname) !== 0 ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be a public https URL, which looks like ` +
        example,
    );
  }
  return candidate;
}

/**
 * Validate a nonempty JSON object of header names to nonempty string values.
 * Keep its text for storage and never include secret values in validation errors.
 */
function authHeadersJson(what: string, field: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = undefined;
  }

  const named =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : undefined;

  if (
    named === undefined ||
    named.length === 0 ||
    named.some(
      ([name, held]) =>
        name.trim() === "" || typeof held !== "string" || held.trim() === "",
    )
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `${what}'s credentials need ${field} to be a JSON object of header ` +
        `name to header value, written in a string, which looks like ` +
        `{"Authorization":"Bearer …"}`,
    );
  }
  return candidate;
}

export const CONNECTION_REGISTRY: Readonly<
  Record<ConnectionType, ConnectionDescriptor>
> = {
  retell_chat_api: {
    label: "Retell chat API",
    agentPlatforms: ["retell"],
    // The Retell chat adapter uses the chat-session API. Voice agents are
    // reached through a phone connection after provider setup resolves one of
    // their routed numbers. Admitting `voice` here would create a connection
    // the simulator cannot conduct and fail it only after dispatch.
    modalities: ["chat"],
    topology: "hosted-broker",
    accessVariants: [
      {
        id: "retell_chat_api.api_key",
        label: "Retell API key",
        named: "a Retell chat connection",
        config: { retellAgentId: nonEmptyString },
        fields: [
          {
            key: "retellAgentId",
            label: "Retell agent ID",
            kind: "text",
            help: "The agent's own identifier in Retell, which starts with agent_.",
          },
        ],
        credentials: {
          required: true,
          fields: ["apiKey"],
          hint: lastFourOf("apiKey"),
        },
        credentialHelp:
          "Egma stores your Retell API key sealed and never shows it again. " +
          "A read gives back its last four characters, so you can tell two " +
          "keys apart.",
        credentialFields: [
          {
            field: "apiKey",
            label: "Retell API key",
            kind: "secret",
            help: "Copied from your Retell dashboard.",
          },
        ],
      },
    ],
    // The provider's own agent id: the first vendor to carry a reuse rule, and
    // the simple case the mechanism was built for — one config key, compared as
    // it was stored, is the whole identity. The family says text mode and
    // the web call name the same agents, so any of the three doors lands on
    // the one Egma agent the first door created.
    reuse: {
      family: "retellAgentId",
      matchedKeys: ["retellAgentId"],
      identityOf: (config) => config["retellAgentId"],
    },
    simulatorAdapter: true,
    usesPlatformCarrier: false,
  },
  retell_text_mode: {
    label: "Retell text mode",
    agentPlatforms: ["retell"],
    /**
     * Text-mode access to a Retell voice agent through agent-playground-completion.
     * Use a separate phone or web-call connection for voice simulations of that agent.
     */
    modalities: ["chat"],
    // Retell brokers the exchange exactly as it brokers a chat session: Egma
    // makes an outbound request and Retell runs the agent behind it.
    topology: "hosted-broker",
    accessVariants: [
      {
        id: "retell_text_mode.api_key",
        label: "Retell API key",
        named: "a Retell text mode connection",
        // `retellAgentId` and nothing else. Where Retell answers is **not** a
        // stored config key: it is the plug's own test seam, the way it is on
        // `retell_chat_api`, and `validConfig` refuses `baseUrl` here for the
        // same reason it refuses it there. A customer-writable address would
        // decide where this connection's sealed key is sent, which is a read
        // of a write-only secret by another name.
        config: { retellAgentId: nonEmptyString },
        fields: [
          {
            key: "retellAgentId",
            label: "Retell agent ID",
            kind: "text",
            help: "The agent's own identifier in Retell, which starts with agent_.",
          },
        ],
        credentials: {
          required: true,
          fields: ["apiKey"],
          hint: lastFourOf("apiKey"),
        },
        credentialHelp:
          "Egma stores your Retell API key sealed and never shows it again. " +
          "It opens the text exchanges this connection conducts. A read gives " +
          "back its last four characters, so you can tell two keys apart.",
        credentialFields: [
          {
            field: "apiKey",
            label: "Retell API key",
            kind: "secret",
            help: "Copied from your Retell dashboard.",
          },
        ],
      },
    ],
    // The same vendor agent as the voice connection beside it, deliberately:
    // chat and voice land as two connections on **one** Egma agent, so the
    // comparison the model promises is between two histories of one identity
    // rather than between twins.
    reuse: {
      family: "retellAgentId",
      matchedKeys: ["retellAgentId"],
      identityOf: (config) => config["retellAgentId"],
    },
    // The plug ships. `egma_simulator.plugs.retell_text_mode.RetellTextMode`
    // is registered for this kind and conducts the exchange: the whole history
    // out, the agent's new messages back, with egma's answers carried on each
    // request. So a run over a text-mode connection is one egma can conduct,
    // and this says so in the same change that brought the adapter.
    simulatorAdapter: true,
    usesPlatformCarrier: false,
  },
  retell_web_call: {
    label: "Retell web call",
    agentPlatforms: ["retell"],
    /**
     * Retell web calls use WebRTC without the phone carrier. Record the connection
     * so results remain distinguishable from phone simulations. A run using mock
     * tools creates a temporary agent version instead of dialing the published number.
     */
    modalities: ["voice"],
    // Egma asks Retell to create the call and joins what Retell hands back.
    // Retell brokers it, exactly as it brokers a chat session.
    topology: "hosted-broker",
    accessVariants: [
      {
        id: "retell_web_call.api_key",
        label: "Retell API key",
        named: "a Retell web-call connection",
        config: { retellAgentId: nonEmptyString },
        fields: [
          {
            key: "retellAgentId",
            label: "Retell agent ID",
            kind: "text",
            help: "The agent's own identifier in Retell, which starts with agent_.",
          },
        ],
        credentials: {
          required: true,
          fields: ["apiKey"],
          hint: lastFourOf("apiKey"),
        },
        credentialHelp:
          "Egma stores your Retell API key sealed and never shows it again. " +
          "It opens the web calls this connection places. A read gives back " +
          "its last four characters, so you can tell two keys apart.",
        credentialFields: [
          {
            field: "apiKey",
            label: "Retell API key",
            kind: "secret",
            help: "Copied from your Retell dashboard.",
          },
        ],
      },
    ],
    // The same family again: a web call reaches the same Retell agents the
    // chat lanes do, and registering one must never mint that agent a twin.
    reuse: {
      family: "retellAgentId",
      matchedKeys: ["retellAgentId"],
      identityOf: (config) => config["retellAgentId"],
    },
    // The plug places the call and joins the room Retell opens for it, and the
    // control plane hands each simulation the version to place it against. A
    // run over this kind is conductable, so the registry says so.
    simulatorAdapter: true,
    usesPlatformCarrier: false,
  },
  phone_number: {
    label: "Phone number",
    agentPlatforms: "any",
    modalities: ["voice"],
    topology: "egma-dials-in",
    accessVariants: [
      {
        id: "phone_number.public_e164",
        label: "Public phone number",
        named: "a phone-number connection",
        config: { phoneNumber: e164PhoneNumber },
        fields: [
          {
            key: "phoneNumber",
            label: "Phone number",
            kind: "e164",
            help: "In international form, like +15551234567.",
          },
        ],
        credentialHelp:
          "A phone connection takes no credential. Egma dials the number " +
          "with its own telephony configuration.",
        credentialFields: [],
        // No reuse rule, deliberately: a number is where egma dials, not who
        // answers, and two agents can legitimately share one. Registering the
        // same number twice creates twice, and the name check is what stops a
        // duplicate that was a mistake.
        credentials: {
          required: false,
          refusal:
            "a phone connection takes no credential: the customer supplies a " +
            "public number, and Egma dials it with its own telephony " +
            "configuration",
        },
      },
    ],
    // The phone adapter ships in the simulator. POST /v1/runs separately checks the
    // deployment's carrier setup and returns phone_setup_required before writing a run.
    simulatorAdapter: true,
    usesPlatformCarrier: true,
  },
  livekit_room: {
    label: "LiveKit room",
    agentPlatforms: ["livekit"],
    // The registry may not claim what no code can run, so `chat` is here only
    // because the chat plug that conducts one ships beside it: egma dispatches
    // the named worker with the modality in its metadata, the agent goes
    // text-only, and the exchange rides the `lk.chat` and `lk.transcription`
    // topics on the room lane the voice driver already owns.
    modalities: ["voice", "chat"],
    // The first occupant of this topology: egma opens a room and the
    // customer's agent joins it. That is what makes an agent running on a
    // laptop reachable at all — nothing has to dial in to it.
    topology: "agent-dials-out",
    /**
     * Both LiveKit access variants require a worker name and carry test dispatch metadata.
     * With project credentials, Egma mints tokens and manages the room and dispatch.
     * With a token endpoint, Egma requests room_config and receives server_url plus
     * participant_token; room management depends on the authority the endpoint grants.
     * Both support voice and chat, with chat marked in the requested room name.
     */
    accessVariants: [
      {
        id: "livekit_room.project_credentials",
        label: "LiveKit project credentials [Recommended]",
        named: "a LiveKit room connection",
        config: {
          // The LiveKit server: a customer's cloud project, or the one they
          // run.
          url: livekitServerUrl,
          // Require a named worker for explicit dispatch, test metadata, and stable identity.
          // An unnamed worker could trigger automatic dispatch to a different agent.
          agentName: nonEmptyString,
        },
        fields: [
          {
            key: "url",
            label: "LiveKit WebSocket URL",
            kind: "url",
            help: "Your LiveKit project or self-hosted server, like wss://example.livekit.cloud.",
          },
          {
            key: "agentName",
            label: "LiveKit agent name",
            kind: "text",
            help: "The name your worker registers under. Egma dispatches that worker by name for every simulation, so the record names the agent it graded.",
          },
        ],
        credentialHelp:
          "This is the quickest setup. Egma mints its own room tokens from " +
          "this pair and stores it sealed. A read gives back the last four " +
          "characters of the key, never the secret.",
        credentialFields: [
          {
            field: "apiKey",
            label: "API key",
            kind: "secret",
            help: "The LiveKit project's API key.",
          },
          {
            field: "apiSecret",
            label: "API secret",
            kind: "secret",
            help: "The LiveKit project's API secret.",
          },
        ],
        credentials: {
          required: true,
          fields: ["apiKey", "apiSecret"],
          // The key, never the secret: a key is the half a customer can read
          // back off their own dashboard to tell two projects apart.
          hint: lastFourOf("apiKey"),
        },
        mixedUp:
          "a livekit connection mints its own tokens, so it needs the " +
          "project's apiKey and apiSecret. Send the pair, or name a " +
          "tokenEndpoint in the config and Egma will ask that endpoint for a " +
          "token instead — which is the access variant where the project's secret " +
          "never leaves the customer.",
      },
      {
        named: "a token-endpoint livekit connection",
        id: "livekit_room.customer_token_endpoint",
        label: "Customer token endpoint [Advanced]",
        // Speaks both, like the key pair. A chat simulation's room is asked
        // for under its marked name, `egma-sim-chat-…`, which the endpoint's
        // `egma-sim-` allowlist matches unchanged and the worker reads
        // however the token was minted.
        config: {
          // Where egma asks for a token, once per simulation. The answer names
          // the LiveKit server to join, so no url is held here.
          tokenEndpoint: tokenEndpointUrl,
          // Which worker to dispatch. Egma asks the endpoint for it by name,
          // in the `room_config` of LiveKit's standard token request — with
          // the test's `env.job_dispatch_metadata` as that dispatch's
          // metadata — and the endpoint copies that block into the token it
          // mints, so a named dispatch needs no key pair on egma's side.
          // Demanded for the same reason as on the key-pair variant: the
          // record names the agent it graded.
          agentName: nonEmptyString,
        },
        fields: [
          {
            key: "tokenEndpoint",
            label: "Token endpoint",
            kind: "url",
            help: "The public HTTPS URL where Egma asks for one room token per simulation. It answers with the token and your LiveKit server URL. Private network addresses are refused.",
          },
          {
            key: "agentName",
            label: "LiveKit agent name",
            kind: "text",
            help: "The name your worker registers under. Egma asks your endpoint to dispatch that worker by name for every simulation, so the record names the agent it graded.",
          },
        ],
        credentialHelp:
          "This is a customer-operated integration. Auth headers are sent " +
          "when Egma asks your public HTTPS endpoint for a token. They are " +
          "required so another caller cannot mint a room token. " +
          "A read gives back the header names and never their values.",
        credentialFields: [
          {
            field: "headers",
            label: "Auth headers",
            kind: "json",
            help: 'A JSON object of header name to header value, like {"Authorization":"Bearer …"}.',
          },
        ],
        credentials: {
          required: true,
          fields: ["headers"],
          gate: authHeadersJson,
          // The header names and never their values — see `namesIn`.
          hint: namesIn("headers"),
        },
        mixedUp:
          "a livekit connection whose config names a tokenEndpoint asks that " +
          "endpoint for every token, so it holds no key pair of its own: its " +
          "credentials are the endpoint's auth headers, shaped { headers }. " +
          "Send those, or drop the tokenEndpoint and Egma will mint its own " +
          "tokens from an apiKey and apiSecret.",
      },
    ],
    simulatorAdapter: true,
    usesPlatformCarrier: false,
    // Reuse by worker name and normalized server or token endpoint identity.
    // Filter candidates by agentName in SQL, then compare addresses in identityOf.
    reuse: {
      matchedKeys: ["agentName"],
      identityOf: (config) => {
        const agentName = config["agentName"];
        if (agentName === undefined) return undefined;
        const url = config["url"];
        if (url !== undefined) return `${livekitServerOrigin(url)}|${agentName}`;
        // On the token-endpoint variant the endpoint stands in for the
        // server: it is the one address the connection holds, and the server
        // it answers with is not known until a simulation asks it. The whole
        // route counts, not the origin alone, because one gateway mints for
        // many projects — and an identity that always carries a path can
        // never compare equal to a server's, which never does.
        const endpoint = config["tokenEndpoint"];
        if (endpoint === undefined) return undefined;
        return `${tokenEndpointIdentity(endpoint)}|${agentName}`;
      },
    },
  },
};

/** How a refusal names one access variant. */
function nameOf(
  connectionType: ConnectionType,
  variant: AccessVariantDescriptor,
): string {
  return variant.named ?? `a ${connectionType} connection`;
}

/** Use the access variant's restricted modalities, or the connection type's defaults. */
export function modalitiesOf(
  descriptor: ConnectionDescriptor,
  variant: AccessVariantDescriptor,
): readonly Modality[] {
  return variant.modalities?.speaks ?? descriptor.modalities;
}

/** The connection types something can actually conduct a run over today. */
export function conductableConnectionTypes(): readonly ConnectionType[] {
  return CONNECTION_TYPES.filter(
    (connectionType) => CONNECTION_REGISTRY[connectionType].simulatorAdapter,
  );
}

/**
 * Return connection types that share this reuse family. With no family, return
 * only this type; with no reuse rule, return []. Family members identify the same
 * agent platform identity across different connection types.
 */
export function reuseFamilyOf(
  connectionType: ConnectionType,
): readonly ConnectionType[] {
  const family = CONNECTION_REGISTRY[connectionType].reuse?.family;
  if (family === undefined) {
    return CONNECTION_REGISTRY[connectionType].reuse === undefined
      ? []
      : [connectionType];
  }
  return CONNECTION_TYPES.filter(
    (one) => CONNECTION_REGISTRY[one].reuse?.family === family,
  );
}

/**
 * Check the stored connection type, access variant, and modality against the
 * shipped adapter. Agent-platform validation, such as Retell agent type, happens
 * separately during API claim assembly.
 */
export function connectionIsConductable(
  connectionType: string,
  accessVariant: string,
  modality: string,
): boolean {
  const descriptor = CONNECTION_REGISTRY[connectionType as ConnectionType];
  if (descriptor === undefined || !descriptor.simulatorAdapter) return false;
  const variant = descriptor.accessVariants.find(
    (one) => one.id === accessVariant,
  );
  if (variant === undefined) return false;
  // The variant's own list, never the kind's, or a stored row on a narrowed
  // variant would be dispatched for a modality the door refused to write.
  return modalitiesOf(descriptor, variant).includes(modality as Modality);
}

/**
 * Connection types allowed to open credentials for the platform read at run start.
 * These reads resolve the agent version before simulations are claimed.
 */
const READS_PLATFORM_AT_RUN_START: ReadonlySet<string> = new Set([
  // Text mode names its version on every request, so the version has to be
  // resolved once before the first one. The same read is where this lane finds
  // out it cannot reach a custom LLM at all.
  "retell_text_mode",
  // A web call is placed against a named version too, and the run records it
  // whether or not the connection mocks its tools: an unmocked web-call result
  // that named no version would be a result nobody could tie to an agent.
  "retell_web_call",
]);

/** Whether a run over this kind has to read the platform before it starts. */
export function connectionTypeReadsPlatformAtRunStart(
  connectionType: string,
): boolean {
  return READS_PLATFORM_AT_RUN_START.has(connectionType);
}

/** Whether this kind needs the deployment carrier on its claimed work order. */
export function connectionTypeUsesPlatformCarrier(
  connectionType: string,
): boolean {
  return (
    CONNECTION_REGISTRY[connectionType as ConnectionType]
      ?.usesPlatformCarrier === true
  );
}

/** Explain the missing adapter and list available connection types from the registry. */
export function noSimulatorAdapterMessage(
  connectionType: string,
  modality?: string,
): string {
  const reach =
    modality === undefined
      ? `${connectionType}`
      : `${connectionType} ${modality}`;
  return (
    `Egma has no simulator adapter for a ${reach} connection yet, ` +
    `so it will not start a run it cannot conduct. Run these tests over a ` +
    `connection Egma conducts today: ${conductableConnectionTypes().join(", ")}.`
  );
}


/**
 * Which platform a connection type pins, or null when it pins none.
 *
 * The connection row holds no platform of its own (ADR-0015). Where the type
 * names exactly one platform it answers on its own; where it names several or
 * any — `phone_number` spans platforms — the agent's declared platform
 * answers.
 */
export function platformOfConnectionType(
  connectionType: string,
): AgentPlatform | null {
  const platforms = descriptorOf(connectionType).agentPlatforms;
  if (platforms === "any" || platforms.length !== 1) return null;
  return platforms[0] ?? null;
}

export function descriptorOf(connectionType: string): ConnectionDescriptor {
  const descriptor = CONNECTION_REGISTRY[connectionType as ConnectionType];
  if (descriptor === undefined) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `"${connectionType}" is not a connection type Egma knows; expected one of ` +
        CONNECTION_TYPES.join(", "),
    );
  }
  return descriptor;
}

/**
 * The modality checked against what this kind speaks *on this access variant*.
 *
 * The variant is resolved leniently and on purpose. An id no entry claims is a
 * tuple nobody supports, and `productLabelOf` has the sentence for it — so this
 * falls back to the kind's own list rather than reaching for
 * `accessVariantById`, whose fault would answer 500 where the door answers 400
 * today and would take the useful sentence with it.
 */
export function validModality(
  connectionType: ConnectionType,
  accessVariant: string,
  modality: string,
): Modality {
  const descriptor = descriptorOf(connectionType);
  const variant = descriptor.accessVariants.find(
    (one) => one.id === accessVariant,
  );
  const speaking =
    variant === undefined
      ? descriptor.modalities
      : modalitiesOf(descriptor, variant);
  if (speaking.includes(modality as Modality)) return modality as Modality;

  // The kind can do this and the caller's way of reaching it cannot, which is
  // a different thing to be told — and the variant wrote the sentence that
  // tells it, because only the variant knows why.
  if (
    variant?.modalities !== undefined &&
    descriptor.modalities.includes(modality as Modality)
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      variant.modalities.refusal,
    );
  }

  const speaks = speaking.join(" or ");
  if (!MODALITIES.includes(modality as Modality)) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `"${modality}" is not a modality; a ${connectionType} connection speaks ${speaks}`,
    );
  }
  throw new AgentWriteRefusedError(
    "not_admitted",
    `a ${connectionType} connection speaks ${speaks}, and this one was asked for ${modality}`,
  );
}

/**
 * Validate required and supplied optional config keys; reject unknown keys.
 * Return normalized storage values. Product callers use validConfig to select
 * the gates from the access variant.
 */
export function gatedConfig(
  what: string,
  gates: Readonly<Record<string, ConfigDemand>>,
  config: unknown,
): Record<string, string> {
  // Optional keys say so, so a caller reading a refusal is never left thinking
  // egma wants a value it is happy to do without.
  const held = Object.entries(gates)
    .map(([key, demand]) => (isDemanded(demand) ? key : `${key} (optional)`))
    .join(", ");

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `${what}'s config is an object holding ${held}`,
    );
  }

  for (const key of Object.keys(config)) {
    // The gates' own keys, never what a prototype also answers to: a config
    // sent with `constructor` in it is a typo like any other, and treating it
    // as known would be the one unknown key that got dropped in silence.
    if (!Object.hasOwn(gates, key)) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `${what}'s config has no key "${key}"; it holds ${held}`,
      );
    }
  }

  const stored: Record<string, string> = {};
  for (const [key, demand] of Object.entries(gates)) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      if (!isDemanded(demand)) continue;
      throw new AgentWriteRefusedError(
        "not_admitted",
        `${what}'s config needs ${key}`,
      );
    }
    stored[key] = gateOf(demand)(key, value);
  }
  return stored;
}

/** The config as stored, gated by the explicitly named access variant. */
export function validConfig(
  connectionType: ConnectionType,
  accessVariant: AccessVariant,
  config: unknown,
): Record<string, string> {
  const variant = accessVariantById(connectionType, accessVariant);
  return gatedConfig(nameOf(connectionType, variant), variant.config, config);
}

/**
 * Whether a credential block could belong to one access variant at all — its
 * keys, and whether it is present when the variant requires it.
 *
 * The values are nobody's business here: a pair with a blank half belongs to
 * the access variant that takes a pair, and telling the caller which half is
 * blank is a better answer than telling them they picked the wrong variant.
 */
function couldBe(
  variant: AccessVariantDescriptor,
  credentials: unknown,
): boolean {
  const rule = variant.credentials;
  if (credentials === undefined) return rule.required !== true;
  if (rule.required === false) return false;
  if (
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    return false;
  }
  return Object.keys(credentials).every((key) => rule.fields.includes(key));
}

/**
 * Validate credentials for the explicit access variant and return values plus a
 * display hint, or null when absent and permitted. Reject forbidden credentials
 * and report when supplied keys belong to another access variant.
 */
export function validCredentials(
  connectionType: ConnectionType,
  accessVariant: AccessVariant,
  credentials: unknown,
): { readonly sealed: Record<string, string>; readonly hint: string } | null {
  const descriptor = descriptorOf(connectionType);
  const variant = accessVariantById(connectionType, accessVariant);
  const what = nameOf(connectionType, variant);
  const rule = variant.credentials;

  if (
    credentials === undefined &&
    rule.required === true &&
    variant.mixedUp !== undefined
  ) {
    throw new AgentWriteRefusedError("not_admitted", variant.mixedUp);
  }

  if (
    variant.mixedUp !== undefined &&
    !couldBe(variant, credentials) &&
    descriptor.accessVariants.some(
      (other) => other !== variant && couldBe(other, credentials),
    )
  ) {
    throw new AgentWriteRefusedError("not_admitted", variant.mixedUp);
  }

  if (rule.required === false) {
    if (credentials !== undefined) {
      throw new AgentWriteRefusedError("not_admitted", rule.refusal);
    }
    return null;
  }

  const held = `{ ${rule.fields.join(", ")} }`;
  if (credentials === undefined && rule.required === "if-sent") return null;
  if (
    credentials === undefined ||
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `${what} needs credentials shaped ${held}`,
    );
  }

  for (const key of Object.keys(credentials)) {
    if (!rule.fields.includes(key)) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `${what}'s credentials have no key "${key}"; they are shaped ${held}`,
      );
    }
  }

  const gate = rule.gate ?? credentialString;
  const sealed: Record<string, string> = {};
  for (const field of rule.fields) {
    sealed[field] = gate(
      what,
      field,
      (credentials as Record<string, unknown>)[field],
    );
  }

  return { sealed, hint: rule.hint(sealed) };
}
