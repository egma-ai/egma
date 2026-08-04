import {
  CONNECTION_TYPES,
  MODALITIES,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";

/**
 * What each connection type is made of. The registry is code, not a table,
 * because a table could claim types the code cannot run: an entry lands here
 * in the same commit as its adapter, following the `VOICE_PROVIDERS`
 * precedent.
 *
 * It drives everything the access layer decides about a connection at the
 * door — which modalities the type speaks, the topology it implies (derived,
 * never caller-supplied: it predicts who moves first when a simulation
 * starts, and a caller's guess would just be wrong), which config keys are
 * demanded and how each is checked, and whether a credential is required or
 * refused outright. Every failure is named at create, so a typo surfaces
 * immediately rather than at run time.
 *
 * The map is `Record<ConnectionType, …>`, so it cannot drift from the schema:
 * a type added to `CONNECTION_TYPES` refuses to build until it is described
 * here, and an entry describing a type the schema's CHECK would reject cannot
 * be written at all.
 */

/**
 * One config key's gate. Takes what the caller sent under `key` — absent
 * arrives as `undefined` — and answers the value as it will be stored, or
 * throws naming the key.
 */
type ConfigGate = (key: string, value: unknown) => string;

/**
 * Whether the customer hands over a secret for this type, and what it holds.
 *
 * Required and forbidden are the only two cases on purpose: a credential
 * supplied where none belongs is rejected rather than stored and silently
 * ignored, because a caller who sent one believes it matters.
 */
export type CredentialRule =
  | {
      readonly required: true;
      /** Exactly these keys, each a non-empty string. */
      readonly fields: readonly string[];
      /** The field whose last characters become the stored display hint. */
      readonly hintField: string;
    }
  | {
      readonly required: false;
      /** Why not, told to the caller who supplied one anyway. */
      readonly refusal: string;
    };

export type ConnectionDescriptor = {
  readonly modalities: readonly Modality[];
  readonly topology: Topology;
  readonly config: Readonly<Record<string, ConfigGate>>;
  readonly credentials: CredentialRule;
};

function nonEmptyString(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`the config's ${key} must be a non-empty string`);
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

function e164PhoneNumber(key: string, value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!E164.test(candidate)) {
    throw new Error(
      `the config's ${key} must be an E.164 phone number, which looks like ` +
        `+15551234567`,
    );
  }
  return candidate;
}

export const CONNECTION_REGISTRY: Readonly<
  Record<ConnectionType, ConnectionDescriptor>
> = {
  retell: {
    modalities: ["chat", "voice"],
    topology: "hosted-broker",
    config: { retellAgentId: nonEmptyString },
    credentials: { required: true, fields: ["apiKey"], hintField: "apiKey" },
  },
  phone: {
    modalities: ["voice"],
    topology: "egma-dials-in",
    config: { phoneNumber: e164PhoneNumber },
    credentials: {
      required: false,
      refusal:
        "a phone connection takes no credential: the customer supplies a " +
        "public number, and egma dials it with its own telephony " +
        "configuration",
    },
  },
};

/** The descriptor, or a refusal naming what egma actually supports. */
export function descriptorOf(type: string): ConnectionDescriptor {
  const descriptor = CONNECTION_REGISTRY[type as ConnectionType];
  if (descriptor === undefined) {
    throw new Error(
      `"${type}" is not a connection type egma knows; expected one of ` +
        CONNECTION_TYPES.join(", "),
    );
  }
  return descriptor;
}

/** The modality checked against the type's own list, so `phone` + `chat` dies here. */
export function validModality(type: ConnectionType, modality: string): Modality {
  const descriptor = descriptorOf(type);
  if (!descriptor.modalities.includes(modality as Modality)) {
    const speaks = descriptor.modalities.join(" or ");
    if (!MODALITIES.includes(modality as Modality)) {
      throw new Error(
        `"${modality}" is not a modality; a ${type} connection speaks ${speaks}`,
      );
    }
    throw new Error(
      `a ${type} connection speaks ${speaks}, and this one was asked for ${modality}`,
    );
  }
  return modality as Modality;
}

/**
 * The config as it will be stored: every demanded key present and checked,
 * every unknown key refused by name. Refusing unknowns is what turns a typo'd
 * key into an error at create rather than a demanded key "missing" at run
 * time.
 */
export function validConfig(
  type: ConnectionType,
  config: unknown,
): Record<string, string> {
  const gates = descriptorOf(type).config;
  const demanded = Object.keys(gates);

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(
      `a ${type} connection's config is an object holding ${demanded.join(", ")}`,
    );
  }

  for (const key of Object.keys(config)) {
    if (!(key in gates)) {
      throw new Error(
        `a ${type} connection's config has no key "${key}"; it holds ` +
          demanded.join(", "),
      );
    }
  }

  const stored: Record<string, string> = {};
  for (const [key, gate] of Object.entries(gates)) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      throw new Error(`a ${type} connection's config needs ${key}`);
    }
    stored[key] = gate(key, value);
  }
  return stored;
}

/**
 * The credentials as they will be sealed, plus the display hint — or null for
 * a type where the customer supplies no secret. A credential handed to such a
 * type is refused with the type's own reason, never stored and never silently
 * dropped.
 */
export function validCredentials(
  type: ConnectionType,
  credentials: unknown,
): { readonly sealed: Record<string, string>; readonly hint: string } | null {
  const rule = descriptorOf(type).credentials;

  if (!rule.required) {
    if (credentials !== undefined) throw new Error(rule.refusal);
    return null;
  }

  const shape = `{ ${rule.fields.join(", ")} }`;
  if (
    credentials === undefined ||
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    throw new Error(`a ${type} connection needs credentials shaped ${shape}`);
  }

  for (const key of Object.keys(credentials)) {
    if (!rule.fields.includes(key)) {
      throw new Error(
        `a ${type} connection's credentials have no key "${key}"; they are ` +
          `shaped ${shape}`,
      );
    }
  }

  const sealed: Record<string, string> = {};
  for (const field of rule.fields) {
    const value = (credentials as Record<string, unknown>)[field];
    // Stored trimmed, like every config gate: a key pasted with whitespace
    // would pass the checks, seal the padding, and fail at the provider with
    // nothing to say the stored value was the problem.
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "") {
      throw new Error(
        `a ${type} connection's credentials need ${field} to be a non-empty string`,
      );
    }
    // Real provider keys are tens of characters, so anything this short is a
    // paste gone wrong — and the stored last-4 hint must stay a hint, never
    // most of the secret it hints at.
    if (trimmed.length < SHORTEST_CREDENTIAL) {
      throw new Error(
        `a ${type} connection's credentials need ${field} to be at least ` +
          `${SHORTEST_CREDENTIAL} characters`,
      );
    }
    sealed[field] = trimmed;
  }

  return { sealed, hint: sealed[rule.hintField]?.slice(-4) ?? "" };
}
