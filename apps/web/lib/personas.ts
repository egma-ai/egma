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
 * supplies a Predefined persona to every project, and a project can author a
 * Custom persona or fork the shared one.
 *
 * **A persona carries two names, and they are two different things.** `name` is
 * the team's word for them — shown in lists, pickers and the sheet's head,
 * rewritten in place, never spoken. `identityName` is the human name they give
 * the agent, versioned exactly like their personality, so the same test hears
 * the same person on every run.
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

export type PersonaModels = Persona["models"];
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
export function behaviorDraftOf(stored: BehaviorDraft): BehaviorDraft {
  return {
    identityName: stored.identityName,
    personality: stored.personality,
    language: stored.language,
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
 * One engine choice, as one control.
 *
 * **A provider and a model are one decision, and the boards draw one control
 * for it.** The server's catalog is a list of pairs its adapters can actually
 * execute, so a single choice over those pairs cannot produce a combination
 * that does not exist — where two controls, one for the provider and one for
 * the model, have to be kept in step by hand and can disagree in between.
 *
 * The value is the pair, joined by a separator no provider or model id
 * contains, because an `<option>` carries one string.
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

/**
 * The persona's type, in the two words the product uses for it.
 *
 * **Predefined**, not "Egma-provided": personas and graders name an Egma-built
 * thing with one word, and Predefined is the word a customer arrives with.
 */
export function ownerSaid(owner: Persona["owner"]): string {
  return owner === "egma" ? "Predefined" : "Custom";
}
