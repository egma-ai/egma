/**
 * The agent and connection endpoints of the fixture platform.
 *
 * This is the contract the CLI is built against, written down as something that
 * runs: register an agent together with the first way of reaching it, read
 * it back, and attach another connection later.
 *
 * It answers what the real instance answers, including which refusal goes with
 * which mistake, because a fixture that is kinder than the real thing is a
 * fixture that hides bugs. Everything it refuses, the access layer behind the
 * seam refuses for the same reason: a modality the connection type does not
 * speak, a config key the access variant has no place for, a credential where
 * none belongs or none where one is required, and a name a living row already
 * holds.
 *
 * Three shapes are load-bearing and none of them is this file's to change:
 *
 * - **No resource is rooted at a project.** An agent is `/v1/agents/:agentId`
 *   and never `/v1/projects/:projectId/agents/…`. A write may *name* a project
 *   in its body; a read filters by one in the query.
 * - **The organization never appears in an address.** Which customer this is
 *   comes from the key and from nowhere else, which is what stops a copied key
 *   writing into somebody else's account by asking nicely.
 * - **A sealed secret never comes back.** A durable connection credential is
 *   stored sealed and answered as its last four characters and nothing more.
 *   A request-only platform selection credential is not stored at all.
 *
 * Two more are the public API's rather than the factory's, and both are here
 * because a client that guessed at either would fail in somebody's terminal:
 *
 * - **Registering is retry-safe by construction.** A registration carrying an
 *   inline connection goes through the per-kind reuse rule, and the reply's
 *   `result` says which of the three things happened — created, reused, or the
 *   same agent reached a new way. A `reused` registration wrote no row, so it
 *   rides a 200 where the other two ride a 201.
 * - **An unknown key is refused by name.** That is what turns a typo into an
 *   answer a coding agent can act on, and it is what makes the dropped vendor
 *   payload loud: a client still sending what was pulled from the provider
 *   hears so, instead of watching egma quietly keep nothing.
 */

import { isIP } from "node:net";

import { connectionOptionMetadata } from "@egma/db";
import { given, isId, newId, NOT_AUTHENTICATED, PAGE_SIZE } from "./reading.ts";
import type { FixtureAnswer, RouteGroup } from "./server.ts";

/** The floor under a credential field, so a last-4 hint stays a hint. */
const SHORTEST_CREDENTIAL = 8;

type ConfigGate = (key: string, value: unknown) => string;

/**
 * A gate the caller may leave out, mirroring the registry behind the seam.
 * Optional is about absence and nothing else: a key that is there faces the
 * same gate it would have faced if it were demanded.
 */
type OptionalGate = { readonly optional: true; readonly gate: ConfigGate };

type ConfigDemand = ConfigGate | OptionalGate;

function optional(gate: ConfigGate): OptionalGate {
  return { optional: true, gate };
}

function isDemanded(demand: ConfigDemand): boolean {
  return typeof demand === "function";
}

type CredentialGate = (what: string, field: string, value: unknown) => string;

type CredentialHint = (sealed: Record<string, string>) => string;

type CredentialRule =
  | {
      /** `true` demands them; `"if-sent"` takes them when they come. */
      readonly required: true | "if-sent";
      readonly fields: readonly string[];
      /** How each field is checked. Left out: an ordinary credential string. */
      readonly gate?: CredentialGate;
      readonly hint: CredentialHint;
    }
  | { readonly required: false; readonly refusal: string };

/**
 * One access variant — config keys and the credential that goes with them,
 * together — mirroring the registry behind the seam. Together because the
 * access variant is a fact about the pair: gating the two against separate
 * rules would admit connections that are half of each and can do neither.
 */
type AccessVariant = {
  readonly id: string;
  /** How a refusal names this access variant. Left out: named after the kind. */
  readonly named?: string;
  readonly config: Readonly<Record<string, ConfigDemand>>;
  readonly credentials: CredentialRule;
  /** What a caller sending the *other* access variant's credentials is told. */
  readonly mixedUp?: string;
};

type Descriptor = {
  readonly modalities: readonly string[];
  readonly topology: string;
  /** The access variants this connection type supports. */
  readonly accessVariants: readonly [AccessVariant, ...AccessVariant[]];
  /**
   * Which config key decides that two registrations are about one vendor
   * agent. A type that cannot answer that — a framework the customer runs
   * themselves has no vendor identifier — declares none and always creates.
   */
  readonly reuseKey?: string;
  /** Whether anything can conduct a run over this connection type today. */
  readonly simulatorAdapter: boolean;
};

function nonEmptyString(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Refusal(`the config's ${key} must be a non-empty string`);
  }
  return value.trim();
}

/** E.164: a plus, then up to fifteen digits with no leading zero. */
const E164 = /^\+[1-9]\d{1,14}$/u;

function e164PhoneNumber(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!E164.test(candidate)) {
    throw new Refusal(
      `the config's ${key} must be an E.164 phone number, which looks like +15551234567`,
    );
  }
  return candidate;
}

/** The four schemes a LiveKit server URL is written in; the SDKs normalise. */
const LIVEKIT_URL_SCHEMES = ["ws:", "wss:", "http:", "https:"];

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
    // `wss:acme.livekit.cloud` parses and then reaches nothing, so the
    // slashes are demanded here rather than missed at dial time.
    !candidate.toLowerCase().startsWith(`${scheme}//`)
  ) {
    throw new Refusal(
      `the config's ${key} must be a ws, wss, http or https URL, which looks like wss://example.livekit.cloud`,
    );
  }
  return candidate;
}

/** The ordinary credential field: one non-empty string, stored trimmed. */
function credentialString(what: string, field: string, value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") {
    throw new Refusal(
      `${what}'s credentials need ${field} to be a non-empty string`,
    );
  }
  if (trimmed.length < SHORTEST_CREDENTIAL) {
    throw new Refusal(
      `${what}'s credentials need ${field} to be at least ${SHORTEST_CREDENTIAL} characters`,
    );
  }
  return trimmed;
}

/** The last four of one field — only ever a credential's public half. */
function lastFourOf(field: string): CredentialHint {
  return (sealed) => sealed[field]?.slice(-4) ?? "";
}

/**
 * The names in a field holding a JSON object, and never their values: for a
 * credential with no public half, where a tail would be real characters of a
 * live secret.
 */
function namesIn(field: string): CredentialHint {
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

/** Where egma asks the customer for a token, per simulation. */
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
    throw new Refusal(
      `the config's ${key} must be a public https URL, which looks like https://example.com/egma/livekit-token`,
    );
  }
  return candidate;
}

/** The headers egma sends when it asks for a token, checked at create. */
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
    throw new Refusal(
      `${what}'s credentials need ${field} to be a JSON object of header name to header value, ` +
        `written in a string, which looks like {"Authorization":"Bearer …"}`,
    );
  }
  return candidate;
}

/** A JSON object carried as the text it was written as, checked at create. */
function jsonObjectText(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Refusal(
      `the config's ${key} must be a JSON object written in a string, which looks like {"tenant":"acme"}`,
    );
  }
  return candidate;
}

/**
 * What each connection type is made of, mirroring the registry behind the seam.
 *
 * Phone and LiveKit are here although this Retell path writes neither. They
 * make the checks about per-kind validation real rather than one kind agreeing
 * with itself. LiveKit also carries optional config keys, so the fixture cannot
 * quietly demand what the real thing is happy to do without.
 */
const REGISTRY: Readonly<Record<string, Descriptor>> = {
  retell_chat_api: {
    modalities: ["chat"],
    topology: "hosted-broker",
    accessVariants: [
      {
        id: "retell_chat_api.api_key",
        named: "a Retell chat connection",
        config: { retellAgentId: nonEmptyString },
        credentials: {
          required: true,
          fields: ["apiKey"],
          hint: lastFourOf("apiKey"),
        },
      },
    ],
    // The provider's own agent id: the first vendor to carry a reuse rule.
    reuseKey: "retellAgentId",
    simulatorAdapter: true,
  },
  phone_number: {
    modalities: ["voice"],
    topology: "egma-dials-in",
    accessVariants: [
      {
        id: "phone_number.public_e164",
        named: "a phone-number connection",
        config: { phoneNumber: e164PhoneNumber },
        // No reuse rule, deliberately: a number is where egma dials, not who
        // answers, and two agents can legitimately share one.
        credentials: {
          required: false,
          refusal:
            "a phone connection takes no credential: the customer supplies a public number, " +
            "and Egma dials it with its own telephony configuration",
        },
      },
    ],
    // The simulator dials: the phone plug is in the shipped build. Whether one
    // deployment's carrier is set up is a separate fact, answered elsewhere.
    //
    // **This fixture stands for a platform whose carrier is set up**, which is
    // why it starts a phone run rather than refusing one. The real API asks a
    // second question this fixture has no answer to — `phone_setup_required`,
    // refused at `POST /v1/runs` before a row is written when that
    // deployment's phone half was never configured — because the answer is a
    // deployment's own environment and a fixture has no deployment. A client
    // reading a refusal from a real platform therefore meets a code this
    // fixture never sends; `startRun` in `platform/runs.ts` relays any 422 by
    // its sentence rather than by its code, so there is nothing here to teach.
    simulatorAdapter: true,
  },
  livekit_room: {
    // Voice only, because voice is the lane that exists.
    modalities: ["voice"],
    // egma opens the room and the customer's agent joins it.
    topology: "agent-dials-out",
    /**
     * Two access variants answer one question: who mints the
     * token that opens the room. Nothing carries over between them — a
     * connection that names an endpoint holds no key pair, so it cannot
     * dispatch a worker or carry room metadata, and both keys are refused on
     * it by name rather than silently ignored.
     */
    accessVariants: [
      {
        id: "livekit_room.project_credentials",
        named: "a LiveKit room connection",
        config: {
          url: livekitServerUrl,
          // Left out means automatic dispatch: whichever worker is listening.
          agentName: optional(nonEmptyString),
          // Handed to the agent as the room's metadata, exactly as written.
          metadata: optional(jsonObjectText),
        },
        credentials: {
          required: true,
          fields: ["apiKey", "apiSecret"],
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
        id: "livekit_room.customer_token_endpoint",
        named: "a token-endpoint livekit connection",
        config: { url: livekitServerUrl, tokenEndpoint: tokenEndpointUrl },
        credentials: {
          required: true,
          fields: ["headers"],
          gate: authHeadersJson,
          // The header names and never their values.
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
    // No reuse rule: the url names a server rather than an agent.
    simulatorAdapter: true,
  },
};

const CONNECTION_TYPES = Object.keys(REGISTRY);

const CONNECTION_OPTIONS = [
  {
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    productLabel: "Retell chat",
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
    accessVariant: "livekit_room.customer_token_endpoint",
    modality: "voice",
    productLabel: "LiveKit token endpoint",
  },
  {
    agentPlatform: "livekit",
    connectionType: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
  },
  {
    agentPlatform: null,
    connectionType: "phone_number",
    accessVariant: "phone_number.public_e164",
    modality: "voice",
    productLabel: "Phone number",
  },
] as const;

export const FIXTURE_CONNECTION_OPTION_FACTS = CONNECTION_OPTIONS.map((option) => ({
  ...option,
  topology: (REGISTRY[option.connectionType] as Descriptor).topology,
  simulatorAdapter: (REGISTRY[option.connectionType] as Descriptor).simulatorAdapter,
}));

function productLabelOf(
  agentPlatform: string | null,
  connectionType: string,
  accessVariant: string,
  modality: string,
): string {
  const option = CONNECTION_OPTIONS.find(
    (one) =>
      one.agentPlatform === agentPlatform &&
      one.connectionType === connectionType &&
      one.accessVariant === accessVariant &&
      one.modality === modality,
  );
  if (option !== undefined) return option.productLabel;

  throw new Refusal(
    "agent platform, connection type, access variant, and modality do not form a supported simulation connection",
  );
}

/** How a refusal names an access variant: the kind itself, unless the variant says. */
function nameOf(connectionType: string, variant: AccessVariant): string {
  return variant.named ?? `a ${connectionType} connection`;
}

function accessVariantById(
  connectionType: string,
  accessVariant: unknown,
): AccessVariant {
  const named = typeof accessVariant === "string" ? accessVariant : "";
  const variant = descriptorOf(connectionType).accessVariants.find(
    (one) => one.id === named,
  );
  if (variant === undefined) {
    throw new Refusal(
      `access variant "${named}" does not belong to connection type ${connectionType}`,
    );
  }
  return variant;
}

/**
 * The connection types something can actually conduct a run over today.
 *
 * Read off the registry rather than written out, so a refusal naming what works
 * can never name an adapter that has not shipped or miss one that has.
 */
export const CONDUCTABLE_KINDS: readonly string[] = CONNECTION_TYPES.filter(
  (kind) => (REGISTRY[kind] as Descriptor).simulatorAdapter,
);

/** What a registration holds, and what a connection holds. Nothing else. */
const AGENT_KEYS = ["name", "agentPlatform", "projectId", "connection"] as const;
const CONNECTION_KEYS = [
  "name",
  "agentPlatform",
  "connectionType",
  "accessVariant",
  "modality",
  "environment",
  "config",
  "credentials",
  "agentPlatformSelection",
] as const;

/** A refusal with a sentence in it, turned into an answer at the door. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "Refusal";
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_request";
  }
}

/**
 * The unknown-key gate, written once for both objects a registration carries.
 *
 * Refusing by name rather than ignoring is what turns a typo into an answer a
 * coding agent can act on. And it is what makes the dropped vendor payload
 * loud: egma no longer keeps what was pulled from the provider — the agent's
 * content stays where it lives and is read fresh through the sealed credential
 * — so a client still sending a copy of it is told, rather than left believing
 * egma holds something it does not.
 */
function refuseUnknownKeyIn(
  body: Record<string, unknown>,
  held: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(body)) {
    if (held.includes(key)) continue;
    if (key === "pulled") {
      throw new Refusal(
        `Egma no longer keeps what was pulled from the provider, so ${what} ` +
          'has no "pulled" key. Drop it and send ' +
          `${held.join(", ")}; the agent's content stays at the provider, ` +
          "where Egma reads it fresh rather than out of a copy that would go " +
          "stale.",
      );
    }
    throw new Refusal(`${what} has no key "${key}"; it holds ${held.join(", ")}`);
  }
}

function descriptorOf(connectionType: unknown): Descriptor {
  const named = typeof connectionType === "string" ? connectionType : "";
  const descriptor = REGISTRY[named];
  if (descriptor === undefined) {
    throw new Refusal(
      `"${named}" is not a connection type Egma knows; expected one of ${CONNECTION_TYPES.join(", ")}`,
    );
  }
  return descriptor;
}

function validModality(connectionType: string, modality: unknown): string {
  const descriptor = descriptorOf(connectionType);
  const named = typeof modality === "string" ? modality : "";
  if (!descriptor.modalities.includes(named)) {
    throw new Refusal(
      `a ${connectionType} connection speaks ${descriptor.modalities.join(" or ")}, and this one was asked for ${named}`,
    );
  }
  return named;
}

function validConfig(
  connectionType: string,
  accessVariant: string,
  config: unknown,
): Record<string, string> {
  const variant = accessVariantById(connectionType, accessVariant);
  const what = nameOf(connectionType, variant);
  const gates = variant.config;
  // Optional keys say so, so a caller reading a refusal is never left thinking
  // egma wants a value it is happy to do without.
  const held = Object.entries(gates)
    .map(([key, demand]) => (isDemanded(demand) ? key : `${key} (optional)`))
    .join(", ");

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Refusal(`${what}'s config is an object holding ${held}`);
  }

  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(gates, key)) {
      throw new Refusal(`${what}'s config has no key "${key}"; it holds ${held}`);
    }
  }

  const stored: Record<string, string> = {};
  for (const [key, demand] of Object.entries(gates)) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      if (!isDemanded(demand)) continue;
      throw new Refusal(`${what}'s config needs ${key}`);
    }
    stored[key] = (typeof demand === "function" ? demand : demand.gate)(key, value);
  }
  return stored;
}

/**
 * Whether a credential block could belong to one access variant at all — its
 * keys, and whether it is there when the access variant needs it there. The
 * values are nobody's business here.
 */
function couldBe(variant: AccessVariant, credentials: unknown): boolean {
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

function validCredentials(
  connectionType: string,
  accessVariant: string,
  credentials: unknown,
): { readonly sealed: Record<string, string>; readonly hint: string } | null {
  const variants = descriptorOf(connectionType).accessVariants;
  const variant = accessVariantById(connectionType, accessVariant);
  const what = nameOf(connectionType, variant);
  const rule = variant.credentials;

  if (
    credentials === undefined &&
    rule.required === true &&
    variant.mixedUp !== undefined
  ) {
    throw new Refusal(variant.mixedUp);
  }

  // A caller who sent the *other* access variant's credentials hears about the mix
  // rather than about a key they never meant to send.
  if (
    variant.mixedUp !== undefined &&
    !couldBe(variant, credentials) &&
    variants.some((other) => other !== variant && couldBe(other, credentials))
  ) {
    throw new Refusal(variant.mixedUp);
  }

  if (rule.required === false) {
    if (credentials !== undefined) throw new Refusal(rule.refusal);
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
    throw new Refusal(`${what} needs credentials shaped ${held}`);
  }

  for (const key of Object.keys(credentials)) {
    if (!rule.fields.includes(key)) {
      throw new Refusal(
        `${what}'s credentials have no key "${key}"; they are shaped ${held}`,
      );
    }
  }

  const gate = rule.gate ?? credentialString;
  const sealed: Record<string, string> = {};
  for (const field of rule.fields) {
    sealed[field] = gate(what, field, (credentials as Record<string, unknown>)[field]);
  }

  return { sealed, hint: rule.hint(sealed) };
}

/**
 * A name, which is the one thing a write cannot go ahead without.
 *
 * Its own answer rather than the registry's: nothing about the body could not
 * be written, so it is what the caller says that cannot be acted on.
 */
function validName(name: unknown, what: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") {
    throw new Refusal(`${what} needs a name`, { status: 422, code: "unprocessable" });
  }
  return trimmed;
}

/**
 * A connection payload the registry has already taken, on its way to a row.
 *
 * It exists so that the whole of the checking happens once, before anything
 * decides whether this registration creates, reuses or extends. Every branch
 * then works from the same admitted payload, which is what makes "a reuse is
 * held to exactly what a create is held to" true by construction rather than by
 * two lists somebody keeps in step.
 */
type Admitted = {
  /** Absent means the smallest free numbered name for the connection type. */
  readonly name: string | undefined;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: string;
  readonly productLabel: string;
  /** Derived from the connection type, never caller-supplied. */
  readonly topology: string;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  readonly credentials: {
    readonly sealed: Record<string, string>;
    readonly hint: string;
  } | null;
};

type StoredConnection = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: string;
  readonly productLabel: string;
  readonly topology: string;
  readonly environment: string | null;
  readonly config: Readonly<Record<string, string>>;
  /** Sealed. Nothing outside this file ever reads it back through a route. */
  credentials: Readonly<Record<string, string>> | null;
  credentialsHint: string | null;
  readonly createdAt: string;
  updatedAt: string;
};

/**
 * An agent, and the monitoring half it owns on its own row (ADR-0015).
 *
 * The binding, the sealed monitoring key and the pull switch live here rather
 * than on a connection. Every agent is bound to its platform at registration;
 * the monitoring half may still be absent: a LiveKit agent that only pushes is
 * bound and never pulls.
 */
export type StoredAgent = {
  readonly id: string;
  readonly projectId: string;
  name: string;
  // Written at registration, and by start-monitoring exactly as the real
  // access layer writes it: binding an agent Egma is told to watch.
  agentPlatform: BoundPlatform;
  platformAgentId: string | null;
  /** Sealed. Only its hint ever leaves this file through a route. */
  monitoringApiKey: string | null;
  monitoringApiKeyHint: string | null;
  monitoringExportApiKeyId: string | null;
  pullProductionCalls: boolean;
  /** When a production call last arrived, as the drainer would stamp it. */
  lastReceivedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
};

/** The platforms an agent may be bound to, refused by name like every enum. */
const AGENT_PLATFORMS = ["retell", "livekit"] as const;

type BoundPlatform = (typeof AGENT_PLATFORMS)[number];

/** The binding a registration asked for — required, in the real thing's words. */
function agentPlatformIn(value: unknown): BoundPlatform {
  if (
    typeof value !== "string" ||
    !(AGENT_PLATFORMS as readonly string[]).includes(value)
  ) {
    throw new Refusal(
      "an agent platform is required and must be retell or livekit",
    );
  }
  return value as BoundPlatform;
}

/** A brand-new roster row: named, in a project, and bound to its platform. */
export function blankAgent(
  projectId: string,
  name: string,
  agentPlatform: BoundPlatform,
): StoredAgent {
  const now = new Date().toISOString();
  return {
    id: newId("agt"),
    projectId,
    name,
    agentPlatform,
    platformAgentId: null,
    monitoringApiKey: null,
    monitoringApiKeyHint: null,
    monitoringExportApiKeyId: null,
    pullProductionCalls: false,
    lastReceivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** An agent, as every read of one describes it. */
function agentOut(agent: StoredAgent): Record<string, unknown> {
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    agentPlatform: agent.agentPlatform,
    platformAgentId: agent.platformAgentId,
    monitoringKeyPresent: agent.monitoringApiKeyHint !== null,
    monitoringApiKeyHint: agent.monitoringApiKeyHint,
    monitoringExportApiKeyId: agent.monitoringExportApiKeyId,
    pullProductionCalls: agent.pullProductionCalls,
    lastReceivedAt: agent.lastReceivedAt,
    archived: false,
    archivedAt: null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

/**
 * A connection, as every read of one describes it.
 *
 * The sealed envelope has no line here, so there is no serializer to remember
 * to strip it in. `credentialsHint` is the whole of what comes back: enough to
 * tell one provider key from another, and enough to see that a rotation landed.
 */
function connectionOut(connection: StoredConnection): Record<string, unknown> {
  return {
    id: connection.id,
    agentId: connection.agentId,
    projectId: connection.projectId,
    name: connection.name,
    agentPlatform: connection.agentPlatform,
    connectionType: connection.connectionType,
    accessVariant: connection.accessVariant,
    modality: connection.modality,
    productLabel: connection.productLabel,
    topology: connection.topology,
    environment: connection.environment,
    config: connection.config,
    credentialsHint: connection.credentialsHint,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export type AgentControls = {
  /** Every agent written, oldest first. */
  readonly agents: readonly StoredAgent[];
  /**
   * Say a production call has arrived for one agent, as the drainer stamps it.
   *
   * The poller is not part of this fixture, so the one fact a terminal waits on
   * — when this agent last received — is put there directly by whatever is
   * standing in for production traffic.
   */
  received(agentId: string, at?: Date): void;
  /** Every connection written, oldest first. */
  readonly connections: readonly StoredConnection[];
  /**
   * Every secret this fixture was handed, in the order it arrived.
   *
   * A check asserting the key reached the platform reads it here. It exists
   * because the alternative — asserting on a request body a test recorded —
   * would put the secret somewhere a failing test prints.
   */
  readonly sealed: readonly string[];
  /** The project a write named, or `null`, per write. */
  readonly projectsNamed: readonly (string | null)[];
  /** Bind a newly minted project key to one living LiveKit agent. */
  bindMonitoringExportKey(
    agentId: string,
    projectId: string,
    apiKeyId: string,
  ):
    | { readonly kind: "bound"; readonly previous: string | null }
    | { readonly kind: "already-bound"; readonly apiKeyId: string }
    | undefined;
  /** Drop the active association when its project key is revoked. */
  unbindMonitoringExportKey(apiKeyId: string): void;
};

/**
 * A key minted for one project, asked to act in a different one.
 *
 * The verb is passed in because that is the only word that differs between the
 * read and the write — and two sentences kept in step by hand is how contract
 * wording drifts.
 */
function credentialActsElsewhere(
  scoped: string,
  named: string,
  verb: "writes into" | "reads",
): Refusal {
  return new Refusal(
    `this credential acts in project ${scoped}, and the request named ` +
      `${named}. A key minted for one product area ${verb} that one; drop ` +
      "projectId, or use a key for the whole organization.",
    { status: 403, code: "not_permitted" },
  );
}

/**
 * One connection, as the run endpoints need it: which agent it reaches, and
 * what egma would have to speak to conduct a simulation over it.
 */
export type ConnectionLookup = (connectionId: string) => {
  readonly id: string;
  readonly agentId: string;
  readonly agentPlatform: string | null;
  readonly connectionType: string;
  readonly accessVariant: string;
  readonly modality: string;
  readonly productLabel: string;
} | null;

export function agentRoutes(options: {
  /** Whether the key a request carries is one this instance minted. */
  readonly knowsKey: (key: string) => boolean;
  /**
   * The one project this key acts in.
   *
   * Handed in rather than minted here, so every group of this fixture agrees
   * about which project this is — a fixture whose halves each believed in a
   * different project could not say anything true about a request that named
   * one.
   */
  readonly projectId: string;
}): {
  readonly group: RouteGroup;
  readonly controls: AgentControls;
  /** How a run resolves the connection it will execute over. */
  readonly connectionById: ConnectionLookup;
  /**
   * The roster itself, for the monitoring group beside this one.
   *
   * Monitoring writes to agent rows — the binding, the sealed key, the switch
   * — so it is handed the same array this group answers reads from rather than
   * a copy. A second list would let a start-monitoring commit and an agent read
   * disagree about what this project holds.
   */
  readonly roster: readonly StoredAgent[];
} {
  const agents: StoredAgent[] = [];
  const connections: StoredConnection[] = [];
  const sealed: string[] = [];
  const projectsNamed: (string | null)[] = [];

  /** The project everything lands in, named or not. */
  const HOME_PROJECT = options.projectId;

  /**
   * The project a request named, checked against what this key may reach.
   *
   * One rule for reads and writes. A surface that refused a stranger's project
   * on a write and answered an empty list on a read has two rules, and the
   * empty list is the worse half: it reads as "you have no agents there"
   * rather than as "that is not yours to ask about".
   */
  const projectNamed = (
    named: string | undefined,
    verb: "writes into" | "reads",
  ): string => {
    if (named !== undefined && named !== HOME_PROJECT) {
      throw credentialActsElsewhere(HOME_PROJECT, named, verb);
    }
    return HOME_PROJECT;
  };

  const authorized = (headers: Record<string, string | undefined>): boolean => {
    const offered = (headers["authorization"] ?? "").replace(/^Bearer\s+/iu, "");
    return offered !== "" && options.knowsKey(offered);
  };

  const notAuthenticated: FixtureAnswer = { status: 401, body: NOT_AUTHENTICATED };

  /**
   * An agent nobody can see reads exactly like an agent nobody wrote. Existence
   * is never confirmed to somebody who could not have seen the thing anyway, so
   * another customer's id and a made-up one get the same sentence.
   */
  const noSuchAgent: FixtureAnswer = {
    status: 404,
    body: {
      error: "not_found",
      message:
        "no agent of yours has that id. Check the id, or list your agents with " +
        "GET /v1/agents.",
    },
  };

  const answering = (make: () => FixtureAnswer): FixtureAnswer => {
    try {
      return make();
    } catch (error) {
      if (error instanceof Refusal) {
        return { status: error.status, body: { error: error.code, message: error.message } };
      }
      throw error;
    }
  };

  /** The smallest free `<kind>-<n>` among an agent's living connections. */
  const freeConnectionName = (agentId: string, connectionType: string): string => {
    const taken = new Set(
      connections.filter((held) => held.agentId === agentId).map((held) => held.name),
    );
    for (let n = 1; ; n += 1) {
      const candidate = `${connectionType}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  /**
   * One connection payload's envelope, read the one way — inline on a
   * registration and standalone on an attach. Two dialects for one thing is how
   * a client comes to work on one path and fail on the other.
   *
   * Only the envelope: which keys exist at all. What a connection type's config holds and
   * which modalities it speaks belong to the registry, one step further in.
   */
  const connectionIn = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Refusal("a connection is an object, or is left out entirely");
    }
    const body = value as Record<string, unknown>;
    // Topology is not in the list on purpose: it is derived from the connection type, so a
    // supplied one is refused as the unknown key it is.
    refuseUnknownKeyIn(body, CONNECTION_KEYS, "a connection");
    return body;
  };

  /**
   * A connection payload the registry will take, checked whole.
   *
   * Pure: nothing here reads or writes anything, which is what lets it happen
   * before the outcome is decided. **Every path runs it, and runs all of it.**
   * A registration that turns out to be a reuse is held to exactly what a
   * registration that turns out to be a create is held to — otherwise a body
   * egma would refuse from a new customer would rotate a live credential for an
   * old one, and the same client would work on one machine and fail on the
   * next.
   *
   * The order is the registry's own and it is contract: the full technical
   * tuple, then config, credentials, and name.
   */
  const admitConnection = (input: Record<string, unknown>): Admitted => {
    const agentPlatform =
      input["agentPlatform"] === null
        ? null
        : typeof input["agentPlatform"] === "string"
          ? input["agentPlatform"]
          : "";
    const connectionType =
      typeof input["connectionType"] === "string"
        ? input["connectionType"]
        : "";
    const accessVariant =
      typeof input["accessVariant"] === "string" ? input["accessVariant"] : "";
    const descriptor = descriptorOf(connectionType);
    const modality = validModality(connectionType, input["modality"]);
    const productLabel = productLabelOf(
      agentPlatform,
      connectionType,
      accessVariant,
      modality,
    );
    if (
      agentPlatform === "retell" &&
      connectionType === "phone_number" &&
      accessVariant === "phone_number.public_e164" &&
      modality === "voice" &&
      input["agentPlatformSelection"] === undefined
    ) {
      throw new Refusal(
        "a Retell phone connection needs agentPlatformSelection so Egma can confirm the number still reaches the selected agent",
      );
    }
    const config = validConfig(connectionType, accessVariant, input["config"]);
    const credentials = validCredentials(
      connectionType,
      accessVariant,
      input["credentials"],
    );
    return {
      // A name sent blank is refused rather than dropped; absent is different
      // and means the smallest free numbered name.
      name: input["name"] === undefined ? undefined : validName(input["name"], "a connection"),
      agentPlatform,
      connectionType,
      accessVariant,
      modality,
      productLabel,
      topology: descriptor.topology,
      environment: typeof input["environment"] === "string" ? input["environment"] : null,
      config,
      credentials,
    };
  };

  const writeConnection = (agent: StoredAgent, input: Admitted): StoredConnection => {
    const { connectionType, modality, config, credentials } = input;
    const name = input.name ?? freeConnectionName(agent.id, connectionType);
    if (connections.some((held) => held.agentId === agent.id && held.name === name)) {
      throw new Refusal(`a connection named "${name}" already exists on this agent`, {
        status: 409,
        code: "name_taken",
      });
    }

    if (credentials !== null) sealed.push(...Object.values(credentials.sealed));

    const written: StoredConnection = {
      id: newId("con"),
      agentId: agent.id,
      projectId: agent.projectId,
      name,
      agentPlatform: input.agentPlatform ?? agent.agentPlatform,
      connectionType,
      accessVariant: input.accessVariant,
      modality,
      productLabel: input.productLabel,
      // Derived from the connection type, never caller-supplied.
      topology: input.topology,
      environment: input.environment,
      config,
      credentials: credentials === null ? null : credentials.sealed,
      credentialsHint: credentials === null ? null : credentials.hint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    connections.push(written);
    return written;
  };

  /**
   * The living connection in this project that is about the same vendor agent,
   * if there is one — the whole of what makes registering retry-safe.
   *
   * Oldest first, so a repeated registration chooses the same agent every
   * time.
   */
  const sameVendorAgent = (
    projectId: string,
    input: Admitted,
  ): readonly StoredConnection[] => {
    const { connectionType } = input;
    const reuseKey = REGISTRY[connectionType]?.reuseKey;
    if (reuseKey === undefined) return [];

    const named = input.config[reuseKey];
    if (named === undefined || named.trim() === "") return [];

    // Oldest first, so a repeated registration chooses the same agent every
    // time. The ids sort by mint time, so the order they were written in and
    // the order the real instance sorts them by are one thing.
    return connections.filter(
      (held) =>
        held.projectId === projectId &&
        held.agentPlatform === input.agentPlatform &&
        held.connectionType === connectionType &&
        held.accessVariant === input.accessVariant &&
        held.config[reuseKey] === named.trim(),
    );
  };

  const group: RouteGroup = {
    name: "agents",
    routes: [
      {
        // The same server-owned form catalog the real platform exposes.
        method: "GET",
        path: "/v1/connection-options",
        handle: (request) =>
          authorized(request.headers)
            ? { status: 200, body: { items: connectionOptionMetadata() } }
            : notAuthenticated,
      },
      {
        /**
         * Register an agent, with the first way of reaching it written in
         * the same request: an agent nothing can reach is not worth having, so
         * the happy path never produces one.
         *
         * Both rows or neither, and the reuse rule runs in the same breath:
         * a living connection about the same vendor agent decides the outcome.
         * A matching Retell Chat connection answers what is there with the
         * credential rotated whole; no match writes both. `result` says which.
         */
        method: "POST",
        path: "/v1/agents",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          return answering(() => {
            const body = request.body ?? {};

            // The order below is the route's, then the factory's, and it is
            // contract: the envelopes first, because they are answerable
            // without knowing anything; then which project this is; then the
            // agent's name and the whole connection payload. Only after all of
            // that does anything look at what is already there — so what egma
            // will take is decided before what egma will do is.
            refuseUnknownKeyIn(body, AGENT_KEYS, "a registration");
            const envelope =
              body["connection"] === undefined ? undefined : connectionIn(body["connection"]);

            // A write may name a project in its body. It never names one in
            // its address, and it never names an organization anywhere.
            const named = typeof body["projectId"] === "string" ? body["projectId"] : null;
            projectsNamed.push(named);
            const projectId = projectNamed(given(named), "writes into");

            const name = validName(body["name"], "an agent");
            // The agent's own platform binding: required on every
            // registration, and settable without a connection — an agent that
            // only pushes its production evidence belongs in the roster and
            // has nothing for Egma's simulator to dial.
            const boundTo = agentPlatformIn(body["agentPlatform"]);
            const inline = envelope === undefined ? undefined : admitConnection(envelope);

            if (inline !== undefined) {
              const living = sameVendorAgent(projectId, inline);
              const same = living.find((held) => held.modality === inline.modality);

              if (same !== undefined) {
                // Whole, never merged: what arrived replaces what is stored.
                // Nothing about the body is checked here, because all of it was
                // checked above — a registration egma would refuse never gets
                // as far as rotating a live credential.
                const { credentials } = inline;
                if (credentials !== null) sealed.push(...Object.values(credentials.sealed));
                same.credentials = credentials === null ? null : credentials.sealed;
                same.credentialsHint = credentials === null ? null : credentials.hint;
                same.updatedAt = new Date().toISOString();

                const owner = agents.find((held) => held.id === same.agentId) as StoredAgent;
                // No row was written, and saying 201 would be the protocol
                // claiming something the `result` field is there to deny.
                return {
                  status: 200,
                  body: {
                    result: "reused",
                    agent: agentOut(owner),
                    connection: connectionOut(same),
                  },
                };
              }

              const known = living[0];
              if (known !== undefined) {
                const owner = agents.find((held) => held.id === known.agentId) as StoredAgent;
                return {
                  status: 201,
                  body: {
                    result: "connection_added",
                    agent: agentOut(owner),
                    connection: connectionOut(writeConnection(owner, inline)),
                  },
                };
              }
            }

            if (agents.some((held) => held.projectId === projectId && held.name === name)) {
              throw new Refusal(`an agent named "${name}" already exists in this project`, {
                status: 409,
                code: "name_taken",
              });
            }

            // Both rows or neither: a connection payload the registry turns
            // away leaves no agent behind, so nothing is kept until both are.
            const agent: StoredAgent = blankAgent(projectId, name, boundTo);

            if (inline === undefined) {
              agents.push(agent);
              return { status: 201, body: { result: "created", agent: agentOut(agent) } };
            }

            const before = connections.length;
            let connection: StoredConnection;
            try {
              connection = writeConnection(agent, inline);
            } catch (error) {
              connections.length = before;
              throw error;
            }
            agents.push(agent);

            return {
              status: 201,
              body: {
                result: "created",
                agent: agentOut(agent),
                connection: connectionOut(connection),
              },
            };
          });
        },
      },
      {
        /**
         * One page of the agents this key can reach, newest first. A project is
         * a filter in the query and never a level in the address, and there is
         * no page-size parameter: a page is a page, and the cursor is what
         * carries a reader through the rest.
         */
        method: "GET",
        path: "/v1/agents",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          return answering(() => {
            const project = projectNamed(
              given(request.url.searchParams.get("projectId")),
              "reads",
            );
            const cursor = given(request.url.searchParams.get("pageToken"));
            if (cursor !== undefined && !isId("agt", cursor)) {
              throw new Refusal(
                `"${cursor}" is not an agent id, so it cannot be a cursor. Send ` +
                  "back the nextPageToken from the page before this one, or leave it " +
                  "out to start at the newest.",
              );
            }

            // Newest first, because the agent somebody is looking for is
            // usually the one they just registered. The ids sort by mint time,
            // so reversing what was written is the order the real instance
            // reads them in.
            const mine = agents.filter((agent) => agent.projectId === project).reverse();
            const from =
              cursor === undefined ? 0 : mine.findIndex((held) => held.id === cursor) + 1;
            const page = mine.slice(from, from + PAGE_SIZE);
            const more = mine.length > from + page.length;

            return {
              status: 200,
              body: {
                agents: page.map((agent) => ({
                  ...agentOut(agent),
                  connections: connections
                    .filter((connection) => connection.agentId === agent.id)
                    .map(connectionOut),
                })),
                nextPageToken: more ? (page.at(-1)?.id ?? null) : null,
              },
            };
          });
        },
      },
      {
        // The agent, and every living way of reaching it. A connection is only
        // ever reached through its agent.
        method: "GET",
        path: "/v1/agents/:agentId",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const agent = agents.find((held) => held.id === request.params["agentId"]);
          if (agent === undefined) return noSuchAgent;
          return {
            status: 200,
            body: {
              agent: agentOut(agent),
              connections: connections
                .filter((held) => held.agentId === agent.id)
                .map(connectionOut),
            },
          };
        },
      },
      {
        // Another way of reaching an agent that already exists. Same body,
        // and the same defaulted name one number further along.
        method: "POST",
        path: "/v1/agents/:agentId/connections",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const agent = agents.find((held) => held.id === request.params["agentId"]);
          if (agent === undefined) return noSuchAgent;
          return answering(() => ({
            status: 201,
            body: {
              connection: connectionOut(
                writeConnection(agent, admitConnection(connectionIn(request.body ?? {}))),
              ),
            },
          }));
        },
      },
    ],
  };

  const connectionById: ConnectionLookup = (connectionId) => {
    const held = connections.find((one) => one.id === connectionId);
    if (held === undefined) return null;
    return {
      id: held.id,
      agentId: held.agentId,
      agentPlatform: held.agentPlatform,
      connectionType: held.connectionType,
      accessVariant: held.accessVariant,
      modality: held.modality,
      productLabel: held.productLabel,
    };
  };

  return {
    group,
    controls: {
      agents,
      connections,
      sealed,
      projectsNamed,
      received(agentId, at = new Date()) {
        const held = agents.find((one) => one.id === agentId);
        if (held === undefined) return;
        held.lastReceivedAt = at.toISOString();
      },
      bindMonitoringExportKey(agentId, projectId, apiKeyId) {
        const held = agents.find(
          (one) =>
            one.id === agentId &&
            one.projectId === projectId &&
            one.agentPlatform === "livekit",
        );
        if (held === undefined) return undefined;
        const previous = held.monitoringExportApiKeyId;
        if (previous !== null) {
          return { kind: "already-bound", apiKeyId: previous };
        }
        held.monitoringExportApiKeyId = apiKeyId;
        return { kind: "bound", previous };
      },
      unbindMonitoringExportKey(apiKeyId) {
        const held = agents.find(
          (one) => one.monitoringExportApiKeyId === apiKeyId,
        );
        if (held !== undefined) held.monitoringExportApiKeyId = null;
      },
    },
    connectionById,
    roster: agents,
  };
}
