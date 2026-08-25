import type {
  GetPersonaFormResponse,
  GetPersonaResponse,
  GetPersonaUsageResponse,
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

/**
 * The active tests that name this persona, as `/v1/personas/{id}/usage`
 * answers them.
 *
 * **It is read once, when a sheet or the archive confirmation opens, and never
 * per row.** A list of forty personas would be forty more requests for a
 * column nobody reads down; the two places it genuinely decides something are
 * the sheet's `USED BY` and the archive confirmation, which has to say which
 * tests would be left naming somebody who is no longer in the list.
 */
export type PersonaUsage = GetPersonaUsageResponse;

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
  readonly accent: string;
  readonly backgroundNoise: string;
};

/** What a persona egma has not been told anything about starts as. */
export const BLANK_TRAITS: TraitsDraft = {
  personality: "",
  language: "en-US",
  accent: "",
  backgroundNoise: "",
};

/** The stored traits, as the editor holds them. */
export function draftOf(traits: PersonaTraits): TraitsDraft {
  return {
    personality: traits.personality,
    language: traits.language,
    accent: traits.accent ?? "",
    backgroundNoise: traits.backgroundNoise ?? "",
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
    { label: "Accent", value: traits.accent },
    { label: "Background noise", value: traits.backgroundNoise },
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
 * What a person calls a provider, as against what a persona stores.
 *
 * A persona stores `openai`; the server's catalog is where `OpenAI` is
 * written, and the boards read the sheet's models back with the catalog's own
 * label. The provider is the fallback rather than an error: the catalog is a
 * second read that may not have answered yet, and a persona can name a
 * provider the deployment has since stopped offering. Neither is a reason to
 * show nothing.
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

/** The persona's type, in the two words the product uses for it. */
export function ownerSaid(owner: Persona["owner"]): string {
  return owner === "egma" ? "Egma-provided" : "Custom";
}
