import type {
  GetPersonaFormResponse,
  GetPersonaResponse,
  ListPersonasResponse,
  ListPersonaVersionsResponse,
} from "@egma/platform-api/client";

/**
 * Persona response types from the API. Projects can use Egma-provided or
 * Custom personas. name is editable metadata; identityName is versioned
 * behavior. The test scenario specifies what the persona wants to achieve.
 */

export type Persona = GetPersonaResponse;

export type PersonaModels = NonNullable<Persona["settings"]>["models"];
export type PersonaControls = NonNullable<Persona["settings"]>["controls"];
export type ModelSelection = PersonaModels["llm"];
export type PersonaPage = ListPersonasResponse;

/** One frozen version, as history and the older-version read show it. */
export type PersonaVersionPage = ListPersonaVersionsResponse;
export type PersonaVersion = PersonaVersionPage["versions"][number];

export type PersonaForm = GetPersonaFormResponse;
export type PersonaModelCatalogEntry = PersonaForm["modelCatalog"][number];

/**
 * Who they are, as an editor holds it before anybody decides whether it differs
 * from what is stored.
 *
 * These three are exactly the versioned half of a persona: changing any of them
 * mints a version, and changing the team name or the description mints nothing.
 * Keeping them in one shape is what lets one comparison answer "does saving
 * this make a new version?".
 */
export type BehaviorDraft = {
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
};

/** What a persona egma has not been told anything about starts as. */
export const BLANK_BEHAVIOR: BehaviorDraft = {
  identityName: "",
  personality: "",
  language: "en-US",
};

/** The stored behavior, as the editor holds it. A version reads the same way. */
export function behaviorDraftOf(stored: Omit<BehaviorDraft, "language"> & { readonly language: string | null }): BehaviorDraft {
  return {
    identityName: stored.identityName,
    personality: stored.personality,
    language: stored.language ?? "en-US",
  };
}

export function sameBehaviorDraft(
  left: BehaviorDraft,
  right: BehaviorDraft,
): boolean {
  return (Object.keys(left) as (keyof BehaviorDraft)[]).every(
    (key) => left[key] === right[key],
  );
}

/** What the model editor holds while a speed can still be half typed. */
export type ModelsDraft = {
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly voiceId: string;
  readonly speed: string;
  readonly language: string;
  readonly emotion: PersonaControls["emotion"];
  readonly accent: string;
  readonly speechVolume: string;
  readonly backgroundSoundId: PersonaControls["backgroundSoundId"];
  /** The exact stored gain, kept separate from its dB editor value. */
  readonly backgroundVolume: string;
  readonly backgroundVolumeDb: string;
};

export const BACKGROUND_SOUNDS: ReadonlyArray<{ readonly id: PersonaControls["backgroundSoundId"]; readonly label: string }> = [
  { id: "none", label: "None" },
  { id: "office-v1", label: "Office" },
  { id: "cafe-v1", label: "Café" },
  { id: "street-traffic-v1", label: "Street traffic" },
  { id: "crowd-talking-v1", label: "Crowd talking" },
  { id: "inside-car-v1", label: "Inside a car" },
  { id: "home-tv-v1", label: "Home with TV" },
  { id: "wind-v1", label: "Wind" },
  { id: "rain-v1", label: "Rain" },
];

export function gainToDecibels(gain: number): string {
  return String(Math.round(20 * Math.log10(gain) * 10) / 10);
}

export function decibelsToGain(decibels: string): string {
  const value = Number(decibels);
  return Number.isFinite(value) ? String(10 ** (value / 20)) : decibels;
}

export function modelsDraftOf(models: PersonaModels, controls?: PersonaControls): ModelsDraft {
  return {
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: models.stt.provider,
    sttModel: models.stt.model,
    ttsProvider: models.tts.provider,
    ttsModel: models.tts.model,
    voiceId: models.tts.voiceId,
    speed: String(models.tts.speed),
    language: controls?.language ?? "en-US",
    emotion: controls?.emotion ?? "neutral",
    accent: controls?.accent ?? "voice_default",
    speechVolume: String(controls?.speechVolume ?? 1),
    backgroundSoundId: controls?.backgroundSoundId ?? "none",
    backgroundVolume: String(controls?.backgroundVolume ?? 0.0631),
    backgroundVolumeDb: gainToDecibels(controls?.backgroundVolume ?? 0.0631),
  };
}

export function controlsFrom(draft: ModelsDraft): Omit<PersonaControls, "executionPolicyVersion"> {
  return {
    language: draft.language,
    emotion: draft.emotion,
    accent: draft.accent,
    speechVolume: Number(draft.speechVolume),
    backgroundSoundId: draft.backgroundSoundId,
    backgroundVolume: Number(draft.backgroundVolume),
  };
}

/** One complete models value, in the exact shape the API validates. */
export function modelsFrom(draft: ModelsDraft): PersonaModels {
  const speed = Number(draft.speed);
  const models = {
    llm: {
      provider: draft.llmProvider,
      model: draft.llmModel,
    },
    stt: { provider: draft.sttProvider, model: draft.sttModel },
    tts: {
      provider: draft.ttsProvider,
      model: draft.ttsModel,
      voiceId: draft.voiceId,
      // Preserve invalid text so the server can give the one authoritative
      // range refusal. JSON cannot carry NaN.
      speed: Number.isNaN(speed) ? draft.speed : speed,
    },
  };

  // The current API accepts invalid speed text so it can return its own range
  // refusal. The generated contract says this value is always a number. Keep
  // the existing request behavior until that contract mismatch is resolved.
  return models as unknown as PersonaModels;
}

export function sameModelsDraft(
  left: ModelsDraft,
  right: ModelsDraft,
): boolean {
  return (Object.keys(left) as (keyof ModelsDraft)[]).every(
    (key) => left[key] === right[key],
  );
}

/**
 * Encode a catalog provider/model pair as one select value. Both IDs must
 * exclude the separator for decoding to recover the pair.
 */
export const MODEL_PAIR_SEPARATOR = "::";

export function modelPairKey(selection: {
  readonly provider: string;
  readonly model: string;
}): string {
  return `${selection.provider}${MODEL_PAIR_SEPARATOR}${selection.model}`;
}

/** The catalog entry a pair key names, when the catalog still offers it. */
export function modelPairFrom(
  catalog: readonly PersonaModelCatalogEntry[],
  job: PersonaModelCatalogEntry["job"],
  key: string,
): PersonaModelCatalogEntry | undefined {
  return catalog.find(
    (entry) => entry.job === job && modelPairKey(entry) === key,
  );
}

/**
 * Use the catalog's provider label, falling back to its ID when the catalog
 * is unavailable or no longer offers that provider.
 */
export function modelSaid(
  catalog: readonly PersonaModelCatalogEntry[] | undefined,
  job: PersonaModelCatalogEntry["job"],
  selection: { readonly provider: string; readonly model: string },
): string {
  const entry = catalog?.find(
    (one) =>
      one.job === job &&
      one.provider === selection.provider &&
      one.model === selection.model,
  );
  return `${entry?.label ?? selection.provider} · ${selection.model}`;
}

/**
 * The persona's type, in the two words the product uses for it.
 *
 * **Predefined**, not "Egma-provided": personas and graders name an Egma-built
 * thing with one word, and Predefined is the word a customer arrives with.
 */
export function ownerSaid(owner: Persona["owner"]): string {
  return owner === "egma" ? "Predefined" : "Custom";
}

/** Library preview uses its declared defaults; an applied persona uses saved settings. */
export function modelsOfPersona(persona: Persona): PersonaModels {
  if (persona.settings !== null) return persona.settings.models;
  const values = Object.fromEntries(persona.parameterContract.map((field) => [field.key, field.defaultValue]));
  return {
    llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
    stt: { provider: String(values.stt_provider), model: String(values.stt_model) },
    tts: { provider: String(values.tts_provider), model: String(values.tts_model), voiceId: String(values.tts_voice_id), speed: Number(values.tts_speed) },
  };
}

export function controlsOfPersona(persona: Persona): Omit<PersonaControls, "executionPolicyVersion"> {
  if (persona.settings !== null) return persona.settings.controls;
  const values = Object.fromEntries(persona.parameterContract.map((field) => [field.key, field.defaultValue]));
  return {
    language: String(values.language ?? persona.language ?? "en-US"),
    emotion: String(values.emotion ?? "neutral") as PersonaControls["emotion"],
    accent: String(values.accent ?? "voice_default"),
    speechVolume: Number(values.speech_volume ?? 1),
    backgroundSoundId: (values.background_sound_id ?? "none") as PersonaControls["backgroundSoundId"],
    backgroundVolume: Number(values.background_volume ?? 0.0631),
  };
}
