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
export const PERSONA_INTERRUPTION_LEVELS = ["none", "occasional", "frequent"] as const;
export type PersonaInterruptionLevel = (typeof PERSONA_INTERRUPTION_LEVELS)[number];
export const PERSONA_SPEECH_SPEEDS = ["slow", "normal", "fast"] as const;
export type PersonaSpeechSpeed = (typeof PERSONA_SPEECH_SPEEDS)[number];
export const PERSONA_SPEECH_SPEED_TARGETS = { slow: 0.8, normal: 1, fast: 1.5 } as const;
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
export const PERSONA_EXECUTION_POLICY_VERSION = 2 as const;
const LEGACY_SPEED_RANGE = { slowest: 0.6, fastest: 1.5 } as const;

export type PersonaControls = {
  readonly language: string;
  readonly emotion: PersonaEmotion;
  readonly accent: string;
  readonly speechVolume: number;
  readonly executionPolicyVersion: number;
  readonly backgroundSoundId: BackgroundSoundId;
  readonly backgroundVolume: number;
  readonly interruptionLevel: PersonaInterruptionLevel;
  readonly speechSpeed: PersonaSpeechSpeed;
};
export type PersonaSettings = PersonaControls & { readonly models: PersonaModels };
export type PersonaParameterValues = GraderParameterValues;

function structuralPersonaModels(value: unknown): PersonaModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("persona models must be an object");
  const held = value as Record<string, unknown>;
  const selection = (job: "llm" | "stt") => {
    const value = held[job];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`persona ${job} selection must be an object`);
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.provider !== "string" || fields.provider.trim() === "" || typeof fields.model !== "string" || fields.model.trim() === "") throw new TypeError(`persona ${job} selection needs a provider and model`);
    return { provider: fields.provider.trim() as ModelProvider, model: fields.model.trim() };
  };
  const mode = held.mode ?? "separate";
  if (mode === "live") {
    const liveValue = held.live;
    if (Object.keys(held).length !== 3 || typeof liveValue !== "object" || liveValue === null || Array.isArray(liveValue)) throw new TypeError("persona live selection must be an object");
    const live = liveValue as Record<string, unknown>;
    if (Object.keys(live).length !== 4 || live.provider !== "openai" || live.model !== "gpt-live-1" || live.adapter !== "openai_live" || typeof live.voiceId !== "string" || live.voiceId.trim() === "") throw new TypeError("persona live selection is invalid");
    return { mode: "live", llm: selection("llm"), live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: live.voiceId.trim() } };
  }
  const ttsValue = held.tts;
  if ((Object.keys(held).length !== 3 && Object.keys(held).length !== 4) || typeof ttsValue !== "object" || ttsValue === null || Array.isArray(ttsValue)) throw new TypeError("persona tts selection must be an object");
  const fields = ttsValue as Record<string, unknown>;
  if (Object.keys(fields).length !== 4 || typeof fields.provider !== "string" || fields.provider.trim() === "" || typeof fields.model !== "string" || fields.model.trim() === "" || typeof fields.voiceId !== "string" || fields.voiceId.trim() === "" || typeof fields.speed !== "number" || !Number.isFinite(fields.speed)) throw new TypeError("persona tts selection needs a provider, model, voice id, and finite speed");
  return {
    mode: "separate",
    llm: selection("llm"),
    stt: selection("stt"),
    tts: { provider: fields.provider.trim() as ModelProvider, model: fields.model.trim(), voiceId: fields.voiceId.trim(), speed: fields.speed },
  };
}

function modelParameterValues(models: PersonaModels, checkCurrentCatalog = true): PersonaParameterValues {
  const checked = checkCurrentCatalog ? validPersonaModels(models) : structuralPersonaModels(models);
  if (checked.mode === "live") return {
    speech_mode: "live",
    llm_provider: checked.llm.provider, llm_model: checked.llm.model,
    live_provider: checked.live.provider, live_model: checked.live.model,
    live_adapter: checked.live.adapter, live_voice_id: checked.live.voiceId,
  };
  return {
    ...(checkCurrentCatalog ? { speech_mode: "separate" } : {}),
    llm_provider: checked.llm.provider, llm_model: checked.llm.model,
    stt_provider: checked.stt.provider, stt_model: checked.stt.model,
    tts_provider: checked.tts.provider, tts_model: checked.tts.model,
    tts_voice_id: checked.tts.voiceId, tts_speed: checked.tts.speed,
  };
}

/** The eight model fields, for merging a model-only edit without resetting controls. */
export function personaModelParameterValues(models: PersonaModels): PersonaParameterValues {
  return modelParameterValues(models);
}

/** The exact historical eight-field contract. Never add fields here. */
export function legacyPersonaParameterContract(models: PersonaModels = RECOMMENDED_PERSONA_MODELS): readonly GraderParameter[] {
  const defaults = modelParameterValues(models, false);
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
  if (!PERSONA_INTERRUPTION_LEVELS.includes(held.interruptionLevel as PersonaInterruptionLevel)) throw new TypeError("persona interruption level is not supported");
  if (!PERSONA_SPEECH_SPEEDS.includes(held.speechSpeed as PersonaSpeechSpeed)) throw new TypeError("persona speech speed is not supported");
  return { language, emotion: held.emotion as PersonaEmotion, accent, speechVolume: held.speechVolume, executionPolicyVersion: held.executionPolicyVersion, backgroundSoundId: held.backgroundSoundId as BackgroundSoundId, backgroundVolume: held.backgroundVolume, interruptionLevel: held.interruptionLevel as PersonaInterruptionLevel, speechSpeed: held.speechSpeed as PersonaSpeechSpeed };
}

/** Convert historical numeric rates to the nearest authored choice. Ties prefer Normal. */
export function personaSpeechSpeedOfTarget(target: number): PersonaSpeechSpeed {
  if (!Number.isFinite(target)) throw new TypeError("persona speech speed target must be finite");
  const ranked = PERSONA_SPEECH_SPEEDS.map((speed) => ({ speed, distance: Math.abs(target - PERSONA_SPEECH_SPEED_TARGETS[speed]) }));
  ranked.sort((left, right) => left.distance - right.distance || (left.speed === "normal" ? -1 : right.speed === "normal" ? 1 : 0));
  return ranked[0]!.speed;
}

export function personaParametersOfSettings(settings: PersonaSettings): PersonaParameterValues {
  const controls = validPersonaControls({ ...settings, executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION });
  return {
    ...modelParameterValues(settings.models), language: controls.language,
    emotion: controls.emotion, accent: controls.accent,
    speech_volume: controls.speechVolume,
    execution_policy_version: controls.executionPolicyVersion,
    background_sound_id: controls.backgroundSoundId,
    background_volume: controls.backgroundVolume,
    interruption_level: controls.interruptionLevel,
    speech_speed: controls.speechSpeed,
    tts_speed: PERSONA_SPEECH_SPEED_TARGETS[controls.speechSpeed],
  };
}

/** Complete defaults for callers that only choose models. */
export function personaParametersOfModels(models: PersonaModels): PersonaParameterValues {
  const speechSpeed = models.mode === "separate" ? personaSpeechSpeedOfTarget(models.tts.speed) : "normal";
  return personaParametersOfSettings({
    models,
    language: "en-US",
    emotion: "neutral",
    accent: "voice_default",
    speechVolume: 1,
    executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION,
    backgroundSoundId: "none",
    backgroundVolume: BACKGROUND_VOLUME_DEFAULT,
    interruptionLevel: "none",
    speechSpeed,
  });
}

export function personaModelsOfParameters(values: PersonaParameterValues): PersonaModels {
  if (values.speech_mode === "live") return structuralPersonaModels({
    mode: "live",
    llm: { provider: values.llm_provider, model: values.llm_model },
    live: { provider: values.live_provider, model: values.live_model, adapter: values.live_adapter, voiceId: values.live_voice_id },
  });
  return structuralPersonaModels({
    mode: "separate",
    llm: { provider: values.llm_provider, model: values.llm_model },
    stt: { provider: values.stt_provider, model: values.stt_model },
    tts: { provider: values.tts_provider, model: values.tts_model, voiceId: values.tts_voice_id, speed: values.tts_speed },
  });
}

export function personaControlsOfParameters(values: PersonaParameterValues): PersonaControls {
  return validPersonaControls({ language: values.language, emotion: values.emotion, accent: values.accent, speechVolume: values.speech_volume, executionPolicyVersion: values.execution_policy_version, backgroundSoundId: values.background_sound_id ?? "none", backgroundVolume: values.background_volume ?? BACKGROUND_VOLUME_DEFAULT, interruptionLevel: values.interruption_level === "off" || values.interruption_level === undefined ? "none" : values.interruption_level, speechSpeed: values.speech_speed ?? personaSpeechSpeedOfTarget(Number(values.tts_speed)) });
}

export function personaSettingsOfParameters(values: PersonaParameterValues): PersonaSettings {
  return { models: personaModelsOfParameters(values), ...personaControlsOfParameters(values) };
}

export function speechProvidersOfParameters(contract: unknown, values: unknown): readonly ModelProvider[] {
  const models = personaModelsOfParameters(validatePersonaParameterValues(contract, values));
  return models.mode === "live" ? [models.live.provider] : [...new Set([models.stt.provider, models.tts.provider])];
}

export function ticket01PersonaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls: Omit<PersonaControls, "backgroundSoundId" | "backgroundVolume" | "interruptionLevel" | "speechSpeed"> = { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1 },
): readonly GraderParameter[] {
  const checked = validPersonaControls({ ...controls, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT, interruptionLevel: "none", speechSpeed: "normal" });
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

/** The exact ticket 02 fifteen-field contract. Never add fields here. */
export function ticket02PersonaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls: Omit<PersonaControls, "interruptionLevel" | "speechSpeed"> = { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT },
): readonly GraderParameter[] {
  const checked = validPersonaControls({ ...controls, interruptionLevel: "none", speechSpeed: "normal" });
  return [
    ...ticket01PersonaParameterContract(models, checked),
    { key: "background_sound_id", label: "Background sound", valueType: "string", defaultValue: checked.backgroundSoundId, unit: null, minimum: null, maximum: null },
    { key: "background_volume", label: "Background volume", valueType: "number", defaultValue: checked.backgroundVolume, unit: "linear_gain", minimum: BACKGROUND_VOLUME_RANGE.quietest, maximum: BACKGROUND_VOLUME_RANGE.loudest },
  ];
}

export function personaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls?: PersonaControls,
): readonly GraderParameter[] {
  const currentModels = validPersonaModels(models);
  const selectedControls = controls ?? { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT, interruptionLevel: "none", speechSpeed: currentModels.mode === "separate" ? personaSpeechSpeedOfTarget(currentModels.tts.speed) : "normal" };
  const checked = validPersonaControls({ ...selectedControls, executionPolicyVersion: PERSONA_EXECUTION_POLICY_VERSION });
  const resolvedModels: PersonaModels = currentModels.mode === "separate" ? { ...currentModels, tts: { ...currentModels.tts, speed: PERSONA_SPEECH_SPEED_TARGETS[checked.speechSpeed] } } : currentModels;
  const modelFields = modelParameterValues(resolvedModels);
  const modelLabels: Readonly<Record<string, string>> = {
    speech_mode: "Speech mode", llm_provider: "Language model provider", llm_model: "Language model",
    stt_provider: "Speech recognition provider", stt_model: "Speech recognition model", tts_provider: "Speech generation provider",
    tts_model: "Speech generation model", tts_voice_id: "Voice ID", tts_speed: "Resolved speaking speed",
    live_provider: "Live speech provider", live_model: "Live speech model", live_adapter: "Live speech adapter", live_voice_id: "Live voice ID",
  };
  return [
    ...Object.entries(modelFields).map(([key, value]) => ({ key, label: modelLabels[key] ?? key, valueType: key === "tts_speed" ? "number" as const : "string" as const, defaultValue: value as string | number, unit: null, minimum: null, maximum: null })),
    ...(resolvedModels.mode === "live" ? [{ key: "tts_speed", label: "Resolved speaking speed", valueType: "number" as const, defaultValue: PERSONA_SPEECH_SPEED_TARGETS[checked.speechSpeed], unit: null, minimum: null, maximum: null }] : []),
    { key: "language", label: "Language", valueType: "string", defaultValue: checked.language, unit: null, minimum: null, maximum: null },
    { key: "emotion", label: "Emotion", valueType: "string", defaultValue: checked.emotion, unit: null, minimum: null, maximum: null },
    { key: "accent", label: "Accent", valueType: "string", defaultValue: checked.accent, unit: null, minimum: null, maximum: null },
    { key: "speech_volume", label: "Speech volume", valueType: "number", defaultValue: checked.speechVolume, unit: null, minimum: SPEECH_VOLUME_RANGE.quietest, maximum: SPEECH_VOLUME_RANGE.loudest },
    { key: "execution_policy_version", label: "Execution policy version", valueType: "integer", defaultValue: checked.executionPolicyVersion, unit: null, minimum: 1, maximum: PERSONA_EXECUTION_POLICY_VERSION },
    { key: "background_sound_id", label: "Background sound", valueType: "string", defaultValue: checked.backgroundSoundId, unit: null, minimum: null, maximum: null },
    { key: "background_volume", label: "Background volume", valueType: "number", defaultValue: checked.backgroundVolume, unit: "linear_gain", minimum: BACKGROUND_VOLUME_RANGE.quietest, maximum: BACKGROUND_VOLUME_RANGE.loudest },
    { key: "interruption_level", label: "Interruption level", valueType: "string", defaultValue: checked.interruptionLevel, unit: null, minimum: null, maximum: null },
    { key: "speech_speed", label: "Speech speed", valueType: "string", defaultValue: checked.speechSpeed, unit: null, minimum: null, maximum: null },
  ];
}

/** The exact pre-categorical sixteen-field contract. Never add fields here. */
export function preCategoricalPersonaParameterContract(
  models: PersonaModels = RECOMMENDED_PERSONA_MODELS,
  controls: Omit<PersonaControls, "speechSpeed" | "interruptionLevel"> & { readonly interruptionLevel: "off" | "occasional" | "frequent" } = { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT, interruptionLevel: "off" },
): readonly GraderParameter[] {
  return [
    ...ticket02PersonaParameterContract(models, controls),
    { key: "interruption_level", label: "Interruption level", valueType: "string", defaultValue: controls.interruptionLevel, unit: null, minimum: null, maximum: null },
  ];
}

export const PERSONA_PARAMETER_CONTRACT = personaParameterContract();
const LEGACY_PERSONA_PARAMETER_CONTRACT = legacyPersonaParameterContract();
const TICKET_01_PERSONA_PARAMETER_CONTRACT = ticket01PersonaParameterContract();
const TICKET_02_PERSONA_PARAMETER_CONTRACT = ticket02PersonaParameterContract();
const PRE_CATEGORICAL_PERSONA_PARAMETER_CONTRACT = preCategoricalPersonaParameterContract();

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
  const isTicket02 = declares(TICKET_02_PERSONA_PARAMETER_CONTRACT);
  const isPreCategorical = declares(PRE_CATEGORICAL_PERSONA_PARAMETER_CONTRACT);
  const defaults = defaultGraderParameterValues(contract);
  const isCurrent = defaults.speech_mode === "separate" || defaults.speech_mode === "live";
  if (!isLegacy && !isTicket01 && !isTicket02 && !isPreCategorical && !isCurrent) throw new TypeError("persona parameter contract must declare one complete supported settings version");
  const modelKeys = isCurrent && defaults.speech_mode === "live" ? ["llm_provider", "llm_model", "live_provider", "live_model", "live_adapter", "live_voice_id"] as const : ["llm_provider", "llm_model", "stt_provider", "stt_model", "tts_provider", "tts_model", "tts_voice_id"] as const;
  for (const key of modelKeys) {
    if (typeof defaults[key] !== "string" || defaults[key].trim() === "") {
      throw new TypeError(`persona parameter ${key} must default to nonempty text`);
    }
  }
  if (isTicket01) validPersonaControls({ language: defaults.language, emotion: defaults.emotion, accent: defaults.accent, speechVolume: defaults.speech_volume, executionPolicyVersion: defaults.execution_policy_version, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT, interruptionLevel: "none", speechSpeed: personaSpeechSpeedOfTarget(Number(defaults.tts_speed)) });
  if (isTicket02) validPersonaControls({ language: defaults.language, emotion: defaults.emotion, accent: defaults.accent, speechVolume: defaults.speech_volume, executionPolicyVersion: defaults.execution_policy_version, backgroundSoundId: defaults.background_sound_id, backgroundVolume: defaults.background_volume, interruptionLevel: "none", speechSpeed: personaSpeechSpeedOfTarget(Number(defaults.tts_speed)) });
  if (isPreCategorical && !["off", "occasional", "frequent"].includes(String(defaults.interruption_level))) throw new TypeError("historical persona interruption level is not supported");
  if (isCurrent) { personaModelsOfParameters(defaults); personaControlsOfParameters(defaults); }
  return contract;
}

export function validatePersonaParameterValues(contract: unknown, values: unknown): PersonaParameterValues {
  const checkedContract = validatePersonaParameterContract(contract);
  const checked = validateGraderParameterValues(checkedContract, values);
  const modelKeys = checked.speech_mode === "live" ? ["llm_provider", "llm_model", "live_provider", "live_model", "live_adapter", "live_voice_id"] as const : ["llm_provider", "llm_model", "stt_provider", "stt_model", "tts_provider", "tts_model", "tts_voice_id"] as const;
  for (const key of modelKeys) {
    if (typeof checked[key] !== "string" || checked[key].trim() === "") {
      throw new TypeError(`persona parameter ${key} must be nonempty text`);
    }
  }
  if (checkedContract.some((field) => field.key === "speech_speed")) { personaModelsOfParameters(checked); personaControlsOfParameters(checked); }
  else if (checkedContract.some((field) => field.key === "interruption_level")) {
    if (!["off", "occasional", "frequent"].includes(String(checked.interruption_level))) throw new TypeError("historical persona interruption level is not supported");
  } else if (checkedContract.some((field) => field.key === "background_sound_id")) validPersonaControls({ language: checked.language, emotion: checked.emotion, accent: checked.accent, speechVolume: checked.speech_volume, executionPolicyVersion: checked.execution_policy_version, backgroundSoundId: checked.background_sound_id, backgroundVolume: checked.background_volume, interruptionLevel: "none", speechSpeed: personaSpeechSpeedOfTarget(Number(checked.tts_speed)) });
  else if (checkedContract.some((field) => field.key === "language")) validPersonaControls({ language: checked.language, emotion: checked.emotion, accent: checked.accent, speechVolume: checked.speech_volume, executionPolicyVersion: checked.execution_policy_version, backgroundSoundId: "none", backgroundVolume: BACKGROUND_VOLUME_DEFAULT, interruptionLevel: "none", speechSpeed: personaSpeechSpeedOfTarget(Number(checked.tts_speed)) });
  return checked;
}

export function defaultPersonaParameterValues(contract: unknown): PersonaParameterValues {
  const checked = validatePersonaParameterContract(contract);
  return validatePersonaParameterValues(checked, defaultGraderParameterValues(checked));
}
