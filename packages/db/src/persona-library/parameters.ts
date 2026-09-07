import {
  defaultGraderParameterValues,
  validateGraderParameterContract,
  validateGraderParameterValues,
  type GraderParameter,
  type GraderParameterValues,
} from "../grader-library/parameters.ts";
import { RECOMMENDED_PERSONA_MODELS, SPEED_RANGE, validPersonaModels, type PersonaModels } from "../models/selections.ts";

export type PersonaParameterValues = GraderParameterValues;

/** Complete project settings; a core contains their contract, never their values. */
export function personaParametersOfModels(models: PersonaModels): PersonaParameterValues {
  const checked = validPersonaModels(models);
  return {
    llm_provider: checked.llm.provider,
    llm_model: checked.llm.model,
    stt_provider: checked.stt.provider,
    stt_model: checked.stt.model,
    tts_provider: checked.tts.provider,
    tts_model: checked.tts.model,
    tts_voice_id: checked.tts.voiceId,
    tts_speed: checked.tts.speed,
  };
}

export function personaModelsOfParameters(values: PersonaParameterValues): PersonaModels {
  return validPersonaModels({
    llm: { provider: values.llm_provider, model: values.llm_model },
    stt: { provider: values.stt_provider, model: values.stt_model },
    tts: { provider: values.tts_provider, model: values.tts_model, voiceId: values.tts_voice_id, speed: values.tts_speed },
  });
}

export function personaParameterContract(models: PersonaModels = RECOMMENDED_PERSONA_MODELS): readonly GraderParameter[] {
  const defaults = personaParametersOfModels(models);
  const labels: Readonly<Record<string, string>> = {
    llm_provider: "Language model provider", llm_model: "Language model",
    stt_provider: "Speech recognition provider", stt_model: "Speech recognition model",
    tts_provider: "Speech generation provider", tts_model: "Speech generation model",
    tts_voice_id: "Voice ID", tts_speed: "Speaking speed",
  };
  return Object.entries(defaults).map(([key, value]) => ({
    key, label: labels[key] ?? key,
    valueType: key === "tts_speed" ? "number" : "string",
    defaultValue: value as string | number,
    unit: null,
    minimum: key === "tts_speed" ? SPEED_RANGE.slowest : null,
    maximum: key === "tts_speed" ? SPEED_RANGE.fastest : null,
  }));
}

export const PERSONA_PARAMETER_CONTRACT = personaParameterContract();

export function validatePersonaParameterContract(value: unknown): readonly GraderParameter[] {
  const contract = validateGraderParameterContract(value);
  const required = PERSONA_PARAMETER_CONTRACT;
  if (contract.length !== required.length || required.some((field) => !contract.some((candidate) => candidate.key === field.key && candidate.valueType === field.valueType))) {
    throw new TypeError("persona parameter contract must declare the supported model, voice and speed settings");
  }
  personaModelsOfParameters(defaultGraderParameterValues(contract));
  return contract;
}

export function validatePersonaParameterValues(contract: unknown, values: unknown): PersonaParameterValues {
  const checked = validateGraderParameterValues(validatePersonaParameterContract(contract), values);
  return personaParametersOfModels(personaModelsOfParameters(checked));
}

export function defaultPersonaParameterValues(contract: unknown): PersonaParameterValues {
  return validatePersonaParameterValues(contract, defaultGraderParameterValues(validatePersonaParameterContract(contract)));
}
