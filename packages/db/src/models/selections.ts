import { UnprocessableInputError } from "../access/errors.ts";
import {
  PROVIDERS_BY_JOB,
  RECOMMENDED_ENTRY,
  type ModelJob,
  type ModelProvider,
} from "./catalog.ts";

/**
 * What a persona version and a grader version say about models — and what
 * neither of them says about credentials.
 *
 * **A selection names a provider and a model, and can never name a secret.**
 * There is no field here through which a key could travel, which is what makes
 * "an authored object never holds a credential" a property of the type rather
 * than a rule each writer keeps. Who pays for the call is the organization's
 * model access, resolved when a claim is prepared, and it is deliberately not
 * part of what an author writes down: rotating a credential must not mint a
 * persona version, and it cannot, because the credential is not in here.
 *
 * **These are versioned content.** Editing any field mints the next persona or
 * grader version, so a run that pinned last week's version keeps meaning what
 * it meant. That is the whole reason the selections live on the version row
 * rather than on the live one.
 */

/** One provider and one model ID, for an `llm` or `stt` job. */
export type ModelSelection = {
  readonly provider: ModelProvider;
  /** As the provider spells it. Free text, never allowlisted by Egma. */
  readonly model: string;
};

/**
 * The speaking job, which needs two more facts than the others: which of the
 * provider's voices, and how fast the persona talks.
 *
 * Speech rate is a number rather than a description, for the reason the
 * persona's concrete voice already is one: "quite fast" would have to be
 * interpreted, and two runs interpreting it differently is exactly the drift a
 * pinned version exists to rule out.
 */
export type SpeechSelection = ModelSelection & {
  readonly voiceId: string;
  /** Speech rate, as a multiple of the provider's natural pace. */
  readonly speed: number;
};

/**
 * A persona's three independent selections.
 *
 * Independent on purpose (ADR-0010): changing what the persona listens with
 * must not require inventing a new bundle for what it thinks and speaks with.
 */
export type PersonaModels = {
  readonly llm: ModelSelection;
  readonly stt: ModelSelection;
  readonly tts: SpeechSelection;
};

/**
 * A grader version's own LLM selection.
 *
 * It inherits nothing: not a persona's LLM, which judges nothing, and not the
 * project's judge configuration, which is the legacy path and stays readable
 * only for work authored before this existed.
 */
export type GraderModel = ModelSelection;

/** Speech only stays intelligible so far from natural pace. */
export const SPEED_RANGE = { slowest: 0.5, fastest: 2 } as const;

/**
 * A provider from the catalog for this job, or the caller's mistake said out
 * loud with the providers that would have worked.
 *
 * `UnprocessableInputError` rather than a plain one because the sentence is
 * written for whoever has to fix the form, and the layer above has to be able
 * to tell that apart from Egma being broken.
 */
function validProvider(job: ModelJob, provider: string): ModelProvider {
  const entry = PROVIDERS_BY_JOB[job].find(
    (known) => known.provider === provider,
  );
  if (entry === undefined) {
    const shipped = PROVIDERS_BY_JOB[job].map((known) => known.provider);
    throw new UnprocessableInputError(
      `"${provider}" is not a ${job} provider Egma ships; expected one of ${shipped.join(", ")}`,
    );
  }
  return entry.provider;
}

function validModel(job: ModelJob, model: string): string {
  const trimmed = model.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError(`the ${job} selection needs a model id`);
  }
  return trimmed;
}

function validSelection(job: ModelJob, selection: ModelSelection): ModelSelection {
  return {
    provider: validProvider(job, selection.provider),
    model: validModel(job, selection.model),
  };
}

function validSpeech(selection: SpeechSelection): SpeechSelection {
  const { voiceId, speed } = selection;
  const trimmedVoice = voiceId.trim();
  if (trimmedVoice === "") {
    throw new UnprocessableInputError(
      "the tts selection needs a voice id from its provider",
    );
  }
  if (
    !Number.isFinite(speed) ||
    speed < SPEED_RANGE.slowest ||
    speed > SPEED_RANGE.fastest
  ) {
    throw new UnprocessableInputError(
      `speaking speed must be between ${SPEED_RANGE.slowest} and ${SPEED_RANGE.fastest}`,
    );
  }
  return {
    ...validSelection("tts", selection),
    voiceId: trimmedVoice,
    speed,
  };
}

/** The persona's three selections, checked and trimmed, ready to be stored. */
export function validPersonaModels(models: PersonaModels): PersonaModels {
  return {
    llm: validSelection("llm", models.llm),
    stt: validSelection("stt", models.stt),
    tts: validSpeech(models.tts),
  };
}

/** The grader's own LLM selection, checked and trimmed. */
export function validGraderModel(model: GraderModel): GraderModel {
  return validSelection("llm", model);
}

/**
 * Whether two selections say the same thing, decided field by field.
 *
 * A mapped type rather than a deep compare, so a field added to a selection
 * refuses to build until it is told how to be compared — a forgotten field
 * would call two different selections identical, and an edit somebody made
 * would vanish instead of minting a version.
 *
 * Two maps rather than one, because there are two shapes: everything a
 * selection has, and the two more a speaking one carries. One map over the
 * wider shape would have to be handed a narrower value at every call, which is
 * a cast — and a cast is exactly what stops the compiler from noticing a field
 * nobody taught it to compare.
 */
const sameBaseField: {
  readonly [K in keyof ModelSelection]: (
    a: ModelSelection,
    b: ModelSelection,
  ) => boolean;
} = {
  provider: (a, b) => a.provider === b.provider,
  model: (a, b) => a.model === b.model,
};

const sameSpeechField: {
  readonly [K in Exclude<keyof SpeechSelection, keyof ModelSelection>]: (
    a: SpeechSelection,
    b: SpeechSelection,
  ) => boolean;
} = {
  voiceId: (a, b) => a.voiceId === b.voiceId,
  speed: (a, b) => a.speed === b.speed,
};

function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return Object.values(sameBaseField).every((same) => same(a, b));
}

function sameSpeech(a: SpeechSelection, b: SpeechSelection): boolean {
  return (
    sameSelection(a, b) &&
    Object.values(sameSpeechField).every((same) => same(a, b))
  );
}

/** Byte-identical persona models, so a save that changed nothing mints nothing. */
export function samePersonaModels(
  a: PersonaModels | null,
  b: PersonaModels | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    sameSelection(a.llm, b.llm) &&
    sameSelection(a.stt, b.stt) &&
    sameSpeech(a.tts, b.tts)
  );
}

export function sameGraderModel(
  a: GraderModel | null,
  b: GraderModel | null,
): boolean {
  if (a === null || b === null) return a === b;
  return sameSelection(a, b);
}

/**
 * The stored jsonb read back as selections, or a fault naming the row.
 *
 * A column holding something Egma never writes is a broken row rather than a
 * caller's mistake, so it throws rather than answering — the same bargain the
 * persona's traits already make. `null` is the ordinary answer for a version
 * authored before persona models existed, and it is never a fault: it means
 * this version is on the compatibility path.
 */
export function personaModelsFromRow(
  value: unknown,
  versionId: string,
): PersonaModels | null {
  if (value === null || value === undefined) return null;
  const broken = (): never => {
    throw new Error(
      `version ${versionId} holds persona models in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );
  };
  if (typeof value !== "object" || Array.isArray(value)) return broken();
  const held = value as Record<string, unknown>;
  const llm = selectionFromRow(held.llm);
  const stt = selectionFromRow(held.stt);
  const tts = speechFromRow(held.tts);
  if (llm === undefined || stt === undefined || tts === undefined) {
    return broken();
  }
  return { llm, stt, tts };
}

export function graderModelFromRow(
  value: unknown,
  versionId: string,
): GraderModel | null {
  if (value === null || value === undefined) return null;
  const selection = selectionFromRow(value);
  if (selection === undefined) {
    throw new Error(
      `version ${versionId} holds a grader model in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );
  }
  return selection;
}

function selectionFromRow(value: unknown): ModelSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const held = value as Record<string, unknown>;
  const { provider, model } = held;
  if (typeof provider !== "string" || typeof model !== "string") {
    return undefined;
  }
  // The stored word came through `validProvider` on the way in, so what comes
  // back is one of the catalog's — read back as the closed type rather than
  // re-checked, exactly as a checked column is.
  return { provider: provider as ModelProvider, model };
}

function speechFromRow(value: unknown): SpeechSelection | undefined {
  const selection = selectionFromRow(value);
  if (selection === undefined) return undefined;
  const held = value as Record<string, unknown>;
  const { voiceId, speed } = held;
  if (typeof voiceId !== "string" || typeof speed !== "number") {
    return undefined;
  }
  return { ...selection, voiceId, speed };
}

/**
 * The selections a persona starts life with: this release's proved defaults, so
 * a new project's default persona runs before anybody opens its Models form.
 *
 * A value rather than a call, on the catalog's own terms — it is read off
 * release data and nothing about it can differ between two callers.
 */
export const RECOMMENDED_PERSONA_MODELS: PersonaModels = {
  llm: {
    provider: RECOMMENDED_ENTRY.llm.provider,
    model: RECOMMENDED_ENTRY.llm.recommendedModel,
  },
  stt: {
    provider: RECOMMENDED_ENTRY.stt.provider,
    model: RECOMMENDED_ENTRY.stt.recommendedModel,
  },
  tts: {
    provider: RECOMMENDED_ENTRY.tts.provider,
    model: RECOMMENDED_ENTRY.tts.recommendedModel,
    voiceId: recommendedVoice(),
    // The natural pace of the provider's voice: a persona that has said nothing
    // about how fast it talks talks the way the voice does.
    speed: 1,
  },
};

/** The selection a grader starts life with, on the same terms. */
export const RECOMMENDED_GRADER_MODEL: GraderModel = {
  provider: RECOMMENDED_ENTRY.llm.provider,
  model: RECOMMENDED_ENTRY.llm.recommendedModel,
};

function recommendedVoice(): string {
  const voiceId = RECOMMENDED_ENTRY.tts.recommendedVoiceId;
  if (voiceId === undefined) {
    throw new Error(
      "the catalog's tts entry ships no recommended voice, so a persona cannot start from it",
    );
  }
  return voiceId;
}
