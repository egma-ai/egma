/**
 * The platform's own settings, as `egma self-host setup` reads and writes them.
 *
 * **The API is the only thing that seals, and this module is why that stays
 * true.** Every answer the interview collects leaves here as an ordinary
 * request to `/api/platform/settings`; nothing in this CLI encrypts anything,
 * holds an encryption key, or knows the shape of a sealed value. The platform
 * seals what it is sent, keeps a hint of it for display, and hands the plain
 * value to a simulator on the work order it claims — and none of those three
 * facts is this command's business.
 *
 * **What the platform holds is read from the platform**, rather than from any
 * file beside the deployment. That is the whole reversal this effort is: the
 * settings used to live in a file only this CLI read, so a platform started any
 * other way had none of them and nothing said so. Now the interview asks the
 * platform what it is missing and asks the operator for exactly that.
 *
 * **The words come from the platform and the manner of asking does not.** A
 * label — "the persona's model key" — is the platform's, so a setting renamed
 * there is renamed in the interview with nothing to keep in step. Whether a
 * value is read with the terminal's echo off is decided here, by the table
 * below, because how a secret is taken off a keyboard is this command's own
 * safety and must not depend on what a server said about it.
 */

import { PlatformUnreachableError, type Fetch } from "../platform/device-flow.ts";
import type { CarrierResult } from "./twilio.ts";

/** Where the settings of a whole deployment are read and written. */
export const PLATFORM_SETTINGS_PATH = "/api/platform/settings";

/** Which platform, and the key of the owner asking. */
export type PlatformSettingsAccess = {
  readonly url: string;
  readonly key: string;
};

/** One setting, as the platform describes it. Never a stored value. */
export type HeldSetting = {
  readonly name: string;
  /** The words a person calls it by, from the platform's own catalog. */
  readonly label: string;
  /** Whether the platform holds it at all. */
  readonly held: boolean;
  /** What may be shown of it: the value, or a secret's last characters. */
  readonly hint: string | null;
};

/**
 * The platform answered, and would not do it.
 *
 * Separate from not answering at all, because the two want different next moves
 * from whoever is holding the terminal: "start your platform" against "you are
 * signed in as somebody who may not do this". The platform's own sentence is
 * relayed word for word — it is written for exactly this moment and names both
 * ways a caller can meet the refusal.
 */
export class PlatformRefusedError extends Error {
  readonly status: number;

  constructor(status: number, said: string) {
    super(said);
    this.name = "PlatformRefusedError";
    this.status = status;
  }
}

/** This machine holds no key for the platform it is setting up. */
export class NotSignedInError extends Error {
  constructor(url: string) {
    super(
      `The egma self-host setup command writes every answer through this platform's own API, and this machine is not signed in to the Egma instance at ${url}. ` +
        `Run \`egma login --url ${url}\` first — an organization owner's key is what the settings door opens for — then run setup again. Nothing was asked and nothing was written.`,
    );
    this.name = "NotSignedInError";
  }
}

async function ask(
  access: PlatformSettingsAccess,
  method: "GET" | "PATCH",
  body: unknown,
  fetchImpl: Fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${access.url}${PLATFORM_SETTINGS_PATH}`, {
      method,
      headers: {
        authorization: `Bearer ${access.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(access.url, cause);
  }

  const answered = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const said = typeof answered.message === "string" ? answered.message : "";
    throw new PlatformRefusedError(
      response.status,
      said === ""
        ? `Egma at ${access.url} answered ${response.status} and said nothing about it, so ` +
          "there is nothing here to act on. Look at what that platform logged — " +
          "`docker compose logs api` in its workspace — and run setup again. Nothing was " +
          "written."
        : said,
    );
  }
  return answered;
}

function describedBy(answered: Record<string, unknown>): readonly HeldSetting[] {
  const listed = Array.isArray(answered.settings) ? answered.settings : [];
  return listed.flatMap((entry) => {
    const one = entry as { name?: unknown; label?: unknown; hint?: unknown };
    if (typeof one.name !== "string") return [];
    const hint = typeof one.hint === "string" ? one.hint : null;
    return [
      {
        name: one.name,
        label: typeof one.label === "string" ? one.label : one.name,
        // Held is the presence of a hint and never the truth of a value: the
        // platform answers a hint for every setting it holds, including one
        // whose value is a secret it will never send back.
        held: hint !== null,
        hint,
      },
    ];
  });
}

/** Every setting this platform knows about, and which of them it holds. */
export async function readSettings(
  access: PlatformSettingsAccess,
  fetchImpl: Fetch = fetch,
): Promise<readonly HeldSetting[]> {
  return describedBy(await ask(access, "GET", undefined, fetchImpl));
}

/** Settings written through the platform, which is the only thing that seals. */
export async function writeSettings(
  access: PlatformSettingsAccess,
  values: Readonly<Record<string, string>>,
  fetchImpl: Fetch = fetch,
): Promise<readonly HeldSetting[]> {
  return describedBy(await ask(access, "PATCH", values, fetchImpl));
}

/**
 * How one setting is supplied, for every setting the platform holds.
 *
 * **The interview's whole vocabulary, and the one thing in this CLI that has to
 * agree with the platform's catalog.** The catalog lives in the database
 * package, which this CLI deliberately does not depend on at run time — it is a
 * published npm package and must not carry a Postgres client — so the agreement
 * is held by a check rather than by an import. `self-host-setup-catalog.test.ts`
 * fails when the two drift: a setting added there and not here would be one the
 * interview never asks for, and a required one at that would leave an operator
 * who finished the whole documented setup still reading `setup required`.
 *
 * `asked` settings are typed or exported. `carrier` settings are not: they are
 * what the paperwork with a carrier produces — the trunk it created, the number
 * it attached, the SIP credential it minted — and asking somebody to type a
 * trunk hostname egma is about to be told by Twilio would be asking them to
 * copy a value out of a console for no reason.
 *
 * **Each `variable` is the name the platform seeds that same setting from.**
 * One word means one thing whichever of the two ways in an operator uses, so a
 * script that already exports these needs nothing new to drive the interview.
 *
 * **`suggested` is where the values this command used to hard-code now live.**
 * The command it replaced wrote `openai`, `livekit` and `silero` into a file
 * without ever saying so; here they are a default a person can see and
 * overtype, and what a run with nobody watching takes.
 */
export type SettingInput =
  | {
      readonly supply: "asked";
      /** The environment variable this answer may arrive in. */
      readonly variable: string;
      /** Read with the terminal's echo off, and never printed anywhere. */
      readonly secret: boolean;
      /** What the interview offers, or `null` where egma should not guess. */
      readonly suggested: string | null;
      /** Whether the platform is unconfigured without it. */
      readonly required: boolean;
    }
  | {
      readonly supply: "carrier";
      readonly required: boolean;
    };

export const SETUP_INPUTS = {
  persona_model_provider: {
    supply: "asked",
    variable: "EGMA_PERSONA_MODEL_PROVIDER",
    secret: false,
    suggested: "openai",
    required: true,
  },
  persona_model: {
    supply: "asked",
    variable: "EGMA_PERSONA_MODEL",
    secret: false,
    suggested: "gpt-5.6-terra",
    required: true,
  },
  persona_model_key: {
    supply: "asked",
    variable: "EGMA_PERSONA_MODEL_API_KEY",
    secret: true,
    suggested: null,
    required: true,
  },
  // The one model setting egma does suggest a value for, and it is not a
  // model name: it is how hard the persona thinks before it speaks. A
  // caller on a live line does not pause to reason — the reasoning under
  // test is the agent's — so the suggestion turns it off. The word is the
  // provider's own, and leaving the answer blank sends nothing at all,
  // which is what a model that has never heard of the field needs.
  persona_model_reasoning_effort: {
    supply: "asked",
    variable: "EGMA_PERSONA_MODEL_REASONING_EFFORT",
    secret: false,
    suggested: "none",
    required: false,
  },
  speech_to_text_provider: {
    supply: "asked",
    variable: "EGMA_PERSONA_STT_PROVIDER",
    secret: false,
    suggested: "openai_realtime",
    required: true,
  },
  speech_to_text_key: {
    supply: "asked",
    variable: "EGMA_PERSONA_STT_API_KEY",
    secret: true,
    suggested: null,
    required: true,
  },
  speech_to_text_model: {
    supply: "asked",
    variable: "EGMA_PERSONA_STT_MODEL",
    secret: false,
    suggested: null,
    required: false,
  },
  text_to_speech_provider: {
    supply: "asked",
    variable: "EGMA_PERSONA_TTS_PROVIDER",
    secret: false,
    suggested: "cartesia",
    required: true,
  },
  text_to_speech_key: {
    supply: "asked",
    variable: "EGMA_PERSONA_TTS_API_KEY",
    secret: true,
    suggested: null,
    required: true,
  },
  // No suggestion for any of the three model-and-voice settings — the two
  // below and the speech-to-text model above — deliberately. The simulator
  // has a working default for each, chosen per provider, so a platform that
  // never names one still speaks and still hears. A default egma invented
  // here would be a second opinion about the provider's own model names,
  // stored, and wrong the week one is retired — and stored is the worse half:
  // the simulator's default moves with a release, and a value written into
  // the platform on setup day stays until somebody edits it.
  text_to_speech_model: {
    supply: "asked",
    variable: "EGMA_PERSONA_TTS_MODEL",
    secret: false,
    suggested: null,
    required: false,
  },
  text_to_speech_voice: {
    supply: "asked",
    variable: "EGMA_PERSONA_TTS_VOICE",
    secret: false,
    suggested: null,
    required: false,
  },
  voice_activity_provider: {
    supply: "asked",
    variable: "EGMA_PERSONA_VAD_PROVIDER",
    secret: false,
    suggested: "silero",
    required: true,
  },
  media_backend: {
    supply: "asked",
    variable: "EGMA_MEDIA_BACKEND",
    secret: false,
    suggested: "livekit",
    required: true,
  },
  carrier_trunk_address: { supply: "carrier", required: true },
  carrier_trunk_number: { supply: "carrier", required: true },
  carrier_trunk_username: { supply: "carrier", required: false },
  carrier_trunk_password: { supply: "carrier", required: false },
} as const satisfies Readonly<Record<string, SettingInput>>;

/** The name of one setting this interview knows how to supply. */
export type SetupSettingName = keyof typeof SETUP_INPUTS;

/** How a setting is supplied, or `null` for one this CLI has never heard of. */
export function inputFor(name: string): SettingInput | null {
  return Object.hasOwn(SETUP_INPUTS, name)
    ? (SETUP_INPUTS[name as SetupSettingName] as SettingInput)
    : null;
}

/** Which of a finished carrier's facts are single values a setting can hold. */
type CarrierFact = {
  [K in keyof CarrierResult]: CarrierResult[K] extends string ? K : never;
}[keyof CarrierResult];

/**
 * What the carrier paperwork produces, and which setting each result fills.
 *
 * **This exists so that a `carrier` setting cannot be declared and then never
 * written.** The four assignments used to be typed out inside the setup command,
 * which meant the catalog could grow a fifth carrier setting, the interview
 * could agree that the carrier supplies it, every check could pass — and the
 * platform would report `setup required` for ever, because nothing assigned it.
 * The list is here instead, the command loops over it, and the catalog check
 * holds the two lists against each other in both directions.
 *
 * The value is a field of the carrier's own result rather than a free string,
 * so a field renamed in the carrier module stops the build here rather than
 * writing `undefined` into somebody's platform.
 */
export const FROM_THE_CARRIER = {
  carrier_trunk_address: "trunkAddress",
  carrier_trunk_number: "sourceNumber",
  carrier_trunk_username: "sipUsername",
  carrier_trunk_password: "sipPassword",
} as const satisfies Readonly<Record<string, CarrierFact>>;

/** Every setting the carrier step fills, with the fact that fills it. */
export function carrierAnswers(
  applied: CarrierResult,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(FROM_THE_CARRIER).map(([name, fact]) => [name, applied[fact]]),
  );
}
