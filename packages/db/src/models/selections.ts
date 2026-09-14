import { UnprocessableInputError } from "../access/errors.ts";
import {
  PROVIDERS_BY_JOB,
  RECOMMENDED_ENTRY,
  catalogEntry,
  type ModelJob,
  type ModelProvider,
} from "./catalog.ts";

export type ModelSelection = {
  readonly provider: ModelProvider;
  readonly model: string;
};

export type LlmSelection = ModelSelection;

export type SpeechSelection = ModelSelection & {
  readonly voiceId: string;
  readonly speed: number;
};

export type LiveSelection = ModelSelection & {
  readonly adapter: "openai_live";
  readonly voiceId: string;
};

/** The complete executable model choice owned by one persona version. */
export type SeparatePersonaModels = {
  readonly mode: "separate";
  readonly llm: LlmSelection;
  readonly stt: ModelSelection;
  readonly tts: SpeechSelection;
};

export type LivePersonaModels = {
  readonly mode: "live";
  readonly llm: LlmSelection;
  readonly live: LiveSelection;
};

export type PersonaModels = SeparatePersonaModels | LivePersonaModels;

export type GraderModel = ModelSelection;

export const SPEED_RANGE = { slowest: 0.6, fastest: 1.5 } as const;
/** Broad structural bounds; provider capability validation applies narrower ranges. */
export const PERSONA_AUTHORING_SPEED_RANGE = { slowest: 0.25, fastest: 4 } as const;

function validSelection(
  job: ModelJob,
  value: unknown,
  accepted: readonly string[] = ["provider", "model"],
): ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError(`the ${job} selection must be an object`);
  }
  const unsupported = Object.keys(value).filter(
    (key) => !accepted.includes(key),
  );
  if (unsupported.length > 0) {
    throw new UnprocessableInputError(
      `the ${job} selection has unsupported fields ${unsupported.join(", ")}`,
    );
  }
  const { provider, model } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw new UnprocessableInputError(
      `the ${job} selection needs a provider and model`,
    );
  }
  const entry = catalogEntry(job, provider, model.trim());
  if (entry === undefined) {
    const supported = PROVIDERS_BY_JOB[job]
      .map((known) => `${known.provider}/${known.model}`)
      .join(", ");
    throw new UnprocessableInputError(
      `"${provider}/${model}" is not a supported ${provider} ${job} model; expected one of ${supported}`,
    );
  }
  return { provider: entry.provider, model: entry.model };
}

function validSpeech(value: unknown): SpeechSelection {
  const selection = validSelection("tts", value, [
    "provider",
    "model",
    "voiceId",
    "speed",
  ]);
  const { voiceId, speed } = value as Record<string, unknown>;
  if (typeof voiceId !== "string" || voiceId.trim() === "") {
    throw new UnprocessableInputError(
      "the tts selection needs a voice id from its provider",
    );
  }
  if (
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed < PERSONA_AUTHORING_SPEED_RANGE.slowest ||
    speed > PERSONA_AUTHORING_SPEED_RANGE.fastest
  ) {
    throw new UnprocessableInputError(
      `speaking speed must be between ${PERSONA_AUTHORING_SPEED_RANGE.slowest} and ${PERSONA_AUTHORING_SPEED_RANGE.fastest}`,
    );
  }
  return { ...selection, voiceId: voiceId.trim(), speed };
}

function validLive(value: unknown): LiveSelection {
  const selection = validSelection("live", value, ["provider", "model", "adapter", "voiceId"]);
  const { adapter, voiceId } = value as Record<string, unknown>;
  const entry = catalogEntry("live", selection.provider, selection.model);
  if (adapter !== entry?.adapter) throw new UnprocessableInputError("the live selection needs its catalog adapter");
  if (typeof voiceId !== "string" || voiceId.trim() === "") throw new UnprocessableInputError("the live selection needs a built-in voice id");
  return { ...selection, adapter: "openai_live", voiceId: voiceId.trim() };
}

export function validPersonaModels(value: unknown): PersonaModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError("persona models must be an object");
  }
  const held = value as Record<string, unknown>;
  const mode = held.mode;
  if (mode !== "separate" && mode !== "live") throw new UnprocessableInputError("persona models need mode separate or live");
  const accepted = mode === "live" ? ["mode", "llm", "live"] : ["mode", "llm", "stt", "tts"];
  const unsupported = Object.keys(held).filter((key) => !accepted.includes(key));
  if (unsupported.length > 0) {
    throw new UnprocessableInputError(
      `persona models have unsupported fields ${unsupported.join(", ")}`,
    );
  }
  if (mode === "live") return {
    mode,
    llm: validSelection("llm", held.llm),
    live: validLive(held.live),
  };
  return {
    mode,
    llm: validSelection("llm", held.llm),
    stt: validSelection("stt", held.stt),
    tts: validSpeech(held.tts),
  };
}

export function validGraderModel(value: unknown): GraderModel {
  const selection = validSelection("llm", value);
  const entry = catalogEntry("llm", selection.provider, selection.model);
  if (entry?.graderEligible !== true) {
    throw new UnprocessableInputError(
      `${selection.model} is not a supported grader model`,
    );
  }
  return selection;
}

function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function samePersonaModels(a: PersonaModels, b: PersonaModels): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "live" && b.mode === "live") return sameSelection(a.llm, b.llm) && sameSelection(a.live, b.live) && a.live.adapter === b.live.adapter && a.live.voiceId === b.live.voiceId;
  if (a.mode === "live" || b.mode === "live") return false;
  return (
    sameSelection(a.llm, b.llm) &&
    sameSelection(a.stt, b.stt) &&
    sameSelection(a.tts, b.tts) &&
    a.tts.voiceId === b.tts.voiceId &&
    a.tts.speed === b.tts.speed
  );
}

export function sameGraderModel(a: GraderModel, b: GraderModel): boolean {
  return sameSelection(a, b);
}

/** Read required immutable persona models. Missing or invalid data is corrupt. */
export function personaModelsFromRow(
  value: unknown,
  versionId: string,
): PersonaModels {
  try {
    return validPersonaModels(value);
  } catch {
    throw new Error(
      `version ${versionId} holds persona models in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );
  }
}

export function graderModelFromRow(
  value: unknown,
  versionId: string,
): GraderModel {
  try {
    return validGraderModel(value);
  } catch {
    throw new Error(
      `version ${versionId} holds a grader model in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );
  }
}

function recommendedSelection(job: ModelJob): ModelSelection {
  const entry = RECOMMENDED_ENTRY[job];
  return { provider: entry.provider, model: entry.model };
}

function recommendedSpeech(): SpeechSelection {
  const entry = RECOMMENDED_ENTRY.tts;
  if (
    entry.recommendedVoiceId === undefined ||
    entry.recommendedSpeed === undefined ||
    entry.recommendedSpeed < SPEED_RANGE.slowest ||
    entry.recommendedSpeed > SPEED_RANGE.fastest
  ) {
    throw new Error(
      "the recommended TTS catalog entry needs a voice and an in-range speed",
    );
  }
  return {
    provider: entry.provider,
    model: entry.model,
    voiceId: entry.recommendedVoiceId,
    speed: entry.recommendedSpeed,
  };
}

export const RECOMMENDED_PERSONA_MODELS: SeparatePersonaModels = {
  mode: "separate",
  llm: recommendedSelection("llm"),
  stt: recommendedSelection("stt"),
  tts: recommendedSpeech(),
};

function recommendedGraderModel(): GraderModel {
  const defaults = PROVIDERS_BY_JOB.llm.filter(
    (candidate) => candidate.graderDefault === true,
  );
  if (defaults.length !== 1) {
    throw new Error(
      `the provider catalog must ship exactly one default grader LLM; found ${defaults.length}`,
    );
  }
  const entry = defaults[0];
  if (entry === undefined || entry.graderEligible !== true) {
    throw new Error("the default grader LLM must also be grader-eligible");
  }
  return { provider: entry.provider, model: entry.model };
}

export const RECOMMENDED_GRADER_MODEL: GraderModel =
  recommendedGraderModel();

/**
 * The providers one conversation needs a key for, in catalog words.
 *
 * **The same rule the claim's model block already follows, said once.** A
 * voice conversation runs three legs — the persona's LLM, the speech-to-text
 * that hears the agent (the realtime transcription among them) and the
 * text-to-speech that speaks — and a chat conversation runs only the LLM, so
 * only the LLM's key crosses the claim door for one. Whoever asks whether
 * Egma's key may fund this work has to ask about exactly the providers whose
 * keys it is about to hand over, and a second list of them would be a second
 * answer.
 *
 * De-duplicated and in one order, so two callers asking the same question ask
 * it with the same list — one provider serving two legs is one provider.
 */
export function providersNeededBy(
  models: PersonaModels,
  modality: "chat" | "voice",
): readonly string[] {
  const needed =
    modality === "chat"
      ? [models.llm.provider]
      : models.mode === "live"
        ? [models.llm.provider, models.live.provider]
        : [models.llm.provider, models.stt.provider, models.tts.provider];
  return [...new Set(needed)];
}
