import {
  CONNECTION_TYPES,
  MODALITIES,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { AgentWriteRefusedError } from "./errors.ts";

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
  /**
   * Whether the simulator holds an adapter for this type — whether egma can
   * actually conduct a conversation over it.
   *
   * A type can be registered before anything can run over it: a customer can
   * describe how to reach their agent while the adapter that reaches it is
   * still being written. So this is a fact about the shipped simulator, kept
   * here beside the rest of what the type is, and it is what refuses a run at
   * creation instead of leaving it queued forever for a conductor that does
   * not exist. It flips to `true` in the same commit as the adapter.
   */
  readonly simulatorAdapter: boolean;
  /**
   * Which config key holds the vendor's own name for the agent, for the types
   * that have one — and absent for the types that do not.
   *
   * This is the whole of a type's create-or-reuse rule. Registering the same
   * vendor agent twice must not mint a second egma agent, because a retry
   * after an uncertain network failure is the ordinary case and a duplicate
   * identity splits a team's results history in half. So a type that can say
   * "this is the same agent you already registered" names the key that says
   * it, and a type that cannot — a framework the customer runs themselves has
   * no vendor identifier at all — declares none and always creates.
   */
  readonly reuseKey?: string | undefined;
};

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

export const CONNECTION_REGISTRY: Readonly<
  Record<ConnectionType, ConnectionDescriptor>
> = {
  retell: {
    modalities: ["chat", "voice"],
    topology: "hosted-broker",
    config: { retellAgentId: nonEmptyString },
    credentials: { required: true, fields: ["apiKey"], hintField: "apiKey" },
    // The provider's own agent id: the first vendor to carry a reuse rule.
    reuseKey: "retellAgentId",
    simulatorAdapter: true,
  },
  phone: {
    modalities: ["voice"],
    topology: "egma-dials-in",
    config: { phoneNumber: e164PhoneNumber },
    // Nothing dials yet: a customer may register the number they want called,
    // and a run over it is refused at creation until the adapter lands.
    simulatorAdapter: false,
    // No reuse rule, deliberately: a number is where egma dials, not who
    // answers, and two agents can legitimately share one. Registering the
    // same number twice creates twice, and the name check is what stops a
    // duplicate that was a mistake.
    credentials: {
      required: false,
      refusal:
        "a phone connection takes no credential: the customer supplies a " +
        "public number, and egma dials it with its own telephony " +
        "configuration",
    },
  },
};

/** The types something can actually conduct a run over today. */
export function conductableConnectionTypes(): readonly ConnectionType[] {
  return CONNECTION_TYPES.filter(
    (type) => CONNECTION_REGISTRY[type].simulatorAdapter,
  );
}

/**
 * What a run over a type nothing can conduct is told.
 *
 * The wording is the platform's own and a client relays it word for word to
 * whoever is reading a terminal, so it says all of it in one place: what is
 * missing, why egma would rather refuse now than queue something forever, and
 * the move that works today. The list of types comes off the registry rather
 * than out of the sentence, so it can never name an adapter that has not
 * shipped or miss one that has.
 */
export function noSimulatorAdapterMessage(type: string): string {
  return (
    `egma has no simulator adapter for a ${type} connection yet, ` +
    `so it will not start a run it cannot conduct. Run these tests over a ` +
    `connection egma conducts today: ${conductableConnectionTypes().join(", ")}.`
  );
}

/** The descriptor, or a refusal naming what egma actually supports. */
export function descriptorOf(type: string): ConnectionDescriptor {
  const descriptor = CONNECTION_REGISTRY[type as ConnectionType];
  if (descriptor === undefined) {
    throw new AgentWriteRefusedError(
      "not_admitted",
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
      throw new AgentWriteRefusedError(
        "not_admitted",
        `"${modality}" is not a modality; a ${type} connection speaks ${speaks}`,
      );
    }
    throw new AgentWriteRefusedError(
      "not_admitted",
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
    throw new AgentWriteRefusedError(
      "not_admitted",
      `a ${type} connection's config is an object holding ${demanded.join(", ")}`,
    );
  }

  for (const key of Object.keys(config)) {
    if (!(key in gates)) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `a ${type} connection's config has no key "${key}"; it holds ` +
          demanded.join(", "),
      );
    }
  }

  const stored: Record<string, string> = {};
  for (const [key, gate] of Object.entries(gates)) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `a ${type} connection's config needs ${key}`,
      );
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
    if (credentials !== undefined) {
      throw new AgentWriteRefusedError("not_admitted", rule.refusal);
    }
    return null;
  }

  const shape = `{ ${rule.fields.join(", ")} }`;
  if (
    credentials === undefined ||
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `a ${type} connection needs credentials shaped ${shape}`,
    );
  }

  for (const key of Object.keys(credentials)) {
    if (!rule.fields.includes(key)) {
      throw new AgentWriteRefusedError(
        "not_admitted",
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
      throw new AgentWriteRefusedError(
        "not_admitted",
        `a ${type} connection's credentials need ${field} to be a non-empty string`,
      );
    }
    // Real provider keys are tens of characters, so anything this short is a
    // paste gone wrong — and the stored last-4 hint must stay a hint, never
    // most of the secret it hints at.
    if (trimmed.length < SHORTEST_CREDENTIAL) {
      throw new AgentWriteRefusedError(
        "not_admitted",
        `a ${type} connection's credentials need ${field} to be at least ` +
          `${SHORTEST_CREDENTIAL} characters`,
      );
    }
    sealed[field] = trimmed;
  }

  return { sealed, hint: sealed[rule.hintField]?.slice(-4) ?? "" };
}
