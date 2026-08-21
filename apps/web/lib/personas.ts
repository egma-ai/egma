import type {
  GetPersonaFormResponse,
  GetPersonaResponse,
  ListPersonasResponse,
  ListPersonaVersionsResponse,
} from "@egma/platform-api/client";

/**
 * The personas of one project, as `/v1/personas` answers them.
 *
 * A **persona** is the synthetic person who speaks with the agent. Egma
 * supplies an Egma-provided persona to every project, and a project can author
 * a Custom persona or fork the shared one. Human traits say how the person
 * behaves; models say how the simulator brings that person to life.
 *
 * **Nothing in a persona says what that persona wants.** That is the test's
 * scenario. The whole worth of a persona is that one of them is used in forty
 * different situations, and a trait that said "asks to reschedule" would turn
 * a reusable person into a second copy of one test. The editor says so where
 * somebody is typing, and this file says so where somebody is reading.
 *
 * The shape is the API's own, field names included. Renaming its fields on the
 * way in would put a second vocabulary between the contract and the page, and
 * the two would drift the first time the API grew a field.
 */

export type Persona = GetPersonaResponse;
export type PersonaTraits = Persona["traits"];

export type PersonaModels = Persona["models"];
export type ModelSelection = PersonaModels["llm"];
export type PersonaPage = ListPersonasResponse;

/** One frozen version, as history and the older-version read show it. */
export type PersonaVersionPage = ListPersonaVersionsResponse;
export type PersonaVersion = PersonaVersionPage["versions"][number];

export type PersonaForm = GetPersonaFormResponse;
export type PersonaModelCatalogEntry = PersonaForm["modelCatalog"][number];

/** The model choices and defaults exported by the server's adapter catalog. */
/**
 * The versioned field an editor is holding, before anybody decides whether it
 * differs from what is stored.
 */
export type TraitsDraft = {
  readonly personality: string;
  readonly language: string;
  readonly manner: string;
  readonly patience: string;
  readonly accent: string;
  readonly backgroundNoise: string;
  readonly underFriction: string;
};

/** What a persona egma has not been told anything about starts as. */
export const BLANK_TRAITS: TraitsDraft = {
  personality: "",
  language: "en-US",
  manner: "",
  patience: "",
  accent: "",
  backgroundNoise: "",
  underFriction: "",
};

/** The stored traits, as the editor holds them. */
export function draftOf(traits: PersonaTraits): TraitsDraft {
  return {
    personality: traits.personality,
    language: traits.language,
    manner: traits.manner ?? "",
    patience: traits.patience ?? "",
    accent: traits.accent ?? "",
    backgroundNoise: traits.backgroundNoise ?? "",
    underFriction: traits.underFriction ?? "",
  };
}

/** The human-traits draft, in the exact shape the API accepts. */
export function traitsFrom(draft: TraitsDraft): PersonaTraits {
  return { ...draft };
}

export function sameTraitsDraft(
  left: TraitsDraft,
  right: TraitsDraft,
): boolean {
  return (Object.keys(left) as (keyof TraitsDraft)[]).every(
    (key) => left[key] === right[key],
  );
}

/** Human traits in the order a read-only persona view shows them. */
export function describedTraits(
  traits: PersonaTraits,
): readonly { readonly label: string; readonly value: string }[] {
  const required = [
    { label: "Personality", value: traits.personality },
    { label: "Language", value: traits.language },
  ];
  const optional: readonly {
    readonly label: string;
    readonly value: string | undefined;
  }[] = [
    { label: "Manner", value: traits.manner },
    { label: "Patience", value: traits.patience },
    { label: "Accent", value: traits.accent },
    { label: "Background noise", value: traits.backgroundNoise },
    { label: "Under friction", value: traits.underFriction },
  ];
  return [
    ...required,
    ...optional.flatMap((one) =>
      one.value === undefined || one.value.trim() === ""
        ? []
        : [{ label: one.label, value: one.value }],
    ),
  ];
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
};

export function modelsDraftOf(models: PersonaModels): ModelsDraft {
  return {
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: models.stt.provider,
    sttModel: models.stt.model,
    ttsProvider: models.tts.provider,
    ttsModel: models.tts.model,
    voiceId: models.tts.voiceId,
    speed: String(models.tts.speed),
  };
}

/** One complete models value, in the exact shape the API validates. */
export function modelsFrom(draft: ModelsDraft): PersonaModels {
  const speed = Number(draft.speed);
  const models = {
    llm: { provider: draft.llmProvider, model: draft.llmModel },
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
