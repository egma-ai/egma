import { UnprocessableInputError } from "../access/errors.ts";
import {
  PROVIDERS_BY_JOB,
  catalogEntry,
  type ModelJob,
  type ModelProvider,
} from "./catalog.ts";

export type ModelSelection = {
  readonly provider: ModelProvider;
  readonly model: string;
};

export type SpeechSelection = ModelSelection & {
  readonly voiceId: string;
  readonly speed: number;
};

/** The complete executable model choice owned by one persona version. */
export type PersonaModels = {
  readonly llm: ModelSelection;
  readonly stt: ModelSelection;
  readonly tts: SpeechSelection;
};

export type GraderModel = ModelSelection;

export const SPEED_RANGE = { slowest: 0.6, fastest: 1.5 } as const;

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
    speed < SPEED_RANGE.slowest ||
    speed > SPEED_RANGE.fastest
  ) {
    throw new UnprocessableInputError(
      `speaking speed must be between ${SPEED_RANGE.slowest} and ${SPEED_RANGE.fastest}`,
    );
  }
  return { ...selection, voiceId: voiceId.trim(), speed };
}

export function validPersonaModels(value: unknown): PersonaModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError("persona models must be an object");
  }
  const held = value as Record<string, unknown>;
  const unsupported = Object.keys(held).filter(
    (key) => !["llm", "stt", "tts"].includes(key),
  );
  if (unsupported.length > 0) {
    throw new UnprocessableInputError(
      `persona models have unsupported fields ${unsupported.join(", ")}`,
    );
  }
  return {
    llm: validSelection("llm", held.llm),
    stt: validSelection("stt", held.stt),
    tts: validSpeech(held.tts),
  };
}

export function validGraderModel(value: unknown): GraderModel {
  return validSelection("llm", value);
}

function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function samePersonaModels(a: PersonaModels, b: PersonaModels): boolean {
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

export const RECOMMENDED_PERSONA_MODELS: PersonaModels = {
  llm: { provider: "openai", model: "gpt-4o-mini" },
  stt: { provider: "openai", model: "gpt-live-transcribe" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
};

export const RECOMMENDED_GRADER_MODEL: GraderModel = {
  provider: "openai",
  model: "gpt-4o-mini",
};
