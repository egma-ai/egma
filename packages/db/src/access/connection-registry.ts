import { isIP } from "node:net";

import {
  CONNECTION_KINDS,
  MODALITIES,
  type AccessVariant,
  type AgentPlatform,
  type ConnectionKind,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { AgentWriteRefusedError } from "./errors.ts";

/**
 * What each simulation connection kind is made of. The registry is code, not
 * a table, because a table could claim kinds the code cannot run: an entry lands here
 * in the same commit as its adapter, following the `VOICE_PROVIDERS`
 * precedent.
 *
 * It drives everything the access layer decides about a connection at the
 * door — which modalities the kind supports, the topology it implies (derived,
 * never caller-supplied: it predicts who moves first when a simulation
 * starts, and a caller's guess would just be wrong), which config keys are
 * demanded and how each is checked, and whether a credential is required or
 * refused outright. Every failure is named at create, so a typo surfaces
 * immediately rather than at run time.
 *
 * The map is `Record<ConnectionKind, …>`, so it cannot drift from the schema:
 * a kind added to `CONNECTION_KINDS` refuses to build until it is described
 * here, and an entry describing a kind the schema's CHECK would reject cannot
 * be written at all.
 */

/**
 * One config key's gate. Takes what the caller sent under `key` — absent
 * arrives as `undefined` — and answers the value as it will be stored, or
 * throws naming the key.
 */
type ConfigGate = (key: string, value: unknown) => string;

/**
 * A gate the caller may leave out.
 *
 * Most config keys are demanded, because a missing one means a reach nobody
 * can complete. Some are not: a key whose absence is itself a setting — "no
 * name given" meaning "whoever answers" — has to be allowed to be absent, and
 * demanding it would make a caller write down a value to mean the default they
 * already had.
 *
 * Optional is about absence and nothing else. A key that is there faces the
 * same gate it would have faced if it were demanded, so an optional key is
 * never a key where anything goes.
 */
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
  /**
   * Keep a supporting config field after the credential fields when that is
   * the order a person needs to fill the form in. Most config comes first;
   * this is only for a field such as room metadata that completes the setup.
   */
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

/**
 * The three answers to "does the customer supply a secret for this access variant",
 * said in the words the product uses everywhere else.
 *
 * The registry's own `required` field says the same thing in the words the
 * gates are written in (`true`, `false`, `"if-sent"`). This is the translation,
 * and it exists because a Restore is held to exactly this rule and its three
 * refusals are named after these three words — so the word a refusal uses and
 * the word a form shows come from one place.
 */
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
 * Whether the customer hands over a secret for this access variant, and what it holds.
 *
 * `true` demands it and `false` refuses it outright — a credential supplied
 * where none belongs is rejected rather than stored and silently ignored,
 * because a caller who sent one believes it matters. `"if-sent"` is the third
 * case, and it is not a softening of the first: it belongs to an access variant that
 * really works either way, where demanding one would be egma inventing a rule
 * the customer's own deployment does not have.
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
 * One access variant inside a connection kind: its config keys and credential
 * rule, together.
 *
 * Together rather than separately because an access variant is a fact about
 * the pair. A variant that asks an endpoint for a token holds no key pair of
 * its own, and a variant that mints tokens has nowhere to put an endpoint's
 * headers — so gating config and credentials against separate rules would
 * admit connections that are half of each and can do neither.
 *
 * Most connection kinds have one access variant and use a one-entry list.
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
   * The same keys as `config`, in their relative form order, with the words a
   * person needs to answer each one. A supporting field may explicitly follow
   * the credential group, while keeping its order among the config fields.
   *
   * Two lists rather than one because they answer two questions that must not
   * be allowed to become one: `config` is what a write is *gated* by, and this
   * is what a browser is *told*. Merging them would put presentation strings
   * inside the gate and would make the safe projection a filtered view of the
   * gate rather than a thing of its own — one forgotten spread away from
   * shipping a validator to a browser. They are held level by
   * the catalog projection, which refuses an access variant whose two
   * lists disagree, so drift is a failure at the door rather than a field
   * missing from a form.
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
};

export type ConnectionDescriptor = {
  /** What a person choosing a connection kind reads. Safe to send to a browser. */
  readonly label: string;
  /** Which agent platforms this direct path can reach, or every platform. */
  readonly agentPlatforms: readonly AgentPlatform[] | "any";
  readonly modalities: readonly Modality[];
  readonly topology: Topology;
  /**
   * The access variants supported inside this connection kind. The request
   * names one explicitly; config never selects one.
   */
  readonly accessVariants: readonly [
    AccessVariantDescriptor,
    ...AccessVariantDescriptor[],
  ];
  /**
   * Whether the simulator holds an adapter for this kind — whether Egma can
   * actually conduct a conversation over it.
   *
   * A kind can be registered before anything can run over it: a customer can
   * describe how to reach their agent while the adapter that reaches it is
   * still being written. So this is a fact about the shipped simulator, kept
   * here beside the rest of what the kind is, and it is what refuses a run at
   * creation instead of leaving it queued forever for a conductor that does
   * not exist. It flips to `true` in the same commit as the adapter.
   */
  readonly simulatorAdapter: boolean;
  /** Whether conducting this kind spends the deployment's shared carrier. */
  readonly usesPlatformCarrier: boolean;
  /**
   * Which config key holds the vendor's own name for the agent, for the kinds
   * that have one — and absent for the kinds that do not.
   *
   * This is the whole of a kind's create-or-reuse rule. Registering the same
   * vendor agent twice must not mint a second egma agent, because a retry
   * after an uncertain network failure is the ordinary case and a duplicate
   * identity splits a team's results history in half. So a kind that can say
   * "this is the same agent you already registered" names the key that says
   * it, and a kind that cannot — a framework the customer runs themselves has
   * no vendor identifier at all — declares none and always creates.
   */
  readonly reuseKey?: string | undefined;
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
 * The access variant a stored connection names, by the id its row carries.
 *
 * Every rule about an existing connection goes through this read. It never
 * infers an answer from config, so a stored id cannot drift.
 *
 * An id no entry claims is this deployment running against rows a later
 * release wrote. It is a fault rather than a refusal — nothing the caller sent
 * is wrong — and it says which access variant id and connection kind, because that is
 * what somebody needs to find it.
 */
export function accessVariantById(
  connectionKind: ConnectionKind,
  accessVariant: string,
): AccessVariantDescriptor {
  const found = descriptorOf(connectionKind).accessVariants.find(
    (variant) => variant.id === accessVariant,
  );
  if (found === undefined) {
    throw new Error(
      `access variant "${accessVariant}" is not one this Egma instance knows for a ` +
        `${connectionKind} connection; the access variants it holds are ` +
        descriptorOf(connectionKind)
          .accessVariants.map((variant) => variant.id)
          .join(", "),
    );
  }
  return found;
}

/**
 * Every supported simulation connection tuple, as a browser may be told about it.
 *
 * **What is not here is the point.** No gate, no hint function, no refusal
 * sentence, no credential value — the whole of what crosses is labels, field
 * shapes, the credential rule, and the two adapter facts. It is built by
 * reading the registry rather than by copying it, so an option added to the
 * registry appears in a form with nothing else edited, and a web application
 * that kept its own copy of any of this would be a second opinion able to
 * disagree with the gate.
 *
 * **An access variant whose two field lists disagree is refused here**, loudly
 * and for every caller at once. A gated key nobody described would be a field a form
 * never asks for and a create that then refuses for missing it; a described key
 * nothing gates would be a box whose answer is silently dropped. Both are
 * caught the first time anything asks for the catalog.
 */
export type ConnectionOptionMetadata = {
  readonly agentPlatform: AgentPlatform | null;
  readonly agentPlatformLabel: string;
  readonly connectionKind: ConnectionKind;
  readonly accessVariant: AccessVariant;
  readonly accessVariantLabel: string;
  readonly modality: Modality;
  readonly productLabel: string;
  readonly topology: Topology;
  /** Whether egma can conduct a simulation over this connection today. */
  readonly simulatorAdapter: boolean;
  /** Whether a claimed work order for this kind needs the platform carrier. */
  readonly usesPlatformCarrier: boolean;
  /** Whether egma ships something that can measure this connection's target. */
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
        (missing.length > 0 ? `${missing.join(", ")} is gated and undescribed` : "") +
        (missing.length > 0 && invented.length > 0 ? "; " : "") +
        (invented.length > 0 ? `${invented.join(", ")} is described and ungated` : ""),
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
      required: isDemanded(
        variant.config[field.key] as ConfigDemand,
      ),
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
  livekit_agents: "LiveKit Agents",
};

type ConnectionOption = {
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionKind: ConnectionKind;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  readonly productLabel: string;
};

const CONNECTION_OPTIONS: readonly ConnectionOption[] = [
  {
    agentPlatform: "retell",
    connectionKind: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
  },
  {
    agentPlatform: "retell",
    connectionKind: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Retell phone",
  },
  {
    agentPlatform: "livekit_agents",
    connectionKind: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    modality: "voice",
    productLabel: "LiveKit project credentials",
  },
  {
    agentPlatform: "livekit_agents",
    connectionKind: "livekit_room",
    accessVariant: "livekit_room.customer_token_endpoint",
    modality: "voice",
    productLabel: "LiveKit token endpoint",
  },
  {
    agentPlatform: "livekit_agents",
    connectionKind: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
  },
  {
    agentPlatform: null,
    connectionKind: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
  },
] as const;

export function connectionOptionMetadata(): readonly ConnectionOptionMetadata[] {
  return CONNECTION_OPTIONS.map((option) => {
    const descriptor = descriptorOf(option.connectionKind);
    const variant = accessVariantMetadata(
      accessVariantById(option.connectionKind, option.accessVariant),
    );
    return {
      ...option,
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
  connectionKind: ConnectionKind,
  accessVariant: AccessVariant,
  modality: Modality,
): string {
  const exact = CONNECTION_OPTIONS.find(
    (option) =>
      option.agentPlatform === agentPlatform &&
      option.connectionKind === connectionKind &&
      option.accessVariant === accessVariant &&
      option.modality === modality,
  );
  if (exact !== undefined) return exact.productLabel;

  throw new AgentWriteRefusedError(
    "not_admitted",
    "agent platform, connection kind, access variant, and modality do not form a supported simulation connection",
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
 * The names in a field holding a JSON object, and never their values.
 *
 * For a credential with no public half at all. Where a key pair has a key
 * whose tail gives nothing away, a set of auth headers is secret the whole way
 * through: the last four characters of `Bearer eyJ…` are four real characters
 * of a live credential, and printing them would buy a reader nothing they
 * could not get from the names. The names are what a person actually needs —
 * "this connection carries an Authorization header" — and they are not secret:
 * the shape of the request is public, only the values are not.
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
 * A JSON object, carried as the text it was written as.
 *
 * Text rather than a parsed object because it travels verbatim — it is handed
 * to the agent as the room's metadata exactly as it arrives, and re-serialising
 * it here would hand over something the customer never wrote. Checked all the
 * same, and checked at create: a stray comma refused here is a person looking
 * at their own mistake, while the same comma refused at dispatch is a run that
 * has already started and an agent left to make sense of it.
 */
function jsonObjectText(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be a JSON object written in a string, which ` +
        `looks like {"tenant":"acme"}`,
    );
  }
  return candidate;
}

/**
 * Where egma asks the customer for a token, per simulation.
 *
 * An address egma makes a request to, so ws and wss are refused here although
 * the server URL beside it takes them: a websocket scheme on this key is
 * somebody who pasted the wrong one of the two, and finding that out at create
 * costs a sentence where finding it out mid-run costs a simulation.
 *
 * This value later becomes an outbound request from the simulator. The
 * platform therefore admits only HTTPS hostnames here. Literal addresses and
 * localhost names are refused before storage; the simulator resolves the
 * hostname again at request time and admits only public addresses there. The
 * second check is load-bearing because DNS can change after this write.
 */
function tokenEndpointUrl(key: string, value: unknown): string {
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
        `https://example.com/egma/livekit-token`,
    );
  }
  return candidate;
}

/**
 * The headers egma sends when it asks for a token: a JSON object of header
 * name to header value, carried as the text it was written as.
 *
 * Checked at create like the config's own JSON is, and for the same reason: a
 * stray comma refused here is a person looking at their own mistake, while the
 * same comma refused at token time is a simulation that failed for a reason
 * nobody can see. The refusal names the field and shows the shape, and quotes
 * nothing of what was sent — the values are the credential.
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
  Record<ConnectionKind, ConnectionDescriptor>
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
    // The provider's own agent id: the first vendor to carry a reuse rule.
    reuseKey: "retellAgentId",
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
    // The simulator dials. `egma_simulator.plugs.phone.PhoneCall` is registered
    // for this kind and places the call over the deployment's own carrier
    // trunk, so a run over a phone connection is one egma can conduct.
    //
    // **What this says is a fact about the build, never about one deployment's
    // carrier.** Whether *this* platform has been given a trunk is a carrier
    // precondition, and it is a separate question that has to be asked where
    // a deployment's configuration is known — this package cannot see it.
    //
    // That second question is asked, and it is asked in front of this one.
    // `POST /v1/runs` reads the carrier precondition from the platform's own
    // store and refuses a run over a phone connection with
    // `phone_setup_required` before a row is written, so a platform nobody has
    // given a carrier says so instead of queueing a call it cannot place. The
    // two refusals sit in two layers because they are two different facts: this
    // line is about what the simulator ships with, and that one is about what
    // one installation has been configured with.
    simulatorAdapter: true,
    usesPlatformCarrier: true,
  },
  livekit_room: {
    label: "LiveKit room",
    agentPlatforms: ["livekit_agents"],
    // Voice only, and only because voice is the lane that exists. The registry
    // may not claim what no code can run, so `chat` arrives here in the same
    // commit as the code that conducts a livekit chat.
    modalities: ["voice"],
    // The first occupant of this topology: egma opens a room and the
    // customer's agent joins it. That is what makes an agent running on a
    // laptop reachable at all — nothing has to dial in to it.
    topology: "agent-dials-out",
    /**
     * The first kind to have two access variants, two answers to one
     * question: who mints the token that opens the room.
     *
     * The customer either hands egma their project's key pair and egma mints
     * its own, or they keep the pair and stand up an endpoint egma asks. The
     * first is the quickest setup and lets egma manage each simulation. The
     * second is an advanced, customer-operated integration for a team that
     * must keep the token-signing secret on its side.
     *
     * Nothing carries over between them. A connection that names an endpoint
     * holds no key pair, so it cannot create a room, cannot dispatch a worker
     * and cannot delete anything — which is why `agentName` and `metadata` are
     * not among its keys. Both are powers a key pair buys, and a config key
     * egma would silently ignore is worse than one it refuses by name.
     */
    accessVariants: [
      {
        id: "livekit_room.project_credentials",
        label: "LiveKit project credentials — Recommended",
        named: "a LiveKit room connection",
        config: {
          // The LiveKit server: a customer's cloud project, or the one they
          // run.
          url: livekitServerUrl,
          // Which worker to dispatch. Left out on purpose by most: a blank
          // agent name means automatic dispatch, where whichever worker is
          // listening takes the room, and that is the state every quickstart
          // agent runs in.
          agentName: optional(nonEmptyString),
          // Handed to the agent as the room's metadata, exactly as written.
          metadata: optional(jsonObjectText),
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
            help: "The LiveKit worker dispatch name. Leave it empty for automatic dispatch, where whichever worker is listening takes the room.",
          },
          {
            key: "metadata",
            label: "Room metadata",
            kind: "json",
            help: 'A JSON object handed to the agent as the room metadata, exactly as written, like {"tenant":"acme"}.',
            afterCredentials: true,
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
        label: "Customer token endpoint — Advanced",
        config: {
          // Where the join goes, unless the endpoint's answer names another.
          url: livekitServerUrl,
          // Where egma asks for a token, once per simulation.
          tokenEndpoint: tokenEndpointUrl,
        },
        fields: [
          {
            key: "url",
            label: "LiveKit WebSocket URL",
            kind: "url",
            help: "Your LiveKit project or self-hosted server, like wss://example.livekit.cloud.",
          },
          {
            key: "tokenEndpoint",
            label: "Token endpoint",
            kind: "url",
            help: "The public HTTPS URL where Egma asks for one room token per simulation. Private network addresses are refused.",
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
    // No reuse rule, deliberately: the url names a server rather than an
    // agent, whole teams share one, and the agent name is absent in the
    // ordinary case. There is nothing here that could honestly say two
    // registrations are about one agent, so each registration creates.
  },
};

/** How a refusal names one access variant. */
function nameOf(
  connectionKind: ConnectionKind,
  variant: AccessVariantDescriptor,
): string {
  return variant.named ?? `a ${connectionKind} connection`;
}

/** The connection kinds something can actually conduct a run over today. */
export function conductableConnectionKinds(): readonly ConnectionKind[] {
  return CONNECTION_KINDS.filter(
    (connectionKind) => CONNECTION_REGISTRY[connectionKind].simulatorAdapter,
  );
}

/**
 * Whether this exact stored connection can be handed to a simulator.
 *
 * The modality is checked here as well as at write time. Dispatch trusts only
 * a kind/access-variant/modality tuple the current registry says its adapter can
 * conduct. This
 * check cannot know whether an id inside a chat-labelled row belongs to a
 * provider voice agent; the Retell read in the API claim assembler owns that
 * second, provider-aware check.
 */
export function connectionIsConductable(
  connectionKind: string,
  accessVariant: string,
  modality: string,
): boolean {
  const descriptor = CONNECTION_REGISTRY[connectionKind as ConnectionKind];
  return (
    descriptor !== undefined &&
    descriptor.simulatorAdapter &&
    descriptor.accessVariants.some((variant) => variant.id === accessVariant) &&
    descriptor.modalities.includes(modality as Modality)
  );
}

/** Whether this kind needs the deployment carrier on its claimed work order. */
export function connectionKindUsesPlatformCarrier(
  connectionKind: string,
): boolean {
  return (
    CONNECTION_REGISTRY[connectionKind as ConnectionKind]
      ?.usesPlatformCarrier === true
  );
}

/**
 * What a run over a connection kind nothing can conduct is told.
 *
 * The wording is the platform's own and a client relays it word for word to
 * whoever is reading a terminal, so it says all of it in one place: what is
 * missing, why egma would rather refuse now than queue something forever, and
 * the move that works today. The list of kinds comes off the registry rather
 * than out of the sentence, so it can never name an adapter that has not
 * shipped or miss one that has.
 */
export function noSimulatorAdapterMessage(
  connectionKind: string,
  modality?: string,
): string {
  const reach =
    modality === undefined
      ? `${connectionKind}`
      : `${connectionKind} ${modality}`;
  return (
    `Egma has no simulator adapter for a ${reach} connection yet, ` +
    `so it will not start a run it cannot conduct. Run these tests over a ` +
    `connection Egma conducts today: ${conductableConnectionKinds().join(", ")}.`
  );
}

/** The descriptor, or a refusal naming what egma actually supports. */
export function descriptorOf(connectionKind: string): ConnectionDescriptor {
  const descriptor = CONNECTION_REGISTRY[connectionKind as ConnectionKind];
  if (descriptor === undefined) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `"${connectionKind}" is not a connection kind Egma knows; expected one of ` +
        CONNECTION_KINDS.join(", "),
    );
  }
  return descriptor;
}

/** The modality checked against the connection kind's own list. */
export function validModality(
  connectionKind: ConnectionKind,
  modality: string,
): Modality {
  const descriptor = descriptorOf(connectionKind);
  if (!descriptor.modalities.includes(modality as Modality)) {
    const speaks = descriptor.modalities.join(" or ");
    if (!MODALITIES.includes(modality as Modality)) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `"${modality}" is not a modality; a ${connectionKind} connection speaks ${speaks}`,
      );
    }
    throw new AgentWriteRefusedError(
      "not_admitted",
      `a ${connectionKind} connection speaks ${speaks}, and this one was asked for ${modality}`,
    );
  }
  return modality as Modality;
}

/**
 * A config as it will be stored, checked against a gate map: every demanded
 * key present and checked, every optional key checked when it is there, every
 * unknown key refused by name. Refusing unknowns is what turns a typo'd key
 * into an error at create rather than a demanded key "missing" at run time.
 *
 * `what` names the thing being described — "a livekit connection" — and every
 * refusal is built from it, so one wording serves every access variant.
 *
 * It takes the gates rather than reading them off a variant, so the rule can be
 * exercised on its own and a new gate can be tried without a connection kind
 * to hang it on. `validConfig` below is the registry-aware door, and is what
 * everything in the product actually calls.
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
  connectionKind: ConnectionKind,
  accessVariant: AccessVariant,
  config: unknown,
): Record<string, string> {
  const variant = accessVariantById(connectionKind, accessVariant);
  return gatedConfig(nameOf(connectionKind, variant), variant.config, config);
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
 * The credentials as they will be sealed, plus the display hint — or null for
 * an access variant where the customer supplies no secret. A credential handed
 * to such a variant is refused with its own reason, never stored and never
 * silently dropped.
 *
 * The access variant selects this rule explicitly. A caller who sent the
 * *other* access variant's credentials
 * hears about the mix rather than about a key it never meant to send: whoever
 * pastes a key pair under a token endpoint has mixed up two whole ways of
 * working, and being told `"apiKey"` is not a field would send them looking
 * for a typo that is not there.
 */
export function validCredentials(
  connectionKind: ConnectionKind,
  accessVariant: AccessVariant,
  credentials: unknown,
): { readonly sealed: Record<string, string>; readonly hint: string } | null {
  const descriptor = descriptorOf(connectionKind);
  const variant = accessVariantById(connectionKind, accessVariant);
  const what = nameOf(connectionKind, variant);
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
