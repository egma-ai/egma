import {
  defaultGraderParameterValues,
  validateGraderParameterContract,
  validateGraderParameterValues,
  type GraderParameter,
  type GraderParameterValues,
} from "../grader-library/parameters.ts";
import { RECOMMENDED_PERSONA_MODELS, validPersonaModels, type PersonaModels } from "../models/selections.ts";
import type { ModelProvider } from "../models/catalog.ts";

export const PERSONA_EMOTIONS = ["neutral", "happy", "angry", "frustrated", "sad", "anxious"] as const;
export type PersonaEmotion = (typeof PERSONA_EMOTIONS)[number];
export const SPEECH_VOLUME_RANGE = { quietest: 0.5, loudest: 1.5 } as const;
export const BACKGROUND_SOUND_IDS = [
  "none",
  "office-v1",
  "cafe-v1",
  "street-traffic-v1",
  "crowd-talking-v1",
  "inside-car-v1",
  "home-tv-v1",
  "wind-v1",
  "rain-v1",
] as const;
export type BackgroundSoundId = (typeof BACKGROUND_SOUND_IDS)[number];
export const BACKGROUND_VOLUME_DEFAULT = 0.0631;
export const BACKGROUND_VOLUME_RANGE = {
  quietest: 0.015848931924611134,
  loudest: 0.251188643150958,
} as const;
export const PERSONA_EXECUTION_POLICY_VERSION = 1 as const;
const LEGACY_SPEED_RANGE = { slowest: 0.6, fastest: 1.5 } as const;

export type PersonaControls = {
  readonly language: string;
  readonly emotion: PersonaEmotion;
  readonly accent: string;
  readonly speechVolume: number;
  readonly executionPolicyVersion: number;
  readonly backgroundSoundId: BackgroundSoundId;
  readonly backgroundVolume: number;
};
export type PersonaSettings = PersonaControls & { readonly models: PersonaModels };
export type PersonaParameterValues = GraderParameterValues;

function modelParameterValues(models: PersonaModels): PersonaParameterValues {
  const checked = validPersonaModels(models);
  return {
    llm_provider: checked.llm.provider, llm_model: checked.llm.model,
    stt_provider: checked.stt.provider, stt_model: checked.stt.model,
    tts_provider: checked.tts.provider, tts_model: checked.tts.model,
    tts_voice_id: checked.tts.voiceId, tts_speed: checked.tts.speed,
  };
}

/** The exact historical eight-field contract. Never add fields here. */
export function legacyPersonaParameterContract(models: PersonaModels = RECOMMENDED_PERSONA_MODELS): readonly GraderParameter[] {
  const defaults = modelParameterValues(models);
  const labels: Readonly<Record<string, string>> = {
    llm_provider: "Language model provider", llm_model: "Language model",
    stt_provider: "Speech recognition provider", stt_model: "Speech recognition model",
    tts_provider: "Speech generation provider", tts_model: "Speech generation model",
    tts_voice_id: "Voice ID", tts_speed: "Speaking speed",
  };
  return Object.entries(defaults).map(([key, value]) => ({
    key, label: labels[key] ?? key,
    valueType: key === "tts_speed" ? "number" : "string",
    defaultValue: value as string | number, unit: null,
    minimum: key === "tts_speed" ? LEGACY_SPEED_RANGE.slowest : null,
    maximum: key === "tts_speed" ? LEGACY_SPEED_RANGE.fastest : null,
  }));
}

export function validPersonaControls(value: unknown): PersonaControls {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("persona controls must be an object");
  const held = value as Record<string, unknown>;
  const language = typeof held.language === "string" ? held.language.trim() : "";
  const accent = typeof held.accent === "string" ? held.accent.trim() : "";
  if (language === "") throw new TypeError("persona language must be nonempty text");
  if (!PERSONA_EMOTIONS.includes(held.emotion as PersonaEmotion)) throw new TypeError("persona emotion is not supported");
  if (accent === "") throw new TypeError("persona accent must be nonempty text");
  if (typeof held.speechVolume !== "number" || !Number.isFinite(held.speechVolume) || held.speechVolume < SPEECH_VOLUME_RANGE.quietest || held.speechVolume > SPEECH_VOLUME_RANGE.loudest) throw new TypeError("persona speech volume must be between 0.5 and 1.5");
  if (typeof held.executionPolicyVersion !== "number" || !Number.isInteger(held.executionPolicyVersion) || held.executionPolicyVersion < 1) throw new TypeError("persona execution policy version must be a positive integer");
  if (!BACKGROUND_SOUND_IDS.includes(held.backgroundSoundId as BackgroundSoundId)) throw new TypeError("persona background sound is not supported");
  if (typeof held.backgroundVolume !== "number" || !Number.isFinite(held.backgroundVolume) || held.backgroundVolume < BACKGROUND_VOLUME_RANGE.quietest || held.backgroundVolume > BACKGROUND_VOLUME_RANGE.loudest) throw new TypeError("persona background volume must be between -36 dB and -12 dB");
  return { language, emotion: held.emotion as PersonaEmotion, accent, speechVolume: held.speechVolume, executionPolicyVersion: held.executionPolicyVersion, backgroundSoundId: held.backgroundSoundId as BackgroundSoundId, backgroundVolume: held.backgroundVolume };
}

export function personaParametersOfSettings(settings: PersonaSettings): PersonaParameterValues {
  const controls = validPersonaControls(settings);
  return {
    ...modelParameterValues(settings.models), language: controls.language,
    emotion: controls.emotion, accent: controls.accent,
    speech_volume: controls.speechVolume,
    execution_policy_version: controls.executionPolicyVersion,
    background_sound_id: controls.backgroundSoundId,
    background_volume: controls.backgroundVolume,
  };
}

/** Complete defaults for callers that only choose models. */
export function personaParametersOfModels(models: PersonaModels): PersonaParameterValues {
  return personaParametersOfSettings({
    models,
    language: "en-US",
    emotion: "neutral",
    accent: "voice_default",
    speechVolume: 1,
    executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION,
    backgroundSoundId: "none",
    backgroundVolume: BACKGROUND_VOLUME_DEFAULT,
  });
}

export function personaModelsOfParameters(values: PersonaParameterValues): PersonaModels {
  return validPersonaModels({
    llm: { provider: values.llm_provider, model: values.llm_model },
    stt: { provider: values.stt_provider, model: values.stt_model },
    tts: { provider: values.tts_provider, model: values.tts_model, voiceId: values.tts_voice_id, speed: values.tts_speed },
  });
}

export function personaControlsOfParameters(values: PersonaParameterValues): PersonaControls {
  return validPersonaControls({ language: values.language, emotion: values.emotion, accent: values.accent, speechVolume: values.speech_volume, executionPolicyVersion: values.execution_policy_version, backgroundSoundId: values.background_sound_id, backgroundVolume: values.background_volume });
}

export function personaSettingsOfParameters(values: PersonaParameterValues): PersonaSettings {
  return { models: personaModelsOfParameters(values), ...personaControlsOfParameters(values) };
}

export function speechProvidersOfParameters(contract: unknown, values: unknown): readonly ModelProvider[] {
  const models = personaModelsOfParameters(validatePersonaParameterValues(contract, values));
  return [...new Set([models.stt.provider, models.tts.provider])];
}

export function ticket01PersonaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls: Omit<PersonaControls, "backgroundSoundId" | "backgroundVolume"> = { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION },
): readonly GraderParameter[] {
  const checked = validPersonaControls({ ...controls, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT });
  const modelFields = legacyPersonaParameterContract(models).map((field) =>
    field.key === "tts_speed"
      ? { ...field, minimum: 0.25, maximum: 4 }
      : field
  );
  return [
    ...modelFields,
    { key: "language", label: "Language", valueType: "string", defaultValue: checked.language, unit: null, minimum: null, maximum: null },
    { key: "emotion", label: "Emotion", valueType: "string", defaultValue: checked.emotion, unit: null, minimum: null, maximum: null },
    { key: "accent", label: "Accent", valueType: "string", defaultValue: checked.accent, unit: null, minimum: null, maximum: null },
    { key: "speech_volume", label: "Speech volume", valueType: "number", defaultValue: checked.speechVolume, unit: null, minimum: SPEECH_VOLUME_RANGE.quietest, maximum: SPEECH_VOLUME_RANGE.loudest },
    { key: "execution_policy_version", label: "Execution policy version", valueType: "integer", defaultValue: checked.executionPolicyVersion, unit: null, minimum: 1, maximum: 1 },
  ];
}

export function personaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls: PersonaControls = { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT },
): readonly GraderParameter[] {
  const checked = validPersonaControls(controls);
  return [
    ...ticket01PersonaParameterContract(models, checked),
    { key: "background_sound_id", label: "Background sound", valueType: "string", defaultValue: checked.backgroundSoundId, unit: null, minimum: null, maximum: null },
    { key: "background_volume", label: "Background volume", valueType: "number", defaultValue: checked.backgroundVolume, unit: "linear_gain", minimum: BACKGROUND_VOLUME_RANGE.quietest, maximum: BACKGROUND_VOLUME_RANGE.loudest },
  ];
}

export const PERSONA_PARAMETER_CONTRACT = personaParameterContract();
const LEGACY_PERSONA_PARAMETER_CONTRACT = legacyPersonaParameterContract();
const TICKET_01_PERSONA_PARAMETER_CONTRACT = ticket01PersonaParameterContract();

export function validatePersonaParameterContract(value: unknown): readonly GraderParameter[] {
  const contract = validateGraderParameterContract(value);
  const fields = new Map(contract.map((field) => [field.key, field]));
  const declares = (required: readonly GraderParameter[]) =>
    contract.length === required.length &&
    required.every(
      (field) => fields.get(field.key)?.valueType === field.valueType,
    );
  const isLegacy = declares(LEGACY_PERSONA_PARAMETER_CONTRACT);
  const isTicket01 = declares(TICKET_01_PERSONA_PARAMETER_CONTRACT);
  const isCurrent = declares(PERSONA_PARAMETER_CONTRACT);
  if (!isLegacy && !isTicket01 && !isCurrent) throw new TypeError("persona parameter contract must declare one complete supported settings version");
  const defaults = defaultGraderParameterValues(contract);
  for (const key of ["llm_provider", "llm_model", "stt_provider", "stt_model", "tts_provider", "tts_model", "tts_voice_id"] as const) {
    if (typeof defaults[key] !== "string" || defaults[key].trim() === "") {
      throw new TypeError(`persona parameter ${key} must default to nonempty text`);
    }
  }
  if (isTicket01) validPersonaControls({ language: defaults.language, emotion: defaults.emotion, accent: defaults.accent, speechVolume: defaults.speech_volume, executionPolicyVersion: defaults.execution_policy_version, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT });
  if (isCurrent) personaControlsOfParameters(defaults);
  return contract;
}

export function validatePersonaParameterValues(contract: unknown, values: unknown): PersonaParameterValues {
  const checkedContract = validatePersonaParameterContract(contract);
  const checked = validateGraderParameterValues(checkedContract, values);
  for (const key of ["llm_provider", "llm_model", "stt_provider", "stt_model", "tts_provider", "tts_model", "tts_voice_id"] as const) {
    if (typeof checked[key] !== "string" || checked[key].trim() === "") {
      throw new TypeError(`persona parameter ${key} must be nonempty text`);
    }
  }
  if (checkedContract.some((field) => field.key === "background_sound_id")) personaControlsOfParameters(checked);
  else if (checkedContract.some((field) => field.key === "language")) validPersonaControls({ language: checked.language, emotion: checked.emotion, accent: checked.accent, speechVolume: checked.speech_volume, executionPolicyVersion: checked.execution_policy_version, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT });
  return checked;
}

export function defaultPersonaParameterValues(contract: unknown): PersonaParameterValues {
  const checked = validatePersonaParameterContract(contract);
  return validatePersonaParameterValues(checked, defaultGraderParameterValues(checked));
}
