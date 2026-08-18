/**
 * The personas of one project, as `/api/personas` answers them.
 *
 * A **persona** is the synthetic person who calls the agent: manner, patience,
 * accent, speech rate, background noise, and what they do when things go
 * wrong. They belong to the project rather than to an agent or to a test,
 * which is why they have a page of their own and why every read here names a
 * project.
 *
 * **Nothing in a persona says what the caller wants.** That is the test's
 * scenario. The whole worth of a persona is that one of them calls about forty
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
  readonly voice: {
    readonly provider: string;
    readonly voiceId: string;
    /** Speech rate, as a multiple of the provider's natural pace. */
    readonly speed: number;
  };
  readonly manner?: string;
  readonly patience?: string;
  readonly accent?: string;
  readonly backgroundNoise?: string;
  readonly underFriction?: string;
};

export type Persona = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own id — what a traits write is written against. */
  readonly version_id: string;
  readonly traits: PersonaTraits;
  /** The current version's model selections, or null on the compatibility path. */
  readonly models: PersonaModels | null;
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
  readonly models: PersonaModels | null;
  readonly created_at: string;
};

export type PersonaVersionPage = {
  readonly items: readonly PersonaVersion[];
  readonly next_cursor: string | null;
};

export const PERSONAS_PATH = "/api/personas";

/** Where the persona form's server-owned metadata comes from. */
export const PERSONA_FORM_PATH = "/api/persona-form";

/**
 * What the persona form is allowed to offer, as the server says it.
 *
 * **The browser keeps no copy of this.** Which voices egma can ask for is the
 * server's list and it grows one entry at a time; a second copy here would be
 * wrong the day it grows, and wrong silently — the form would go on offering
 * yesterday's providers, and the new one would be unreachable from the only
 * place a persona is authored.
 */
export type PersonaForm = {
  readonly voice_providers: readonly string[];
  /**
   * The providers that do each model job, and the model a release proved for
   * each — the same catalog Model providers draws itself from, served here so
   * the persona editor renders from one call rather than two.
   *
   * **The browser keeps no copy**, for the reason the voice providers above
   * are read rather than listed: a second copy is wrong the day the catalog
   * grows, and wrong silently.
   */
  readonly model_catalog: readonly {
    readonly provider: string;
    readonly job: "llm" | "stt" | "tts";
    readonly label: string;
    readonly recommended_model: string;
    readonly recommended_voice_id?: string;
    readonly model_is_free_text: boolean;
  }[];
  /** What a persona that has chosen nothing starts from. */
  readonly recommended_models: {
    readonly llm: { readonly provider: string; readonly model: string };
    readonly stt: { readonly provider: string; readonly model: string };
    readonly tts: {
      readonly provider: string;
      readonly model: string;
      readonly voiceId: string;
      readonly speed: number;
    };
  };
  /** How far from natural pace speech stays intelligible, as the server bounds it. */
  readonly speed_range: { readonly slowest: number; readonly fastest: number };
};

/**
 * What a persona thinks, listens and speaks with — or `null` for one still on
 * the compatibility path, where the deployment's own settings decide.
 *
 * `null` is an ordinary state and never a fault: it is every persona authored
 * before the model catalog existed, and a page says so plainly rather than
 * showing a half-filled form as though somebody had chosen.
 */
export type PersonaModels = {
  readonly llm: { readonly provider: string; readonly model: string };
  readonly stt: { readonly provider: string; readonly model: string };
  readonly tts: {
    readonly provider: string;
    readonly model: string;
    readonly voiceId: string;
    readonly speed: number;
  };
};

/**
 * The providers a Select may show: the ones the server offers, plus whatever
 * this persona is already on.
 *
 * A persona authored against a provider that has since left the list still has
 * to be readable and still has to be editable in every other respect — so the
 * value in hand is always among the options, and dropping it silently would
 * change somebody's voice the first time they saved a typo in their accent.
 */
export function providerOptions(
  offered: readonly string[] | null,
  held: string,
): readonly string[] {
  const known = offered ?? [];
  return known.includes(held) || held === "" ? known : [...known, held];
}

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

export function personaVersionsPath(personaId: string): string {
  return `${PERSONAS_PATH}/${personaId}/versions`;
}

/**
 * The traits an editor is holding, before anybody decides whether they differ
 * from what is stored.
 *
 * Speech rate is text here and a number on the wire. What somebody has typed
 * into a field is a string, including the half-typed `1.` in the middle of
 * typing `1.25`, and coercing on every keystroke is what makes a field fight
 * back while it is being used.
 */
export type TraitsDraft = {
  readonly personality: string;
  readonly language: string;
  readonly provider: string;
  readonly voiceId: string;
  readonly speed: string;
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
  provider: "elevenlabs",
  voiceId: "",
  speed: "1",
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
    provider: traits.voice.provider,
    voiceId: traits.voice.voiceId,
    speed: String(traits.voice.speed),
    manner: traits.manner ?? "",
    patience: traits.patience ?? "",
    accent: traits.accent ?? "",
    backgroundNoise: traits.backgroundNoise ?? "",
    underFriction: traits.underFriction ?? "",
  };
}

/**
 * The draft, as the wire carries it.
 *
 * A speech rate that is not a number at all is sent as `NaN`'s honest
 * equivalent — the raw text — and the server answers with the range it
 * accepts. This page does not hold a second copy of that rule: a validator
 * here that disagreed with the one that decides would refuse something egma
 * would have taken, or take something egma will refuse.
 */
export function traitsFrom(draft: TraitsDraft): Record<string, unknown> {
  const speed = Number(draft.speed);
  return {
    personality: draft.personality,
    language: draft.language,
    voice: {
      provider: draft.provider,
      voiceId: draft.voiceId,
      speed: Number.isNaN(speed) ? draft.speed : speed,
    },
    manner: draft.manner,
    patience: draft.patience,
    accent: draft.accent,
    backgroundNoise: draft.backgroundNoise,
    underFriction: draft.underFriction,
  };
}

/**
 * The traits as a reader sees them: the described ones somebody actually
 * filled in, in the order the domain names them, and nothing for the rest.
 *
 * An unstated trait is left out rather than shown as a dash. "Nothing was said
 * about background noise" and "there is no background noise" are different
 * claims, and only the first one is true.
 */
export function describedTraits(
  traits: PersonaTraits,
): readonly { readonly label: string; readonly value: string }[] {
  const stated: { label: string; value: string | undefined }[] = [
    { label: "Manner", value: traits.manner },
    { label: "Patience", value: traits.patience },
    { label: "Accent", value: traits.accent },
    { label: "Background noise", value: traits.backgroundNoise },
    { label: "Under friction", value: traits.underFriction },
  ];
  return stated.flatMap((one) =>
    one.value === undefined || one.value.trim() === ""
      ? []
      : [{ label: one.label, value: one.value }],
  );
}

/**
 * The model selections an editor is holding, before anybody decides whether
 * they differ from what is stored.
 *
 * Speed is text here and a number on the wire, for the reason speech rate
 * already is: what somebody has typed is a string, including the half-typed
 * `1.` in the middle of typing `1.25`, and coercing on every keystroke is what
 * makes a field fight back while it is being used.
 *
 * **There is no key here and there is nowhere to put one.** Who pays for a
 * model is the organization's model access; a persona names a provider and
 * never a secret.
 */
export type ModelsDraft = {
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly ttsVoiceId: string;
  readonly ttsSpeed: string;
};

/** The stored selections, as the editor holds them. */
export function modelsDraftOf(models: PersonaModels): ModelsDraft {
  return {
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: models.stt.provider,
    sttModel: models.stt.model,
    ttsProvider: models.tts.provider,
    ttsModel: models.tts.model,
    ttsVoiceId: models.tts.voiceId,
    ttsSpeed: String(models.tts.speed),
  };
}

/**
 * What a persona that has chosen nothing starts from: the release's proved
 * defaults, read off the server rather than written here.
 *
 * `null` while the form read has not answered, because a draft made of guessed
 * providers is a form that offers a choice Egma may not ship.
 */
export function recommendedDraft(form: PersonaForm | undefined): ModelsDraft | null {
  const recommended = form?.recommended_models;
  if (recommended === undefined) return null;
  return modelsDraftOf(recommended);
}

/**
 * The draft, as the wire carries it.
 *
 * A speed that is not a number at all is sent as the raw text and the server
 * answers with the range it accepts. This page holds no second copy of that
 * rule: a validator here that disagreed with the one that decides would refuse
 * something Egma would have taken, or take something Egma will refuse.
 */
export function modelsFrom(draft: ModelsDraft): Record<string, unknown> {
  const speed = Number(draft.ttsSpeed);
  return {
    llm: { provider: draft.llmProvider, model: draft.llmModel },
    stt: { provider: draft.sttProvider, model: draft.sttModel },
    tts: {
      provider: draft.ttsProvider,
      model: draft.ttsModel,
      voiceId: draft.ttsVoiceId,
      speed: Number.isNaN(speed) ? draft.ttsSpeed : speed,
    },
  };
}

/** Whether two drafts say the same thing, field by field. */
export function sameModelsDraft(a: ModelsDraft, b: ModelsDraft): boolean {
  return (
    a.llmProvider === b.llmProvider &&
    a.llmModel === b.llmModel &&
    a.sttProvider === b.sttProvider &&
    a.sttModel === b.sttModel &&
    a.ttsProvider === b.ttsProvider &&
    a.ttsModel === b.ttsModel &&
    a.ttsVoiceId === b.ttsVoiceId &&
    a.ttsSpeed === b.ttsSpeed
  );
}
