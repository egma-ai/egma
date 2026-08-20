/**
 * The personas of one project, as `/api/personas` answers them.
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

export type PersonaTraits = {
  readonly personality: string;
  readonly language: string;
  readonly manner?: string;
  readonly patience?: string;
  readonly accent?: string;
  readonly backgroundNoise?: string;
  readonly underFriction?: string;
};

export type ModelSelection = {
  readonly provider: string;
  readonly model: string;
};

export type PersonaModels = {
  readonly llm: ModelSelection;
  readonly stt: ModelSelection;
  readonly tts: ModelSelection & {
    readonly voiceId: string;
    readonly speed: number;
  };
};

export type Persona = {
  readonly id: string;
  /** Null for an Egma-provided persona. */
  readonly project_id: string | null;
  /** Who owns the definition and therefore who may edit it. */
  readonly owner: "egma" | "organization";
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own id — what a traits write is written against. */
  readonly version_id: string;
  readonly traits: PersonaTraits;
  /** Complete, required, and owned by this immutable version. */
  readonly models: PersonaModels;
  /** The opaque token an identity write or a lifecycle change has to name. */
  readonly revision: string;
  readonly archived_at: string | null;
  /** Whether the project points at them when a test names nobody. */
  readonly is_default: boolean;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersonaPage = {
  readonly items: readonly Persona[];
  readonly next_cursor: string | null;
};

/** One frozen version, as history and the older-version read show it. */
export type PersonaVersion = {
  readonly id: string;
  readonly persona_id: string;
  readonly version: number;
  readonly traits: PersonaTraits;
  readonly models: PersonaModels;
  readonly created_at: string;
};

export type PersonaVersionPage = {
  readonly items: readonly PersonaVersion[];
  readonly next_cursor: string | null;
};

export const PERSONAS_PATH = "/api/personas";
export const PERSONA_FORM_PATH = "/api/persona-form";

export type PersonaModelCatalogEntry = ModelSelection & {
  readonly job: "llm" | "stt" | "tts";
  readonly label: string;
  readonly recommended_voice_id?: string;
};

/** The model choices and defaults exported by the server's adapter catalog. */
export type PersonaForm = {
  readonly model_catalog: readonly PersonaModelCatalogEntry[];
  readonly recommended_models: PersonaModels;
  readonly speed_range: { readonly slowest: number; readonly fastest: number };
};

/** One server-side search and one cursor page of a lifecycle state. */
export function personasQuery(options: {
  readonly archived?: boolean;
  readonly search?: string;
  readonly cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (options.archived === true) query.set("archived", "true");
  const wanted = options.search?.trim() ?? "";
  if (wanted !== "") query.set("search", wanted);
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const written = query.toString();
  return written === "" ? PERSONAS_PATH : `${PERSONAS_PATH}?${written}`;
}

/** The list of one lifecycle state. Two lists, never one with a column. */
export function personasPath(archived: boolean): string {
  return personasQuery({ archived });
}

/** The next page of the same list, carrying the same filter. */
export function personasAfter(cursor: string, archived: boolean): string {
  return personasQuery({ archived, cursor });
}

export function personaPath(personaId: string): string {
  return `${PERSONAS_PATH}/${personaId}`;
}

export function personaDefaultPath(personaId: string): string {
  return `${personaPath(personaId)}/default`;
}

export function personaVersionsPath(personaId: string): string {
  return `${PERSONAS_PATH}/${personaId}/versions`;
}

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
export function modelsFrom(draft: ModelsDraft): Record<string, unknown> {
  const speed = Number(draft.speed);
  return {
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
}

export function sameModelsDraft(
  left: ModelsDraft,
  right: ModelsDraft,
): boolean {
  return (Object.keys(left) as (keyof ModelsDraft)[]).every(
    (key) => left[key] === right[key],
  );
}
