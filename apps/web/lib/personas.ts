import type {
  GetPersonaFormResponse,
  GetPersonaResponse,
  ListPersonasResponse,
  ListPersonaVersionsResponse,
} from "@egma/platform-api/client";

export type Persona = GetPersonaResponse;
export type PersonaModels = NonNullable<Persona["settings"]>["models"];
export type PersonaControls = NonNullable<Persona["settings"]>["controls"];
export type PersonaPage = ListPersonasResponse;
export type PersonaVersionPage = ListPersonaVersionsResponse;
export type PersonaVersion = PersonaVersionPage["versions"][number];
export type PersonaForm = GetPersonaFormResponse;
export type PersonaModelCatalogEntry = PersonaForm["modelCatalog"][number];

type CascadedModels = Extract<PersonaModels, { readonly mode: "separate" }>;
type LiveModels = Extract<PersonaModels, { readonly mode: "live" }>;
type CascadedControls = Extract<PersonaControls, { readonly interruptionLevel: unknown }>;

/** The one realtime speech model the API accepts; the contract names it, not the user. */
export const LIVE_MODEL = {
  provider: "openai",
  model: "gpt-live-1",
  adapter: "openai_live",
} as const satisfies Omit<LiveModels["live"], "voiceId">;

export type BehaviorDraft = {
  readonly identityName: string;
  readonly personality: string;
};

export const BLANK_BEHAVIOR: BehaviorDraft = {
  identityName: "",
  personality: "",
};

export type ModelsDraft = {
  readonly mode: PersonaModels["mode"];
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly separateVoiceId: string;
  readonly liveVoiceId: string;
  readonly language: string;
  readonly backgroundSoundId: PersonaControls["backgroundSoundId"];
  readonly interruptionLevel: CascadedControls["interruptionLevel"];
};

export const BACKGROUND_SOUNDS: ReadonlyArray<{
  readonly id: PersonaControls["backgroundSoundId"];
  readonly label: string;
}> = [
  { id: "none", label: "None" },
  { id: "office-v1", label: "Office" },
  { id: "cafe-v1", label: "Café" },
  { id: "street-traffic-v1", label: "Street traffic" },
  { id: "crowd-talking-v1", label: "Crowd talking" },
  { id: "inside-car-v1", label: "Inside a car" },
  { id: "home-tv-v1", label: "Home with TV" },
  { id: "wind-v1", label: "Wind" },
  { id: "rain-v1", label: "Rain" },
];

export function modelsDraftOf(
  models: PersonaModels,
  controls?: PersonaControls,
): ModelsDraft {
  const cascaded = models.mode === "separate" ? models : null;
  return {
    mode: models.mode,
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: cascaded?.stt.provider ?? "openai",
    sttModel: cascaded?.stt.model ?? "gpt-4o-mini-transcribe",
    ttsProvider: cascaded?.tts.provider ?? "openai",
    ttsModel: cascaded?.tts.model ?? "gpt-4o-mini-tts",
    separateVoiceId: cascaded?.tts.voiceId ?? "alloy",
    liveVoiceId: models.mode === "live" ? models.live.voiceId : "alloy",
    language: controls?.language ?? "en-US",
    backgroundSoundId: controls?.backgroundSoundId ?? "none",
    interruptionLevel:
      controls !== undefined && "interruptionLevel" in controls
        ? controls.interruptionLevel
        : "none",
  };
}

export function modelsFrom(draft: ModelsDraft): PersonaModels {
  if (draft.mode === "live") {
    return {
      mode: "live",
      llm: { provider: draft.llmProvider, model: draft.llmModel },
      live: { ...LIVE_MODEL, voiceId: draft.liveVoiceId },
    } satisfies LiveModels;
  }
  return {
    mode: "separate",
    llm: { provider: draft.llmProvider, model: draft.llmModel },
    stt: { provider: draft.sttProvider, model: draft.sttModel },
    tts: {
      provider: draft.ttsProvider,
      model: draft.ttsModel,
      voiceId: draft.separateVoiceId,
    },
  } satisfies CascadedModels;
}

export function controlsFrom(draft: ModelsDraft): PersonaControls {
  const shared = {
    language: draft.language,
    backgroundSoundId: draft.backgroundSoundId,
  };
  return draft.mode === "live"
    ? shared
    : { ...shared, interruptionLevel: draft.interruptionLevel };
}

/** Which part of the persona a catalog entry serves. */
export type CatalogJob = PersonaModelCatalogEntry["job"];

/** The catalog row for one job, provider and model, once the form has arrived. */
export function catalogEntry(
  catalog: readonly PersonaModelCatalogEntry[] | undefined,
  job: CatalogJob,
  provider: string,
  model: string,
): PersonaModelCatalogEntry | undefined {
  return catalog?.find(
    (one) => one.job === job && one.provider === provider && one.model === model,
  );
}

/** The provider as the catalog names it, or its raw id until the catalog says. */
export function providerSaid(
  catalog: readonly PersonaModelCatalogEntry[] | undefined,
  job: CatalogJob,
  provider: string,
  model: string,
): string {
  return catalogEntry(catalog, job, provider, model)?.label ?? provider;
}

/** The model as the catalog names it, or its raw id until the catalog says. */
export function modelSaid(
  catalog: readonly PersonaModelCatalogEntry[] | undefined,
  job: CatalogJob,
  provider: string,
  model: string,
): string {
  return catalogEntry(catalog, job, provider, model)?.modelLabel ?? model;
}

export function ownerSaid(owner: Persona["owner"]): string {
  return owner === "egma" ? "Built-in" : "Custom";
}

/** A language tag as a person reads it: `en-US` is `English (United States)`. */
export function languageLabel(value: string): string {
  try {
    const locale = new Intl.Locale(value);
    const languages = new Intl.DisplayNames(["en"], { type: "language" });
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const language = languages.of(locale.language) ?? locale.language;
    return locale.region === undefined
      ? language
      : `${language} (${regions.of(locale.region) ?? locale.region})`;
  } catch {
    return value;
  }
}

/** The interruption level as the boards print it. */
export function interruptionSaid(
  level: CascadedControls["interruptionLevel"],
): string {
  if (level === "none") return "None";
  if (level === "occasional") return "Occasional";
  return "Frequent";
}

/** The background sound as the boards print it. */
export function backgroundSaid(id: PersonaControls["backgroundSoundId"]): string {
  return BACKGROUND_SOUNDS.find((sound) => sound.id === id)?.label ?? id;
}

function valuesOf(persona: Persona): Record<string, number | string> {
  return Object.fromEntries(
    persona.parameterContract.map((field) => [field.key, field.defaultValue]),
  );
}

/** Read saved settings or the declared defaults of a built-in persona. */
export function modelsOfPersona(persona: Persona): PersonaModels {
  if (persona.settings !== null) return persona.settings.models;
  const values = valuesOf(persona);
  if (values.speech_mode === "live") {
    return {
      mode: "live",
      llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
      live: { ...LIVE_MODEL, voiceId: String(values.live_voice_id ?? "alloy") },
    };
  }
  return {
    mode: "separate",
    llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
    stt: { provider: String(values.stt_provider), model: String(values.stt_model) },
    tts: {
      provider: String(values.tts_provider),
      model: String(values.tts_model),
      voiceId: String(values.tts_voice_id ?? "alloy"),
    },
  };
}

/** Read saved controls or the declared defaults of a built-in persona. */
export function controlsOfPersona(persona: Persona): PersonaControls {
  if (persona.settings !== null) return persona.settings.controls;
  const values = valuesOf(persona);
  const shared = {
    language: String(values.language ?? persona.language ?? "en-US"),
    backgroundSoundId: (values.background_sound_id ?? "none") as PersonaControls["backgroundSoundId"],
  };
  return values.speech_mode === "live"
    ? shared
    : {
        ...shared,
        interruptionLevel: (values.interruption_level ?? "none") as CascadedControls["interruptionLevel"],
      };
}

export function personasPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/personas`;
}

export function newPersonaPath(projectId: string): string {
  return `${personasPath(projectId)}/new`;
}

export function personaPath(projectId: string, personaId: string): string {
  return `${personasPath(projectId)}/${encodeURIComponent(personaId)}`;
}

export function personaClonePath(projectId: string, personaId: string): string {
  return `${personaPath(projectId, personaId)}/clone`;
}
